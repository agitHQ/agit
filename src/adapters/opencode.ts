/**
 * Adapter for OpenCode's session database (#64, #122).
 *
 * OpenCode (anomalyco/opencode) persists every session in one SQLite file,
 * `opencode.db` under its XDG data directory — `~/.local/share/opencode/`
 * unless `$XDG_DATA_HOME` says otherwise, `opencode-<channel>.db` on a
 * non-release channel (packages/core/src/database/database.ts `path()`,
 * packages/core/src/global.ts). Every name below is from the runtime's own
 * source, not from a running install:
 *
 *   - the tables, from the drizzle definitions in
 *     packages/core/src/session/sql.ts and the generated DDL in
 *     packages/core/src/database/schema.gen.ts: `session` (id, project_id,
 *     directory, title, version, model, tokens_*, time_created, …),
 *     `message` (id, session_id, time_created, time_updated, data) and
 *     `part` (id, message_id, session_id, time_created, time_updated, data);
 *   - what `data` holds, from packages/schema/src/v1/session.ts — a
 *     `message` row is `SessionV1.Info` minus `id`/`sessionID` (the
 *     projector strips exactly those two: packages/core/src/session/
 *     projector.ts `messageData`), a `part` row is `SessionV1.Part` minus
 *     `id`/`sessionID`/`messageID` (`partData`);
 *   - the read order, from `MessageV2.page` in packages/opencode/src/
 *     session/message-v2.ts: messages by `(time_created, id)`, parts by
 *     `id`, which is what the TUI shows and what this adapter reproduces.
 *
 * The mapping, per part type of the v1 schema:
 *   - `text` on a user message → `message.user`; on an assistant message →
 *     a text block. A part marked `synthetic` is OpenCode's own injected
 *     prompt (media attachments, for one) and is counted, not shown as the
 *     user's words; one marked `ignored` was never sent and is counted.
 *   - `reasoning` → a thinking block.
 *   - `tool` → `tool.call` (`callID`, `tool`, `state.input`) and, once the
 *     state is `completed` or `error`, `tool.result` (`state.output` or
 *     `state.error`). A `pending` or `running` state has no result yet;
 *     the call is recorded and the missing result counted.
 *   - `step-finish` → `cost`: one per model call, carrying that call's
 *     `tokens` (`input`, `output`, `cache.read`, `cache.write`). Reasoning
 *     tokens have no field in SPEC §5.9's usage and ride under `native`;
 *     the dollar `cost` OpenCode computes is a display-time figure and is
 *     counted, not stored (SPEC §5.9). An assistant message without any
 *     `step-finish` part but with `tokens` of its own gets one `cost` from
 *     those, so a session never loses its usage to a missing marker.
 *   - `patch` names files a git snapshot changed (`hash`, `files`) and holds
 *     no content; `snapshot` and `step-start` are markers; `file`, `agent`,
 *     `subtask`, `compaction` and `retry` are structure agit has no event
 *     for. Every one is counted by type.
 *
 * **No `file.diff`.** OpenCode's file changes live in git snapshots of the
 * worktree (`packages/opencode/src/snapshot`), not in the database, so no
 * content is available to hash and none is invented; `blame`, `why`,
 * `fork`, `merge` and `diff` have nothing to work with, everything else
 * does. Message timestamps are the rows' own (`time.created` on the
 * message, `time.start` on a tool or reasoning part, `time_created` on
 * the row), all epoch milliseconds.
 *
 * A database holds every session; `sessionsIn` lists them and `agit import`
 * takes each unless `--thread <id>` names one. Derived from the schema and
 * validated against a fixture built to it; not yet run against a real
 * `opencode.db` (#46 asks for one) — a real database that disagrees names
 * its unmapped parts in the import report rather than passing silently.
 */

import { createHash } from "node:crypto";
import type { DraftEvent, Json } from "../format/events.js";
import { looksLikeSqlite, rowsOf, SqliteError, SqliteFile, type SqliteValue } from "../sqlite.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "opencode";
const ADAPTER_VERSION = "0.2.0";

type Rec = { [k: string]: Json };

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: Json | SqliteValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: Json | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Epoch milliseconds from a row or a JSON field, or null when it is not one. */
function ms(v: SqliteValue | Json | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

const MIN_TS_MS = -62167219200000;
const MAX_TS_MS = 253402300799999;

function isoTs(v: number | null): string | null {
  if (v === null || v < MIN_TS_MS || v > MAX_TS_MS) return null;
  return new Date(v).toISOString();
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  projectId: string | null;
  model: Rec | undefined;
  timeCreated: number | null;
}

interface MessageRow {
  id: string;
  sessionId: string;
  timeCreated: number | null;
  data: Rec;
}

interface PartRow {
  id: string;
  messageId: string;
  timeCreated: number | null;
  data: Rec;
}

/** A JSON column, or undefined when it is not one — the caller counts. */
function jsonColumn(v: SqliteValue | undefined): Rec | undefined {
  if (typeof v !== "string") return undefined;
  try {
    return asRec(JSON.parse(v));
  } catch {
    return undefined;
  }
}

interface Tables {
  sessions: Map<string, SessionRow>;
  messages: MessageRow[];
  parts: Map<string, PartRow[]>;
  unreadable: { messages: number; parts: number };
}

function readTables(bytes: Uint8Array): Tables {
  const db = new SqliteFile(bytes);
  const need = (name: string, columns: string[]) => {
    const t = db.table(name);
    if (t === undefined || !columns.every((c) => t.columns.includes(c))) {
      throw new Error(`this SQLite database has no OpenCode \`${name}\` table; not an opencode.db`);
    }
    return t;
  };
  const sessionT = need("session", ["id", "directory", "title", "version", "time_created"]);
  const messageT = need("message", ["id", "session_id", "time_created", "data"]);
  const partT = need("part", ["id", "message_id", "session_id", "time_created", "data"]);

  const sessions = new Map<string, SessionRow>();
  for (const r of rowsOf(db, sessionT)) {
    const id = str(r.id);
    if (id === null) continue;
    sessions.set(id, {
      id,
      directory: str(r.directory),
      title: str(r.title),
      version: str(r.version),
      projectId: str(r.project_id),
      model: jsonColumn(r.model),
      timeCreated: ms(r.time_created),
    });
  }
  const unreadable = { messages: 0, parts: 0 };
  const messages: MessageRow[] = [];
  for (const r of rowsOf(db, messageT)) {
    const id = str(r.id);
    const sessionId = str(r.session_id);
    const data = jsonColumn(r.data);
    if (id === null || sessionId === null) continue;
    if (data === undefined) {
      unreadable.messages++;
      continue;
    }
    messages.push({ id, sessionId, timeCreated: ms(r.time_created), data });
  }
  const parts = new Map<string, PartRow[]>();
  for (const r of rowsOf(db, partT)) {
    const id = str(r.id);
    const messageId = str(r.message_id);
    const data = jsonColumn(r.data);
    if (id === null || messageId === null) continue;
    if (data === undefined) {
      unreadable.parts++;
      continue;
    }
    const list = parts.get(messageId) ?? [];
    list.push({ id, messageId, timeCreated: ms(r.time_created), data });
    parts.set(messageId, list);
  }
  return { sessions, messages, parts, unreadable };
}

/** SPEC §1 wants a session id that is a safe directory name; OpenCode's `ses_…` ids are, but the rule is checked, not assumed. */
function sessionIdFor(nativeId: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(nativeId) && nativeId !== "." && nativeId !== "..") return nativeId;
  return `opencode-${createHash("sha256").update(nativeId, "utf8").digest("hex").slice(0, 12)}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const opencodeAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  /** Never text: OpenCode's log is a database. */
  detect(): boolean {
    return false;
  },

  convert(): ConvertResult {
    throw new Error("the OpenCode adapter reads opencode.db, not text; use convertBytes");
  },

  detectBytes(bytes: Uint8Array): boolean {
    if (!looksLikeSqlite(bytes)) return false;
    try {
      const db = new SqliteFile(bytes);
      const has = (name: string, cols: string[]) => {
        const t = db.table(name);
        return t !== undefined && cols.every((c) => t.columns.includes(c));
      };
      return (
        has("session", ["id", "directory", "version"]) &&
        has("message", ["id", "session_id", "data"]) &&
        has("part", ["id", "message_id", "data"])
      );
    } catch {
      return false;
    }
  },

  sessionsIn(bytes: Uint8Array): string[] {
    // Sessions with messages; an empty session is nothing to import.
    const t = readTables(bytes);
    const withMessages = new Set(t.messages.map((m) => m.sessionId));
    return [...t.sessions.keys()].filter((id) => withMessages.has(id)).sort(cmp);
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
    const ids = opencodeAdapter.sessionsIn!(bytes);
    if (ids.length === 0) throw new Error("this opencode.db holds no session with messages");
    let sessionId: string;
    if (opts?.select !== undefined) {
      if (!ids.includes(opts.select)) {
        throw new Error(
          `no session ${JSON.stringify(opts.select)} in this database; sessions: ${ids.join(", ")}`,
        );
      }
      sessionId = opts.select;
    } else if (ids.length === 1) {
      sessionId = ids[0]!;
    } else {
      throw new Error(
        `this database holds ${ids.length} sessions; pass --thread <id> to pick one: ${ids.join(", ")}`,
      );
    }
    const session = t.sessions.get(sessionId)!;
    if (t.unreadable.messages > 0) skip("message-row-unreadable", t.unreadable.messages);
    if (t.unreadable.parts > 0) skip("part-row-unreadable", t.unreadable.parts);

    // The order OpenCode itself reads: messages by (time_created, id), parts by id.
    const messages = t.messages
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => (a.timeCreated ?? 0) - (b.timeCreated ?? 0) || cmp(a.id, b.id));
    const drafts: DraftEvent[] = [];
    const firstTs = isoTs(session.timeCreated) ?? isoTs(messages[0]?.timeCreated ?? null);
    if (firstTs === null) throw new Error(`session ${sessionId} carries no timestamp agit can read`);
    let ts: string = firstTs;

    const sessionModel = session.model;
    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime: "opencode",
        runtimeVersion: session.version,
        nativeSessionId: sessionId,
        cwd: session.directory,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: {
          ...(session.title !== null ? { title: session.title } : {}),
          ...(session.projectId !== null ? { projectId: session.projectId } : {}),
          ...(sessionModel !== undefined
            ? { model: { id: str(sessionModel.id), providerId: str(sessionModel.providerID) } }
            : {}),
        },
      },
    });

    let inherited = 0;
    const stamp = (v: number | null): string => {
      const iso = isoTs(v);
      if (iso === null) {
        inherited++;
        return ts;
      }
      ts = iso;
      return iso;
    };

    for (const m of messages) {
      const role = str(m.data.role);
      const time = asRec(m.data.time);
      const mts = stamp(ms(time?.created) ?? m.timeCreated);
      const parts = [...(t.parts.get(m.id) ?? [])].sort((a, b) => cmp(a.id, b.id));
      const native: Rec = { messageId: m.id };

      if (role === "user") {
        const texts: string[] = [];
        for (const p of parts) {
          const type = str(p.data.type);
          if (type === "text") {
            if (p.data.synthetic === true) skip("text-part-synthetic");
            else if (p.data.ignored === true) skip("text-part-ignored");
            else texts.push(str(p.data.text) ?? "");
          } else {
            skip(`part:${type ?? "(untyped)"}`);
          }
        }
        const text = texts.join("\n");
        if (text !== "") drafts.push({ ts: mts, type: "message.user", payload: { text, native } });
        continue;
      }

      if (role !== "assistant") {
        skip(`message-role:${role ?? "(absent)"}`);
        continue;
      }

      const model = str(m.data.modelID);
      const blocks: Json[] = [];
      const after: DraftEvent[] = [];
      let stepFinishes = 0;
      for (const p of parts) {
        const type = str(p.data.type);
        if (type === "text") {
          const text = str(p.data.text) ?? "";
          if (p.data.synthetic === true) skip("text-part-synthetic");
          else if (p.data.ignored === true) skip("text-part-ignored");
          else if (text !== "") blocks.push({ type: "text", text });
        } else if (type === "reasoning") {
          const text = str(p.data.text) ?? "";
          if (text !== "") blocks.push({ type: "thinking", text });
        } else if (type === "tool") {
          const state = asRec(p.data.state);
          const status = str(state?.status);
          const callId = str(p.data.callID);
          if (callId === null) skip("tool-part-without-call-id");
          const stime = asRec(state?.time);
          const cts = stamp(ms(stime?.start) ?? p.timeCreated);
          const input = asRec(state?.input) ?? {};
          after.push({
            ts: cts,
            type: "tool.call",
            payload: {
              toolUseId: callId,
              name: str(p.data.tool) ?? "unknown",
              input,
              native: { ...native, partId: p.id },
            },
          });
          if (status === "completed" || status === "error") {
            const rts = stamp(ms(stime?.end) ?? p.timeCreated);
            after.push({
              ts: rts,
              type: "tool.result",
              payload: {
                toolUseId: callId,
                isError: status === "error",
                output: status === "error" ? (str(state?.error) ?? "") : (str(state?.output) ?? ""),
                structured: null,
                native: {
                  ...native,
                  partId: p.id,
                  ...(str(state?.title) !== null ? { title: str(state?.title) } : {}),
                },
              },
            });
          } else {
            skip(`tool-part-${status ?? "without-state"}`);
          }
        } else if (type === "step-finish") {
          stepFinishes++;
          const tokens = asRec(p.data.tokens);
          const cache = asRec(tokens?.cache);
          if (typeof p.data.cost === "number") skip("cost-usd-not-stored (SPEC §5.9)");
          after.push({
            ts: stamp(p.timeCreated),
            type: "cost",
            payload: {
              model,
              usage: {
                inputTokens: num(tokens?.input),
                outputTokens: num(tokens?.output),
                cacheReadInputTokens: num(cache?.read),
                cacheCreationInputTokens: num(cache?.write),
              },
              native: {
                messageId: m.id,
                requestId: null,
                partId: p.id,
                reasoningTokens: num(tokens?.reasoning),
                ...(str(p.data.reason) !== null ? { reason: str(p.data.reason) } : {}),
              },
            },
          });
        } else {
          skip(`part:${type ?? "(untyped)"}`);
        }
      }
      if (blocks.length > 0) {
        drafts.push({
          ts: mts,
          type: "message.assistant",
          payload: {
            model,
            blocks,
            stopReason: str(m.data.finish),
            native: {
              ...native,
              ...(str(m.data.providerID) !== null ? { providerId: str(m.data.providerID) } : {}),
              ...(str(m.data.agent) !== null ? { agent: str(m.data.agent) } : {}),
            },
          },
        });
      }
      drafts.push(...after);
      // A message whose usage was never broken into steps still records it once.
      const tokens = asRec(m.data.tokens);
      if (stepFinishes === 0 && tokens !== undefined) {
        const cache = asRec(tokens.cache);
        if (typeof m.data.cost === "number") skip("cost-usd-not-stored (SPEC §5.9)");
        drafts.push({
          ts: stamp(ms(time?.completed) ?? null),
          type: "cost",
          payload: {
            model,
            usage: {
              inputTokens: num(tokens.input),
              outputTokens: num(tokens.output),
              cacheReadInputTokens: num(cache?.read),
              cacheCreationInputTokens: num(cache?.write),
            },
            native: { messageId: m.id, requestId: null, reasoningTokens: num(tokens.reasoning) },
          },
        });
      }
    }
    if (inherited > 0) skip("timestamp-inherited", inherited);

    if (!opts?.live) {
      drafts.push({ ts, type: "session.end", payload: { reason: "messages-end", synthesized: true } });
    }
    return { sessionId: sessionIdFor(sessionId), drafts, records: messages.length, skipped };
  },
};
