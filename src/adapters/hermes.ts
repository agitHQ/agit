/**
 * Adapter for Hermes Agent's session database (#64): NousResearch/hermes-agent
 * keeps every session's transcript in one SQLite file, `state.db`, under the
 * Hermes home — `$HERMES_HOME`, else `~/.hermes` (`%LOCALAPPDATA%\hermes` on
 * Windows), `hermes_constants.py` `get_hermes_home()` and `hermes_state.py`
 * `DEFAULT_DB_PATH`. Read from Hermes's own source; every field below is
 * named where it comes from.
 *
 * Tables (`hermes_state_common.py`, the schema DDL):
 *   - `sessions`: `id`, `source`, `model`, `started_at` / `ended_at` (epoch
 *     seconds, REAL), `end_reason`, `cwd`, `git_branch`, `parent_session_id`,
 *     `title`, and the session's token totals (`input_tokens`,
 *     `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
 *     `api_call_count`).
 *   - `messages`: one row per chat message in the OpenAI shape
 *     (`session_persistence.py` `_db_flush_row`): `role`, `content`,
 *     `tool_calls` (JSON list of `{id, function: {name, arguments}}`),
 *     `tool_call_id`, `tool_name`, `finish_reason`, `reasoning` /
 *     `reasoning_content` (assistant rows only), `timestamp` (epoch seconds),
 *     `_compressed_summary`, `active`, `compacted`, `display_kind`. `content`
 *     is a string, or a `"\x00json:"`-prefixed JSON list of parts when the
 *     message was multimodal (`hermes_state.py` `_encode_content`). Rows are
 *     read in `id` order, the order Hermes reads them
 *     (`hermes_state_messages.py`, `ORDER BY id ASC`); rows compression or a
 *     rewind retired (`active = 0`) are kept and flagged — they happened.
 *   - `session_model_usage`: per-model token totals and `api_call_count`.
 *     Hermes records no per-message usage, so there is no `cost` per API
 *     message; each model's totals become one `cost` at the session's end,
 *     flagged `aggregate` in `native`. Dollar columns are counted, not
 *     stored (SPEC §5.9).
 *
 * Tool results are the JSON the tool returned as its content
 * (`tools/file_tools.py`, `json.dumps(result_dict)`); that object is carried
 * as `structured`, and an `error` key in it marks `isError` (`tool_error`).
 *
 * **`file.diff` from Hermes's own tools** (`tools/file_operations.py`):
 *   - `write_file` feeds its `content` to `cat > tmp; mv -f tmp path`
 *     (`_atomic_write`), but first preserves the target's CRLF and BOM when
 *     the file already had them (`write_file`, `_probe_write_target`), then
 *     checks the disk's sha256 against what it wrote and answers
 *     `verified: true` and `bytes_written` — the byte count after those
 *     transforms. So the bytes on disk equal the call's `content` exactly
 *     when `verified` is true and `bytes_written` equals `content`'s UTF-8
 *     length (a preserved CRLF adds a byte per line, a BOM adds three); that
 *     is a `file.diff` over bytes Hermes itself confirmed. A write whose
 *     count differs was transformed against a file agit never saw, and is
 *     counted. Hermes does not say whether the file existed: with no prior
 *     content held the event is a `create` with `beforeHash` null, counted
 *     as `write_file:prior content unknown`.
 *   - `patch` in `replace` mode (`patch_replace`) answers with `diff`, a
 *     `difflib` unified diff of the BOM-stripped file before and after, and
 *     `files_modified`. When agit holds the file (an earlier verified write
 *     or patch, or `--base`) it strips the BOM the same way, applies that
 *     diff, restores the BOM, and hashes the result. A diff that does not
 *     apply, or a file agit never held, is counted.
 *   - `patch` in `v4a` mode and `read_file` are not replayed: a V4A patch is
 *     applied with Hermes's own matcher (`tools/patch_parser.py`), and
 *     `read_file` returns `<n>|line` gutters with long lines clamped and
 *     one trailing newline dropped (`_add_line_numbers`), which does not
 *     round-trip to bytes. Both are counted where they would have mattered.
 *
 * `state.db` runs in WAL mode and Hermes keeps the WAL open while it runs,
 * so the newest rows sit in `state.db-wal`; the import folds that sidecar's
 * committed frames in the way SQLite reads them (`applyWal` in sqlite.ts),
 * so a running Hermes imports as it stands.
 *
 * Derived from the source above and validated against a fixture written
 * with the same DDL, not against a real state.db; a real one that disagrees
 * names its unmapped rows in the import report.
 */

import { createHash } from "node:crypto";
import { seedKnownFromBase } from "../base.js";
import type { DraftEvent, Json } from "../format/events.js";
import { applyUnifiedDiff, NO_NEWLINE_MARKER } from "../patch.js";
import { looksLikeSqlite, rowsOf, SqliteError, SqliteFile, type SqliteValue } from "../sqlite.js";
import { EmptySourceError, type Adapter, type ConvertOptions, type ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "hermes";
const ADAPTER_VERSION = "0.1.0";

/** `hermes_state.py` `_CONTENT_JSON_PREFIX`: a multimodal content list, JSON-encoded behind it. */
const CONTENT_JSON_PREFIX = "\u0000json:";

type Rec = { [k: string]: Json };

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: SqliteValue | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Epoch seconds (REAL) inside the years 0000–9999, as ISO; null otherwise. */
function isoOfSeconds(v: SqliteValue | undefined): string | null {
  const s = num(v);
  if (s === null) return null;
  const ms = Math.round(s * 1000);
  if (ms < -62167219200000 || ms > 253402300799999) return null;
  return new Date(ms).toISOString();
}

function jsonOf(v: unknown): Json | undefined {
  if (typeof v !== "string") return undefined;
  try {
    return JSON.parse(v) as Json;
  } catch {
    return undefined;
  }
}

interface SessionRow {
  id: string;
  source: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  cwd: string | null;
  gitBranch: string | null;
  parentSessionId: string | null;
  title: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; apiCalls: number };
  hasCost: boolean;
}

interface MessageRow {
  id: number;
  role: string;
  content: SqliteValue;
  toolCalls: string | null;
  toolCallId: string | null;
  toolName: string | null;
  finishReason: string | null;
  reasoning: string | null;
  reasoningContent: string | null;
  ts: string | null;
  compressedSummary: boolean;
  active: boolean;
  compacted: boolean;
  displayKind: string | null;
}

interface UsageRow {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  apiCalls: number;
  hasCost: boolean;
}

interface Tables {
  sessions: Map<string, SessionRow>;
  messages: Map<string, MessageRow[]>;
  usage: Map<string, UsageRow[]>;
}

const SESSION_COLUMNS = ["id", "source", "started_at", "cwd", "model"];
const MESSAGE_COLUMNS = [
  "id",
  "session_id",
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "tool_name",
  "timestamp",
];

function readTables(bytes: Uint8Array): Tables {
  const db = new SqliteFile(bytes);
  const need = (name: string, columns: string[]) => {
    const t = db.table(name);
    if (t === undefined || !columns.every((c) => t.columns.includes(c))) {
      throw new Error(`this SQLite database has no Hermes \`${name}\` table; not a Hermes state.db`);
    }
    return t;
  };
  const sessionT = need("sessions", SESSION_COLUMNS);
  const messageT = need("messages", MESSAGE_COLUMNS);
  const usageT = db.table("session_model_usage");

  const sessions = new Map<string, SessionRow>();
  for (const r of rowsOf(db, sessionT)) {
    const id = str(r.id);
    if (id === null) continue;
    sessions.set(id, {
      id,
      source: str(r.source),
      model: str(r.model),
      startedAt: isoOfSeconds(r.started_at),
      endedAt: isoOfSeconds(r.ended_at),
      endReason: str(r.end_reason),
      cwd: str(r.cwd),
      gitBranch: str(r.git_branch),
      parentSessionId: str(r.parent_session_id),
      title: str(r.title),
      usage: {
        input: num(r.input_tokens) ?? 0,
        output: num(r.output_tokens) ?? 0,
        cacheRead: num(r.cache_read_tokens) ?? 0,
        cacheWrite: num(r.cache_write_tokens) ?? 0,
        apiCalls: num(r.api_call_count) ?? 0,
      },
      hasCost: (num(r.estimated_cost_usd) ?? 0) !== 0 || (num(r.actual_cost_usd) ?? 0) !== 0,
    });
  }
  const messages = new Map<string, MessageRow[]>();
  for (const r of rowsOf(db, messageT)) {
    const sessionId = str(r.session_id);
    const id = num(r.id);
    if (sessionId === null || id === null) continue;
    const list = messages.get(sessionId) ?? [];
    list.push({
      id,
      role: str(r.role) ?? "(absent)",
      content: r.content ?? null,
      toolCalls: str(r.tool_calls),
      toolCallId: str(r.tool_call_id),
      toolName: str(r.tool_name),
      finishReason: str(r.finish_reason),
      reasoning: str(r.reasoning),
      reasoningContent: str(r.reasoning_content),
      ts: isoOfSeconds(r.timestamp),
      compressedSummary: (num(r._compressed_summary) ?? 0) !== 0,
      active: (num(r.active) ?? 1) !== 0,
      compacted: (num(r.compacted) ?? 0) !== 0,
      displayKind: str(r.display_kind),
    });
    messages.set(sessionId, list);
  }
  for (const list of messages.values()) list.sort((a, b) => a.id - b.id);
  const usage = new Map<string, UsageRow[]>();
  if (
    usageT !== undefined &&
    ["session_id", "model", "input_tokens", "output_tokens"].every((c) => usageT.columns.includes(c))
  ) {
    for (const r of rowsOf(db, usageT)) {
      const sessionId = str(r.session_id);
      const model = str(r.model);
      if (sessionId === null || model === null) continue;
      const list = usage.get(sessionId) ?? [];
      list.push({
        model,
        input: num(r.input_tokens) ?? 0,
        output: num(r.output_tokens) ?? 0,
        cacheRead: num(r.cache_read_tokens) ?? 0,
        cacheWrite: num(r.cache_write_tokens) ?? 0,
        apiCalls: num(r.api_call_count) ?? 0,
        hasCost: (num(r.estimated_cost_usd) ?? 0) !== 0 || (num(r.actual_cost_usd) ?? 0) !== 0,
      });
      usage.set(sessionId, list);
    }
    for (const list of usage.values()) list.sort((a, b) => a.model.localeCompare(b.model));
  }
  return { sessions, messages, usage };
}

/** SPEC §1 wants a session id that is a safe directory name; checked, not assumed. */
function sessionIdFor(nativeId: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(nativeId) && nativeId !== "." && nativeId !== "..") return nativeId;
  return `hermes-${sha256Utf8(nativeId).slice(0, 16)}`;
}

/** A row's content as text: a string, or the parts of a multimodal list (images named, counted). */
function contentText(v: SqliteValue, onImage: () => void, onOther: (t: string) => void): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  if (typeof v !== "string") return String(v);
  if (!v.startsWith(CONTENT_JSON_PREFIX)) return v;
  const parsed = jsonOf(v.slice(CONTENT_JSON_PREFIX.length));
  if (!Array.isArray(parsed)) return v;
  const parts: string[] = [];
  for (const part of parsed) {
    const p = asRec(part);
    if (p === undefined) continue;
    if (p.type === "text") {
      const t = str(p.text);
      if (t !== null && t !== "") parts.push(t);
    } else if (p.type === "image" || p.type === "image_url" || p.type === "input_image") {
      onImage();
      parts.push("[image]");
    } else {
      onOther(str(p.type) ?? "(untyped)");
      parts.push(`[${str(p.type) ?? "content"}]`);
    }
  }
  return parts.join("\n");
}

/** An absolute path stays; a relative one joins the session's cwd; `~` is Hermes's home and is left alone. */
function resolveAgainst(cwd: string | null, path: string): string | null {
  if (path.startsWith("~")) return null;
  if (/^(?:[A-Za-z]:)?[\\/]/.test(path)) return path;
  if (cwd === null || cwd === "") return null;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return (
    cwd.replace(/[\\/]+$/, "") +
    sep +
    path
      .replace(/^\.[\\/]/, "")
      .split(/[\\/]/)
      .join(sep)
  );
}

function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

/** A correct, if unminimized, full-file diff with the no-newline marker each side needs (see codex.ts). */
function synthesizeDiff(path: string, before: string | null, after: string): string {
  const p = path.replace(/^[\\/]+/, "");
  const header = before === null ? `--- /dev/null\n+++ b/${p}` : `--- a/${p}\n+++ b/${p}`;
  const split = (s: string): string[] => {
    if (s === "") return [];
    const lines = s.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const side = (text: string | null, tag: "-" | "+"): string[] => {
    if (text === null || text === "") return [];
    const out = split(text).map((l) => `${tag}${l}`);
    if (!text.endsWith("\n")) out.push(NO_NEWLINE_MARKER);
    return out;
  };
  const b = before === null ? [] : split(before);
  const a = split(after);
  const lines = [...side(before, "-"), ...side(after, "+")];
  return `${header}\n@@ -${b.length === 0 ? 0 : 1},${b.length} +${a.length === 0 ? 0 : 1},${a.length} @@\n${lines.join("\n")}\n`;
}

function fileDiffPayload(
  path: string,
  before: string | null,
  after: string,
  diff: string,
  toolUseId: string,
  source: string,
): Rec {
  return {
    path,
    kind: before === null ? "create" : "modify",
    diff,
    beforeHash: before === null ? null : sha256Utf8(before),
    afterHash: sha256Utf8(after),
    toolUseId,
    source,
  };
}

interface Call {
  name: string;
  args: Rec;
}

export const hermesAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  detect(): boolean {
    return false;
  },

  convert(): ConvertResult {
    throw new Error("the Hermes adapter reads state.db, not text; use convertBytes");
  },

  detectBytes(bytes: Uint8Array): boolean {
    if (!looksLikeSqlite(bytes)) return false;
    try {
      const db = new SqliteFile(bytes);
      const has = (name: string, cols: string[]) => {
        const t = db.table(name);
        return t !== undefined && cols.every((c) => t.columns.includes(c));
      };
      return has("sessions", SESSION_COLUMNS) && has("messages", MESSAGE_COLUMNS);
    } catch {
      return false;
    }
  },

  sessionsIn(bytes: Uint8Array): string[] {
    // Sessions with messages, oldest first; an empty session is nothing to import.
    const t = readTables(bytes);
    return [...t.sessions.values()]
      .filter((s) => (t.messages.get(s.id)?.length ?? 0) > 0)
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.id.localeCompare(b.id))
      .map((s) => s.id);
  },

  convertBytes(bytes: Uint8Array, opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };
    let t: Tables;
    try {
      t = readTables(bytes);
    } catch (err) {
      if (err instanceof SqliteError)
        throw new Error(`cannot read this SQLite database: ${err.message}`, { cause: err });
      throw err;
    }
    const ids = hermesAdapter.sessionsIn!(bytes);
    if (ids.length === 0) throw new EmptySourceError("this Hermes state.db holds no session with messages");
    let nativeId: string;
    if (opts?.select !== undefined) {
      if (!t.sessions.has(opts.select))
        throw new Error(`no session ${opts.select} in this state.db; sessions: ${ids.join(", ")}`);
      nativeId = opts.select;
    } else if (ids.length === 1) {
      nativeId = ids[0]!;
    } else {
      throw new Error(
        `this state.db holds ${ids.length} sessions; pass --thread <id> to pick one: ${ids.join(", ")}`,
      );
    }
    const session = t.sessions.get(nativeId)!;
    const rows = t.messages.get(nativeId) ?? [];
    const sessionId = sessionIdFor(nativeId);
    if (sessionId !== nativeId) skip("session-id-derived (native id is not path-safe)");

    // The first timestamp anywhere dates the session; a database with none is
    // refused rather than dated from the clock (SPEC §7).
    const firstTs = session.startedAt ?? rows.map((r) => r.ts).find((x) => x !== null) ?? null;
    if (firstTs === null) throw new Error("this Hermes session carries no timestamp agit can read (SPEC §7)");

    const drafts: DraftEvent[] = [];
    const known = new Map<string, string>();
    const calls = new Map<string, Call>();
    let ts = firstTs;
    seedKnownFromBase(known, opts?.base, session.cwd);
    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime: "hermes",
        runtimeVersion: null,
        nativeSessionId: nativeId,
        cwd: session.cwd,
        gitBranch: session.gitBranch,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: {
          source: session.source,
          model: session.model,
          parentSessionId: session.parentSessionId,
          title: session.title,
        },
      },
    });

    let inherited = 0;
    for (const m of rows) {
      if (m.ts !== null) ts = m.ts;
      else inherited++;
      const native: Rec = {
        rowId: m.id,
        active: m.active,
        ...(m.compacted ? { compacted: true } : {}),
        ...(m.compressedSummary ? { compressedSummary: true } : {}),
        ...(m.displayKind !== null ? { displayKind: m.displayKind } : {}),
      };
      const onImage = (): void => skip("content:image");
      const onOther = (kind: string): void => skip(`content:${kind}`);

      if (m.role === "user") {
        const text = contentText(m.content, onImage, onOther);
        if (text !== "") drafts.push({ ts, type: "message.user", payload: { text, native } });
        else skip("message:user(empty)");
      } else if (m.role === "assistant") {
        const blocks: Json[] = [];
        for (const r of [m.reasoning, m.reasoningContent])
          if (r !== null && r !== "") blocks.push({ type: "thinking", text: r });
        const text = contentText(m.content, onImage, onOther);
        if (text !== "") blocks.push({ type: "text", text });
        const toolCalls: { toolUseId: string | null; name: string; input: Rec }[] = [];
        const parsed = m.toolCalls === null ? [] : jsonOf(m.toolCalls);
        if (!Array.isArray(parsed)) skip("malformed:tool_calls");
        else {
          for (const c of parsed) {
            const call = asRec(c);
            const fn = call === undefined ? undefined : asRec(call.function);
            if (call === undefined || fn === undefined) {
              skip("malformed:tool_call");
              continue;
            }
            const id = str(call.id);
            const name = str(fn.name) ?? "(unnamed)";
            let input = asRec(jsonOf(fn.arguments));
            if (input === undefined) {
              // `arguments` is a JSON string in the OpenAI shape; anything else is kept as the text it was.
              input = { arguments: str(fn.arguments) ?? null };
              skip("malformed:tool_call(arguments)");
            }
            if (id === null) skip("tool-call-without-id");
            else calls.set(id, { name, args: input });
            toolCalls.push({ toolUseId: id, name, input });
          }
        }
        if (blocks.length > 0) {
          drafts.push({
            ts,
            type: "message.assistant",
            payload: { model: session.model, blocks, stopReason: m.finishReason, native },
          });
        } else if (toolCalls.length === 0) {
          skip("message:assistant(empty)");
        }
        for (const c of toolCalls) {
          drafts.push({
            ts,
            type: "tool.call",
            payload: { toolUseId: c.toolUseId, name: c.name, input: c.input, native },
          });
        }
      } else if (m.role === "tool") {
        const toolUseId = m.toolCallId;
        if (toolUseId === null) skip("tool-result-without-id");
        const output = contentText(m.content, onImage, onOther);
        const structured = asRec(jsonOf(output)) ?? null;
        const error = structured === null ? null : structured.error;
        const isError = error !== null && error !== undefined && error !== false && error !== "";
        drafts.push({
          ts,
          type: "tool.result",
          payload: { toolUseId, isError, output, structured, native: { ...native, toolName: m.toolName } },
        });
        const call = toolUseId === null ? undefined : calls.get(toolUseId);
        if (call === undefined || isError || structured === null) {
          // nothing to replay
        } else if (call.name === "write_file") {
          const content = str(call.args.content);
          const argPath = str(call.args.path);
          const path =
            str(structured.resolved_path) ?? (argPath === null ? null : resolveAgainst(session.cwd, argPath));
          const written = num(
            typeof structured.bytes_written === "number" ? structured.bytes_written : undefined,
          );
          if (content === null || path === null) skip("write_file:malformed");
          else if (structured.verified !== true) skip("write_file:not verified by runtime");
          else if (written !== Buffer.byteLength(content, "utf8"))
            skip("write_file:content transformed (CRLF or BOM preserved)");
          else {
            const before = known.get(path) ?? null;
            if (before === null) skip("write_file:prior content unknown");
            drafts.push({
              ts,
              type: "file.diff",
              payload: fileDiffPayload(
                path,
                before,
                content,
                synthesizeDiff(path, before, content),
                toolUseId!,
                "write_file",
              ),
            });
            known.set(path, content);
          }
        } else if (call.name === "patch") {
          const mode = str(call.args.mode) ?? (str(call.args.patch) !== null ? "v4a" : "replace");
          if (mode !== "replace") {
            skip(`patch:${mode} not replayed`);
          } else {
            const diff = str(structured.diff);
            const modified = Array.isArray(structured.files_modified)
              ? str(structured.files_modified[0])
              : null;
            const argPath = str(call.args.path);
            const path = modified ?? (argPath === null ? null : resolveAgainst(session.cwd, argPath));
            if (diff === null || path === null) skip("patch:no diff in result");
            else {
              const before = known.get(path);
              if (before === undefined) skip("patch:base content not in log");
              else {
                const { bom, text } = splitBom(before);
                let after: string | null;
                try {
                  after = applyUnifiedDiff(text, diff);
                } catch {
                  after = null;
                }
                if (after === null) skip("patch:diff did not apply");
                else {
                  const final = bom + after;
                  drafts.push({
                    ts,
                    type: "file.diff",
                    payload: fileDiffPayload(
                      path,
                      before,
                      final,
                      bom === "" ? diff : synthesizeDiff(path, before, final),
                      toolUseId!,
                      "patch",
                    ),
                  });
                  known.set(path, final);
                }
              }
            }
          }
        }
      } else {
        skip(`message-role:${m.role}`);
      }
    }
    if (inherited > 0) skip("message-timestamp-inherited", inherited);

    // Session totals per model, as one aggregate cost each (see the header).
    // Held back while the session runs: they grow with every request, and a
    // live share must only ever extend what it streamed.
    const usageRows = opts?.live && session.endedAt === null ? [] : (t.usage.get(nativeId) ?? []);
    const totals: UsageRow[] =
      opts?.live && session.endedAt === null
        ? []
        : usageRows.length > 0
          ? usageRows
          : session.usage.input + session.usage.output + session.usage.cacheRead + session.usage.cacheWrite >
              0
            ? [{ model: session.model ?? "", ...session.usage, hasCost: session.hasCost }]
            : [];
    const endTs = session.endedAt ?? ts;
    for (const u of totals) {
      if (u.hasCost) skip("cost-usd-not-stored (SPEC §5.9)");
      drafts.push({
        ts: endTs,
        type: "cost",
        payload: {
          model: u.model === "" ? null : u.model,
          usage: {
            inputTokens: u.input,
            outputTokens: u.output,
            cacheReadInputTokens: u.cacheRead,
            cacheCreationInputTokens: u.cacheWrite,
          },
          native: { aggregate: true, apiCallCount: u.apiCalls, requestId: null },
        },
      });
    }
    if (totals.length > 0) skip("cost-aggregated-per-model (no per-message usage)", totals.length);

    if (session.endedAt !== null) {
      drafts.push({
        ts: session.endedAt,
        type: "session.end",
        payload: { reason: session.endReason ?? "ended", synthesized: false },
      });
    } else if (!opts?.live) {
      drafts.push({ ts, type: "session.end", payload: { reason: "messages-end", synthesized: true } });
    }
    return { sessionId, drafts, records: rows.length, skipped };
  },
};
