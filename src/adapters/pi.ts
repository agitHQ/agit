/**
 * Adapter for pi's session files (#64): the coding agent in badlogic/pi-mono
 * (`@earendil-works/pi-coding-agent`), whose sessions are documented in
 * `packages/coding-agent/docs/session-format.md` and written by
 * `packages/coding-agent/src/core/session-manager.ts`. Every field below is
 * from that document, checked against the source it points at.
 *
 * The file: `~/.pi/agent/sessions/--<cwd with / \ : as ->--/<timestamp>_<id>.jsonl`
 * (`getDefaultSessionDirPath`; the agent dir honours `PI_CODING_AGENT_DIR`,
 * `config.ts`). One JSON object per line. The first is the header,
 * `{type: "session", version, id, timestamp, cwd, parentSession?}`; every
 * other entry carries `id`, `parentId` and an ISO `timestamp`, and the
 * entries form a tree — `/tree` branches in place, so a later line can hang
 * off an earlier one. agit linearizes in file order (SPEC §6) and keeps the
 * tree under `native.entryId` / `native.parentId`. Version 1 files have no
 * ids (pi assigns them on load); version 2 → 3 renamed the `hookMessage`
 * role to `custom`. Both are read as pi's own migration reads them.
 *
 * Entries (`SessionEntry` in session-manager.ts):
 *   - `message` — an `AgentMessage` (`packages/agent/src/types.ts`):
 *       `user` (`content` a string or text/image blocks) → message.user;
 *       `assistant` (`content` of text / thinking / toolCall blocks, `model`,
 *       `provider`, `api`, `stopReason`, `usage`) → message.assistant, one
 *       tool.call per toolCall (`id`, `name`, `arguments`), and one cost from
 *       `usage` (`input`, `output`, `cacheRead`, `cacheWrite`; `usage.cost`
 *       is dollars and is counted, not stored — SPEC §5.9);
 *       `toolResult` (`toolCallId`, `toolName`, `content`, `isError`,
 *       `details`) → tool.result, `details` carried as `structured`;
 *       `bashExecution` (the person ran `!cmd`), `custom` (an extension's
 *       message), `branchSummary`, `compactionSummary` → counted by role.
 *   - `compaction` and `branch_summary` — a summary pi wrote; when it carries
 *     `usage` ("included in session token and cost totals") that becomes a
 *     cost, attributed to the model then in force; the entry is counted.
 *   - `model_change` (tracked for that attribution), `thinking_level_change`,
 *     `label`, `session_info`, `custom`, `custom_message` — counted by type.
 *
 * **`file.diff` from pi's own tools** (`packages/coding-agent/src/core/tools/`):
 *   - `write` (write.ts) writes its `content` argument verbatim:
 *     `fsWriteFile(path, content, "utf-8")`, no normalization. So a
 *     successful write is a `file.diff` whose `afterHash` is over exactly the
 *     bytes that reached the disk. pi does not record whether the file
 *     existed; when agit holds no prior content the event is a `create` with
 *     `beforeHash` null, and the report counts it as `write:prior content
 *     unknown` so nobody reads that null as proof the file was new.
 *   - `edit` (edit.ts, edit-diff.ts) reads the file, splits a BOM, notes the
 *     line ending, normalizes to LF, applies the replacements, restores the
 *     ending and the BOM, and writes; its result's `details.patch` is a
 *     unified patch of the normalized before → after. When agit holds the
 *     file's content (a `write`, a verified `edit`, a full `read`, or
 *     `--base`) it replays exactly that: strip the BOM, note the ending,
 *     normalize, apply the patch, restore — and hashes the result. A patch
 *     that does not apply, or a file agit never held, is counted, not
 *     hashed.
 *   - `read` (read.ts) returns the file's text unchanged — `split("\n")` then
 *     `join("\n")`, BOM and CRs intact — when nothing truncated it: no
 *     `offset`, no `limit`, and no `details.truncation`. Such a read seeds
 *     the content later edits are verified against; a truncated one does not.
 *   - `bash` edits are invisible, as SPEC §5.7 says of every shell.
 *   Paths are resolved against the header's `cwd` the way `resolveToCwd`
 *   does; a `~` path is left alone and never tracked.
 *
 * **OpenClaw writes this same format** — it is built on pi-mono — and its
 * adapter reads the OpenClaw dialect (`apply_patch`, `exec`, its agent
 * database). The two are told apart before either claims a file
 * (`classifySessionLog`): OpenClaw's own sessions carry `version: 4`
 * (src/config/sessions/version.ts, "only new sessions select version 4";
 * 3 stays readable) and pi's carry 3 or less; a version-3 file is then
 * OpenClaw's if it calls OpenClaw's tools and pi's if it calls pi's or
 * calls nothing.
 *
 * A running session is shared from the same file, which pi appends to; under
 * `ConvertOptions.live` the synthesized `session.end` is held back. Derived
 * from the source above and validated against a fixture built to it, not
 * against a real session; a real one that disagrees names its unmapped
 * entries in the import report.
 */

import { createHash } from "node:crypto";
import { seedKnownFromBase } from "../base.js";
import type { DraftEvent, Json } from "../format/events.js";
import { applyUnifiedDiff, NO_NEWLINE_MARKER } from "../patch.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "pi";
const ADAPTER_VERSION = "0.1.0";

/** pi's CURRENT_SESSION_VERSION (session-manager.ts); OpenClaw's is 4. */
const PI_MAX_SESSION_VERSION = 3;

/** pi's built-in tools (tools/index.ts) and OpenClaw's, the tells for a version-3 file. */
const PI_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "powershell",
]);
const OPENCLAW_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "exec"]);

type Rec = { [k: string]: Json };

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: Json | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function parseLine(line: string): Rec | undefined {
  try {
    return asRec(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** The header, if this is a pi-format log at all: `type: "session"` with a string id, in the first 25 lines. */
function findHeader(lines: string[]): Rec | null {
  for (const line of lines.slice(0, 25)) {
    const r = parseLine(line);
    if (r !== undefined && r.type === "session" && typeof r.id === "string") return r;
  }
  return null;
}

/**
 * pi or OpenClaw? See the header. `null` when the lines are not this format.
 */
export function classifySessionLog(lines: string[]): "pi" | "openclaw" | null {
  const header = findHeader(lines);
  if (header === null) return null;
  const version = typeof header.version === "number" ? header.version : 1;
  if (version > PI_MAX_SESSION_VERSION) return "openclaw";
  for (const line of lines) {
    const r = parseLine(line);
    if (r === undefined || r.type !== "message") continue;
    const m = asRec(r.message);
    if (m === undefined || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      const c = asRec(b);
      if (c === undefined || c.type !== "toolCall" || typeof c.name !== "string") continue;
      if (OPENCLAW_TOOLS.has(c.name)) return "openclaw";
      if (PI_TOOLS.has(c.name)) return "pi";
    }
  }
  // Version 3 with no tool of either: pi's current version, OpenClaw's legacy one.
  return "pi";
}

/** An ISO timestamp as pi writes them (`new Date().toISOString()`), else null. */
function isoOf(v: Json | undefined): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Epoch-millisecond `timestamp` on a message, as a fallback for an entry without one. */
function isoOfMs(v: Json | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < -62167219200000 || v > 253402300799999) return null;
  return new Date(v).toISOString();
}

/** Text of a content array (or string), images and other parts named in brackets. */
function contentText(v: Json | undefined, onImage: () => void): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  const parts: string[] = [];
  for (const part of v) {
    const p = asRec(part);
    if (p === undefined) continue;
    if (p.type === "text") {
      const t = str(p.text);
      if (t !== null && t !== "") parts.push(t);
    } else if (p.type === "image") {
      onImage();
      parts.push("[image]");
    } else {
      parts.push(`[${str(p.type) ?? "content"}]`);
    }
  }
  return parts.join("\n");
}

/** `resolveToCwd`: an absolute path stays, a relative one joins the cwd; `~` is pi's home and is left alone. */
function resolveAgainst(cwd: string | null, path: string): string | null {
  if (path.startsWith("~")) return null;
  if (/^(?:[A-Za-z]:)?[\\/]/.test(path)) return path;
  if (cwd === null || cwd === "") return null;
  const sep = cwd.includes("\\") ? "\\" : "/";
  const rel = path.replace(/^\.[\\/]/, "");
  return cwd.replace(/[\\/]+$/, "") + sep + rel.split(/[\\/]/).join(sep);
}

/** edit-diff.ts, line for line: which ending the file uses, LF normalization, and its restoration. */
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}
function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

/** A correct, if unminimized, full-file diff, with the no-newline marker each side needs (see codex.ts). */
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

export const piAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    return classifySessionLog(lines) === "pi";
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };
    const drafts: DraftEvent[] = [];
    /** Content agit holds per absolute path: written, verified, fully read, or seeded from --base. */
    const known = new Map<string, string>();
    const calls = new Map<string, Call>();

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let ts: string | null = null;
    let lastModel: string | null = null;
    let inherited = 0;
    let records = 0;

    for (const line of lines) {
      const r = parseLine(line);
      if (r === undefined) {
        skip("<unparseable>");
        continue;
      }
      records++;
      const type = str(r.type) ?? "(untyped)";

      if (type === "session") {
        if (sessionId !== null) {
          skip("entry:session(duplicate header)");
          continue;
        }
        const id = str(r.id);
        const at = isoOf(r.timestamp);
        if (id === null || at === null)
          throw new Error("this pi session header has no id or no timestamp agit can read");
        sessionId = id;
        cwd = str(r.cwd);
        ts = at;
        seedKnownFromBase(known, opts?.base, cwd);
        drafts.push({
          ts,
          type: "session.start",
          payload: {
            runtime: "pi",
            runtimeVersion: null,
            nativeSessionId: id,
            cwd,
            gitBranch: null,
            adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
            native: {
              sessionVersion: typeof r.version === "number" ? r.version : 1,
              parentSession: str(r.parentSession),
            },
          },
        });
        continue;
      }
      if (sessionId === null || ts === null) {
        // Nothing before the header is an entry pi would have written.
        skip(`entry-before-header:${type}`);
        continue;
      }

      const at = isoOf(r.timestamp) ?? isoOfMs(asRec(r.message)?.timestamp);
      if (at !== null) ts = at;
      else inherited++;
      const native: Rec = { entryId: str(r.id), parentId: str(r.parentId) };

      if (type === "message") {
        const m = asRec(r.message);
        if (m === undefined) {
          skip("entry:message(no message)");
          continue;
        }
        const role = str(m.role) ?? "(absent)";
        if (role === "user") {
          const text = contentText(m.content, () => skip("content:image"));
          if (text !== "") drafts.push({ ts, type: "message.user", payload: { text, native } });
          else skip("message:user(empty)");
        } else if (role === "assistant") {
          const model = str(m.model);
          if (model !== null) lastModel = model;
          const blocks: Json[] = [];
          const toolCalls: { toolUseId: string | null; name: string; input: Rec }[] = [];
          for (const part of Array.isArray(m.content) ? m.content : []) {
            const p = asRec(part);
            if (p === undefined) {
              skip("malformed-block:non-object");
              continue;
            }
            if (p.type === "text") {
              const t = str(p.text);
              if (t !== null && t !== "") blocks.push({ type: "text", text: t });
            } else if (p.type === "thinking") {
              const t = str(p.thinking);
              if (p.redacted === true) skip("thinking:redacted");
              else if (t !== null && t !== "") blocks.push({ type: "thinking", text: t });
            } else if (p.type === "toolCall") {
              const id = str(p.id);
              const name = str(p.name) ?? "(unnamed)";
              const input = asRec(p.arguments) ?? {};
              if (input !== p.arguments && p.arguments !== undefined)
                skip("malformed-block:toolCall(arguments)");
              if (id === null) skip("tool-call-without-id");
              else calls.set(id, { name, args: input });
              toolCalls.push({ toolUseId: id, name, input });
            } else {
              skip(`unknown-block:${str(p.type) ?? "(untyped)"}`);
            }
          }
          if (blocks.length > 0) {
            drafts.push({
              ts,
              type: "message.assistant",
              payload: {
                model,
                blocks,
                stopReason: str(m.stopReason),
                native: {
                  ...native,
                  provider: str(m.provider),
                  api: str(m.api),
                  responseId: str(m.responseId),
                  ...(str(m.errorMessage) !== null ? { errorMessage: str(m.errorMessage) } : {}),
                },
              },
            });
          }
          for (const c of toolCalls) {
            drafts.push({
              ts,
              type: "tool.call",
              payload: { toolUseId: c.toolUseId, name: c.name, input: c.input, native },
            });
          }
          const usage = asRec(m.usage);
          if (usage !== undefined) {
            if (usage.cost !== undefined) skip("cost-usd-not-stored (SPEC §5.9)");
            drafts.push({
              ts,
              type: "cost",
              payload: {
                model,
                usage: {
                  inputTokens: num(usage.input),
                  outputTokens: num(usage.output),
                  cacheReadInputTokens: num(usage.cacheRead),
                  cacheCreationInputTokens: num(usage.cacheWrite),
                },
                native: { ...native, responseId: str(m.responseId), requestId: null },
              },
            });
          }
        } else if (role === "toolResult") {
          const toolUseId = str(m.toolCallId);
          if (toolUseId === null) skip("tool-result-without-id");
          const toolName = str(m.toolName);
          const isError = m.isError === true;
          const output = contentText(m.content, () => skip("content:image"));
          const details = asRec(m.details);
          drafts.push({
            ts,
            type: "tool.result",
            payload: {
              toolUseId,
              isError,
              output,
              structured: details ?? null,
              native: { ...native, toolName },
            },
          });
          const call = toolUseId === null ? undefined : calls.get(toolUseId);
          if (call === undefined) {
            if (toolName !== null && (toolName === "write" || toolName === "edit"))
              skip(`${toolName}:call not in log`);
          } else if (!isError && call.name === "write") {
            const path = str(call.args.path);
            const content = str(call.args.content);
            const abs = path === null ? null : resolveAgainst(cwd, path);
            if (path === null || content === null) skip("write:malformed arguments");
            else if (abs === null) skip("write:path not resolvable");
            else {
              const before = known.get(abs) ?? null;
              if (before === null) skip("write:prior content unknown");
              drafts.push({
                ts,
                type: "file.diff",
                payload: fileDiffPayload(
                  abs,
                  before,
                  content,
                  synthesizeDiff(abs, before, content),
                  toolUseId!,
                  "write",
                ),
              });
              known.set(abs, content);
            }
          } else if (!isError && call.name === "edit") {
            const path = str(call.args.path);
            const patch = details === undefined ? null : str(details.patch);
            const abs = path === null ? null : resolveAgainst(cwd, path);
            if (path === null || patch === null) skip("edit:no patch in result");
            else if (abs === null) skip("edit:path not resolvable");
            else {
              const before = known.get(abs);
              if (before === undefined) skip("edit:base content not in log");
              else {
                const { bom, text } = splitBom(before);
                const ending = detectLineEnding(text);
                const normalized = normalizeToLF(text);
                let after: string | null;
                try {
                  after = applyUnifiedDiff(normalized, patch);
                } catch {
                  after = null;
                }
                if (after === null) skip("edit:patch did not apply");
                else {
                  const final = bom + restoreLineEndings(after, ending);
                  // pi's patch is over the normalized text; it is agit's diff only
                  // when nothing was normalized away, so replaying it reproduces afterHash.
                  const verbatim = bom === "" && ending === "\n" && normalized === text;
                  drafts.push({
                    ts,
                    type: "file.diff",
                    payload: fileDiffPayload(
                      abs,
                      before,
                      final,
                      verbatim ? patch : synthesizeDiff(abs, before, final),
                      toolUseId!,
                      "edit",
                    ),
                  });
                  known.set(abs, final);
                }
              }
            }
          } else if (!isError && call.name === "read") {
            // A full read is the file's text exactly (see the header).
            const path = str(call.args.path);
            const abs = path === null ? null : resolveAgainst(cwd, path);
            const partial = call.args.offset !== undefined || call.args.limit !== undefined;
            const truncated = details !== undefined && details.truncation !== undefined;
            const parts = Array.isArray(m.content) ? m.content : [];
            const onlyText = parts.length === 1 && asRec(parts[0])?.type === "text";
            if (abs !== null && !partial && !truncated && onlyText) known.set(abs, output);
          }
        } else {
          skip(`message-role:${role}`);
        }
        continue;
      }

      if (type === "model_change") {
        const model = str(r.modelId);
        if (model !== null) lastModel = model;
        skip("entry:model_change");
        continue;
      }
      if (type === "compaction" || type === "branch_summary") {
        const usage = asRec(r.usage);
        if (usage !== undefined) {
          if (usage.cost !== undefined) skip("cost-usd-not-stored (SPEC §5.9)");
          drafts.push({
            ts,
            type: "cost",
            payload: {
              model: lastModel,
              usage: {
                inputTokens: num(usage.input),
                outputTokens: num(usage.output),
                cacheReadInputTokens: num(usage.cacheRead),
                cacheCreationInputTokens: num(usage.cacheWrite),
              },
              native: { ...native, entryType: type, requestId: null },
            },
          });
        }
        skip(`entry:${type}`);
        continue;
      }
      skip(`entry:${type}`);
    }

    if (sessionId === null || ts === null) throw new Error("not a pi session: no session header");
    if (inherited > 0) skip("entry-timestamp-inherited", inherited);
    if (!opts?.live)
      drafts.push({ ts, type: "session.end", payload: { reason: "file-end", synthesized: true } });
    return { sessionId, drafts, records, skipped };
  },
};
