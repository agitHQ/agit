/**
 * Adapter for LangGraph's checkpoint database, as `langgraph-checkpoint-sqlite`
 * writes it (`SqliteSaver`): one thread's conversation, read from the state
 * snapshots the runtime itself persisted.
 *
 * Every field name below is from the runtime's own source, not from a
 * running install:
 *
 *   - the two tables, `checkpoints` and `writes`, from `SqliteSaver.setup()`
 *     in libs/checkpoint-sqlite (`thread_id`, `checkpoint_ns`,
 *     `checkpoint_id`, `parent_checkpoint_id`, `type`, `checkpoint`,
 *     `metadata`);
 *   - the `Checkpoint` TypedDict from libs/checkpoint (`v`, `id`, `ts`,
 *     `channel_values`, `channel_versions`, `versions_seen`) and
 *     `CheckpointMetadata` (`source`, `step`, `parents`), the latter stored
 *     as JSON by `put()`;
 *   - the serialization from `JsonPlusSerializer` (jsonplus.py): a
 *     checkpoint is `type = "msgpack"` and ormsgpack bytes, and every
 *     LangChain message inside it is extension type `EXT_PYDANTIC_V2` (5)
 *     wrapping msgpack of `(module, class name, model_dump(), method)`;
 *   - the message shapes from langchain_core's `model_dump()`: `type` of
 *     `human`, `ai`, `tool` or `system`; `content` as a string or a list of
 *     parts; on an AI message `tool_calls` (`name`, `args`, `id`),
 *     `invalid_tool_calls`, `usage_metadata` (`input_tokens`,
 *     `output_tokens`, `input_token_details.cache_read` /
 *     `cache_creation`) and `response_metadata.model_name`; on a tool
 *     message `tool_call_id` and `status` (`success` | `error`).
 *
 * The fixture under fixtures/langgraph was produced by that runtime
 * (langgraph 1.2.11, langgraph-checkpoint 4.2.0, langgraph-checkpoint-sqlite
 * 3.1.1, langchain-core 1.6.3) over a fake chat model, so every byte of it
 * is the writer's, not this adapter's guess.
 *
 * **What a checkpoint does not hold.** LangGraph has no file-edit construct:
 * a tool that writes a file is an ordinary tool call whose result is prose,
 * so no `file.diff` is emitted and `blame`, `why`, `fork`, `merge` and
 * `diff` have nothing to work with; `verify`, `replay`, `grep`, `show`,
 * `stats`, `sign`, `share --static`, `export` and the MCP server do. Nor
 * does a message carry a timestamp: the checkpoint that first contains it
 * does, so a message is dated by the checkpoint the step that produced it
 * wrote, and the count of messages dated that way is reported. There is no
 * cwd, no git branch and no runtime version in the database; all three are
 * null, not guessed.
 *
 * **What is read, and what is counted instead.** The thread's current
 * history: the parent chain from the root-namespace checkpoint the saver
 * itself would return as current (`get_tuple` orders by `checkpoint_id`
 * descending; ids are time-ordered UUID6s) back to the first. A checkpoint
 * off that chain (an abandoned branch after `update_state` against an older
 * checkpoint, or a fork) is counted, as is every checkpoint a subgraph
 * wrote under its own `checkpoint_ns`. The `messages` channel is the
 * conversation; a graph whose state has no such channel is refused by name.
 * A message of a type agit has no event for (`system`), a content part of
 * an unknown type, a serialized value this adapter cannot read, and a
 * checkpoint stored as anything but msgpack are each counted under their own
 * key. A `_DeltaSnapshot` (extension 7, the beta `DeltaChannel` feature)
 * is counted rather than reconstructed, because reconstructing one needs
 * the `writes` table walked the way the saver does it, and a wrong walk is
 * a wrong history.
 *
 * **One thread per session.** A database can hold many threads; `sessionsIn`
 * lists them and `agit import` takes each in turn unless `--thread <id>`
 * names one (`ConvertOptions.select`). `convertBytes` without a selection
 * serves a database holding exactly one thread and refuses, naming them,
 * otherwise. The session id is the thread id when SPEC §1 allows it as a
 * directory name, and a hash-suffixed form otherwise. A thread that is still being written keeps its newest
 * pages in the `-wal` sidecar until the process checkpoints them; the CLI
 * refuses such a file rather than read a stale main file as current.
 */

import { createHash } from "node:crypto";
import type { DraftEvent, Json } from "../format/events.js";
import { decodeMsgpack, MsgpackError, type MsgpackExt, type MsgpackValue } from "../msgpack.js";
import { looksLikeSqlite, rowsOf, SqliteError, SqliteFile, type SqliteValue } from "../sqlite.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "langgraph";
const ADAPTER_VERSION = "0.1.0";

/** jsonplus.py: the extension type a pydantic v2 model (every LangChain message) is wrapped in. */
const EXT_PYDANTIC_V2 = 5;
/** jsonplus.py: a DeltaChannel snapshot; the channel's value is elsewhere. */
const EXT_DELTA_SNAPSHOT = 7;

type Rec = { [k: string]: MsgpackValue };

function asRec(v: MsgpackValue | undefined): Rec | undefined {
  return v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array) &&
    !("$ext" in v)
    ? (v as Rec)
    : undefined;
}

function str(v: MsgpackValue | SqliteValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: MsgpackValue | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** msgpack values that are also JSON, for payloads; anything else is named by the caller. */
function toJson(v: MsgpackValue): Json | undefined {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return undefined;
  if (Array.isArray(v)) {
    const out: Json[] = [];
    for (const x of v) {
      const j = toJson(x);
      if (j === undefined) return undefined;
      out.push(j);
    }
    return out;
  }
  if ("$ext" in v) return undefined;
  const out: { [k: string]: Json } = {};
  for (const [k, x] of Object.entries(v)) {
    const j = toJson(x);
    if (j === undefined) return undefined;
    out[k] = j;
  }
  return out;
}

interface CheckpointRow {
  threadId: string;
  ns: string;
  id: string;
  parentId: string | null;
  type: string | null;
  blob: Uint8Array | null;
}

/**
 * The `checkpoints` table. The JSON `metadata` column beside each blob
 * (`source`, `step`, `parents`) is not needed to walk the history — the
 * parent chain and the checkpoint's own `ts` are — so it is left unread.
 */
function readCheckpoints(db: SqliteFile): CheckpointRow[] {
  const table = db.table("checkpoints");
  if (table === undefined)
    throw new Error("this SQLite database has no `checkpoints` table; not a LangGraph checkpointer");
  const out: CheckpointRow[] = [];
  for (const r of rowsOf(db, table)) {
    const threadId = str(r.thread_id);
    const id = str(r.checkpoint_id);
    if (threadId === null || id === null) continue;
    out.push({
      threadId,
      ns: str(r.checkpoint_ns) ?? "",
      id,
      parentId: str(r.parent_checkpoint_id),
      type: str(r.type),
      blob: r.checkpoint instanceof Uint8Array ? r.checkpoint : null,
    });
  }
  return out;
}

/** SPEC §1 allows a session id that is a safe directory name; a thread id is anything. */
function sessionIdFor(threadId: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(threadId) && threadId !== "." && threadId !== "..") return threadId;
  return `langgraph-${createHash("sha256").update(threadId, "utf8").digest("hex").slice(0, 12)}`;
}

/** The checkpoint's `ts` is isoformat() with microseconds and an offset; agit's is millisecond UTC. */
function isoTs(v: MsgpackValue | undefined): string | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

interface Message {
  kind: string;
  id: string | null;
  dump: Rec;
}

/** Unwrap one EXT_PYDANTIC_V2 value: `(module, name, model_dump(), method)`. */
function messageOf(v: MsgpackValue): Message | null {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array || !("$ext" in v))
    return null;
  const ext = v as MsgpackExt;
  if (ext.$ext !== EXT_PYDANTIC_V2) return null;
  let inner: MsgpackValue;
  try {
    inner = decodeMsgpack(ext.data);
  } catch {
    return null;
  }
  if (!Array.isArray(inner) || inner.length < 3) return null;
  const dump = asRec(inner[2]);
  if (dump === undefined) return null;
  const kind = str(dump.type);
  if (kind === null) return null;
  return { kind, id: str(dump.id), dump };
}

/** Text from `content`: a string, or a list of parts whose text-bearing kinds are known. */
function contentText(
  content: MsgpackValue | undefined,
  skip: (what: string, n?: number) => void,
): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) skip("content-not-text-or-parts");
    return { text: "", thinking: "" };
  }
  const texts: string[] = [];
  const thoughts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    const p = asRec(part);
    if (p === undefined) {
      skip("content-part-unreadable");
      continue;
    }
    const type = str(p.type);
    if (type === "text") {
      const t = str(p.text);
      if (t === null) skip("content-part-text-without-text");
      else texts.push(t);
    } else if (type === "thinking" || type === "reasoning") {
      // Anthropic's `thinking` and OpenAI's `reasoning` blocks, as
      // langchain_core passes them through in content.
      const t = str(p.thinking) ?? str(p.reasoning) ?? str(p.text);
      if (t === null) skip(`content-part-${type}-without-text`);
      else thoughts.push(t);
    } else if (type === "tool_use") {
      // Anthropic-shaped content repeats each call as a block; the
      // normalized `tool_calls` field is the record, so this is not a loss.
    } else {
      skip(`content-part:${type ?? "(untyped)"}`);
    }
  }
  return { text: texts.join("\n"), thinking: thoughts.join("\n") };
}

export const langgraphAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  /** Never text: there are no lines to recognize. */
  detect(): boolean {
    return false;
  },

  convert(): ConvertResult {
    throw new Error("the LangGraph adapter reads a SQLite database, not text; use convertBytes");
  },

  /** A SQLite file whose schema has LangGraph's `checkpoints` table. */
  detectBytes(bytes: Uint8Array): boolean {
    if (!looksLikeSqlite(bytes)) return false;
    try {
      const t = new SqliteFile(bytes).table("checkpoints");
      return (
        t !== undefined &&
        ["thread_id", "checkpoint_id", "checkpoint", "metadata"].every((c) => t.columns.includes(c))
      );
    } catch {
      return false;
    }
  },

  sessionsIn(bytes: Uint8Array): string[] {
    return [...new Set(readCheckpoints(new SqliteFile(bytes)).map((r) => r.threadId))].sort();
  },

  convertBytes(bytes: Uint8Array, opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    let all: CheckpointRow[];
    try {
      all = readCheckpoints(new SqliteFile(bytes));
    } catch (err) {
      if (err instanceof SqliteError) {
        throw new Error(`cannot read this SQLite database: ${err.message}`, { cause: err });
      }
      throw err;
    }
    if (all.length === 0) throw new Error("this LangGraph checkpointer holds no checkpoints");

    // One thread per session.
    const threads = [...new Set(all.map((r) => r.threadId))].sort();
    let threadId: string;
    if (opts?.select !== undefined) {
      if (!threads.includes(opts.select)) {
        throw new Error(
          `no thread ${JSON.stringify(opts.select)} in this database; threads: ${threads.join(", ")}`,
        );
      }
      threadId = opts.select;
    } else if (threads.length === 1) {
      threadId = threads[0]!;
    } else {
      throw new Error(
        `this database holds ${threads.length} threads; pass --thread <id> to pick one: ${threads.join(", ")}`,
      );
    }
    const mine = all.filter((r) => r.threadId === threadId);

    // The root namespace is the graph itself; a subgraph checkpoints under
    // its own namespace, and its messages reach the parent's state through
    // the parent's own steps.
    const root = mine.filter((r) => r.ns === "");
    const sub = mine.length - root.length;
    if (sub > 0) skip("subgraph-checkpoint", sub);
    if (root.length === 0) throw new Error(`thread ${threadId} has no root-namespace checkpoints`);

    // The current history: the parent chain from the checkpoint the saver
    // itself treats as current — `get_tuple` without a checkpoint_id reads
    // `ORDER BY checkpoint_id DESC LIMIT 1`, and ids are time-ordered
    // UUID6s. Anything off that chain is an abandoned branch (update_state
    // against an older checkpoint, a fork), which the runtime keeps and
    // this import counts.
    const byId = new Map(root.map((r) => [r.id, r]));
    const newest = [...root].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).at(-1)!;
    const chain: CheckpointRow[] = [];
    const seen = new Set<string>();
    for (let cur: CheckpointRow | undefined = newest; cur !== undefined && !seen.has(cur.id);) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    chain.reverse();
    const offChain = root.length - chain.length;
    if (offChain > 0) skip("checkpoint-off-current-branch", offChain);

    // Decode each checkpoint on the chain; collect the messages that first
    // appear in each, dated by it.
    interface Dated {
      msg: Message;
      ts: string;
    }
    const dated: Dated[] = [];
    const seenMsg = new Set<string>();
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let checkpointFormat: number | null = null;
    let sawMessagesChannel = false;
    let inheritedTs = 0;
    for (const row of chain) {
      if (row.type !== "msgpack" || row.blob === null) {
        skip(`checkpoint-type:${row.type ?? "(none)"}`);
        continue;
      }
      let cp: Rec | undefined;
      try {
        cp = asRec(decodeMsgpack(row.blob));
      } catch (err) {
        if (err instanceof MsgpackError) {
          skip("checkpoint-unreadable");
          continue;
        }
        throw err;
      }
      if (cp === undefined) {
        skip("checkpoint-unreadable");
        continue;
      }
      if (checkpointFormat === null && typeof cp.v === "number") checkpointFormat = cp.v;
      const ts = isoTs(cp.ts);
      if (ts === null) {
        skip("checkpoint-without-timestamp");
        continue;
      }
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
      const values = asRec(cp.channel_values);
      const channel = values?.messages;
      if (channel === undefined) continue;
      if (
        channel !== null &&
        typeof channel === "object" &&
        !Array.isArray(channel) &&
        "$ext" in channel &&
        channel.$ext === EXT_DELTA_SNAPSHOT
      ) {
        skip("messages-delta-snapshot");
        continue;
      }
      if (!Array.isArray(channel)) {
        skip("messages-channel-not-a-list");
        continue;
      }
      sawMessagesChannel = true;
      for (const v of channel) {
        const msg = messageOf(v);
        if (msg === null) {
          skip("message-unreadable");
          continue;
        }
        if (msg.id !== null) {
          if (seenMsg.has(msg.id)) continue;
          seenMsg.add(msg.id);
        }
        dated.push({ msg, ts });
        inheritedTs++;
      }
    }
    if (firstTs === null || lastTs === null) {
      throw new Error("no checkpoint on this thread carries a timestamp agit can read");
    }
    if (!sawMessagesChannel) {
      throw new Error(
        "this thread's state has no `messages` channel; agit reads graphs whose state carries LangChain messages (MessagesState)",
      );
    }
    if (inheritedTs > 0) skip("message-timestamp-from-checkpoint", inheritedTs);

    const sessionId = sessionIdFor(threadId);
    const drafts: DraftEvent[] = [];
    drafts.push({
      ts: firstTs,
      type: "session.start",
      payload: {
        runtime: "langgraph",
        // Not recorded in the database: the checkpoint format version is,
        // and is kept under native as what it is.
        runtimeVersion: null,
        nativeSessionId: threadId,
        cwd: null,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: {
          threadId,
          checkpointFormat,
          rootCheckpointId: chain[0]!.id,
        },
      },
    });

    for (const { msg, ts } of dated) {
      const d = msg.dump;
      const native: { [k: string]: Json } = { messageId: msg.id };
      if (msg.kind === "human") {
        const { text } = contentText(d.content, skip);
        drafts.push({ ts, type: "message.user", payload: { text, native } });
      } else if (msg.kind === "ai") {
        const { text, thinking } = contentText(d.content, skip);
        const meta = asRec(d.response_metadata);
        const model = str(meta?.model_name) ?? str(meta?.model) ?? null;
        const blocks: Json[] = [];
        if (thinking !== "") blocks.push({ type: "thinking", text: thinking });
        if (text !== "") blocks.push({ type: "text", text });
        if (blocks.length > 0) {
          drafts.push({
            ts,
            type: "message.assistant",
            payload: { model, blocks, stopReason: null, native },
          });
        }
        const calls = Array.isArray(d.tool_calls) ? d.tool_calls : [];
        for (const c of calls) {
          const call = asRec(c);
          if (call === undefined) {
            skip("tool-call-unreadable");
            continue;
          }
          const id = str(call.id);
          if (id === null) skip("tool-call-without-id");
          const args = toJson(call.args ?? {});
          drafts.push({
            ts,
            type: "tool.call",
            payload: {
              toolUseId: id,
              name: str(call.name) ?? "unknown",
              input:
                args !== undefined && typeof args === "object" && args !== null && !Array.isArray(args)
                  ? args
                  : {},
              native,
            },
          });
        }
        const invalid = Array.isArray(d.invalid_tool_calls) ? d.invalid_tool_calls.length : 0;
        if (invalid > 0) skip("invalid-tool-call", invalid);
        const usage = asRec(d.usage_metadata);
        if (usage !== undefined) {
          const details = asRec(usage.input_token_details);
          drafts.push({
            ts,
            type: "cost",
            payload: {
              model,
              usage: {
                inputTokens: num(usage.input_tokens),
                outputTokens: num(usage.output_tokens),
                cacheReadInputTokens: num(details?.cache_read),
                cacheCreationInputTokens: num(details?.cache_creation),
              },
              native: { messageId: msg.id, requestId: null },
            },
          });
        }
      } else if (msg.kind === "tool") {
        const { text } = contentText(d.content, skip);
        const toolUseId = str(d.tool_call_id);
        if (toolUseId === null) skip("tool-result-without-id");
        drafts.push({
          ts,
          type: "tool.result",
          payload: {
            toolUseId,
            isError: str(d.status) === "error",
            output: text,
            structured: null,
            native: { ...native, ...(str(d.name) !== null ? { tool: str(d.name) } : {}) },
          },
        });
      } else {
        // `system`, and anything langchain_core adds later.
        skip(`message-type:${msg.kind}`);
      }
    }

    if (!opts?.live) {
      drafts.push({
        ts: lastTs,
        type: "session.end",
        payload: { reason: "checkpoints-end", synthesized: true },
      });
    }

    return { sessionId, drafts, records: mine.length, skipped };
  },
};
