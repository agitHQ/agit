/**
 * Adapter for Gemini CLI session recordings (#61, #117).
 *
 * Gemini CLI records a conversation through `ChatRecordingService`
 * (packages/core/src/services/chatRecordingService.ts in
 * google-gemini/gemini-cli), one JSON record per line, under
 * `~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl`
 * (a subagent's under `chats/<parent session id>/<id>.jsonl`;
 * `Storage.getProjectTempDir()` in packages/core/src/config/storage.ts).
 * Every shape below is from `chatRecordingTypes.ts` and the service's own
 * writer and loader:
 *
 *   - the first line is the metadata (`PartialMetadataRecord`):
 *     `sessionId`, `projectHash`, `startTime`, `lastUpdated`, `kind`
 *     (`main` | `subagent`), `directories`;
 *   - a `MessageRecord` is `{ id, timestamp, content, displayContent? }` plus
 *     `type: "user" | "info" | "error" | "warning"`, or `type: "gemini"` with
 *     `toolCalls?: ToolCallRecord[]`, `thoughts?: ThoughtSummary[]`,
 *     `tokens?: TokensSummary`, `model?`;
 *   - `content` is `@google/genai`'s `PartListUnion`: a string, a Part, or a
 *     list of either — a Part with `text` is text, and `functionCall`,
 *     `functionResponse`, `inlineData`, `fileData` and the rest are other
 *     kinds, counted here by key;
 *   - a `ToolCallRecord` is `{ id, name, args, result?, status, timestamp }`
 *     with `status` from `CoreToolCallStatus` (packages/core/src/scheduler/
 *     types.ts): `success`, `error`, `cancelled`, or one of the in-flight
 *     states `validating`, `scheduled`, `executing`, `awaiting_approval`;
 *   - `TokensSummary` is `{ input, output, cached, thoughts?, tool?, total }`
 *     — `promptTokenCount`, `candidatesTokenCount` and
 *     `cachedContentTokenCount` from the API response, by the writer's own
 *     comments;
 *   - `{ $set: { … } }` updates the metadata (and, with `messages`, replaces
 *     the whole message list); `{ $rewindTo: id }` drops that message and
 *     every one after it.
 *
 * **The file is a log of upserts, not of events.** `pushMessage` appends the
 * whole message again whenever it changes: once when it is created, again
 * when its tokens arrive, again as each tool call is added or its status
 * moves. The loader (`loadConversationRecord`) folds those by `id`, keeping
 * a message at the position of its first appearance with the content of its
 * last, and this adapter folds the same way. Only the *last* message of a
 * conversation is ever re-pushed (`getLastMessage`), so under
 * `ConvertOptions.live` the last message is held back until a newer one
 * appears: what has been streamed cannot then change under a viewer. A
 * `$rewindTo` rewrites history by design, and a live share of a session
 * that rewinds stops as a rewrite of streamed history, which it is.
 *
 * Mapping: a `user` message's text parts → `message.user`; a `gemini`
 * message's `thoughts` → thinking blocks (`subject`, then `description`),
 * its text parts → text blocks, each `toolCalls[]` entry → `tool.call`
 * (`id`, `name`, `args`) and, when its status is `success` or `error`, a
 * `tool.result` from `result` (the `functionResponse.response` the model was
 * given, flattened to text); its `tokens` → one `cost` (`input`, `output`,
 * `cached` as cache reads; `thoughts` and `tool` counts under `native`).
 * `info`, `error` and `warning` messages, in-flight or cancelled tool
 * calls, and content parts of other kinds are counted by name.
 *
 * **No `file.diff`.** A file edit is a tool call whose result is the tool's
 * prose; Gemini CLI records no file content beside it, so nothing is hashed
 * and `blame`, `why`, `fork`, `merge` and `diff` have nothing to work with.
 * Timestamps are the records' own (`timestamp` on messages and tool calls,
 * `startTime` on the session), ISO strings the writer produced with
 * `toISOString()`. Derived from the source above and validated against a
 * fixture built to it; a real recording that disagrees names its unmapped
 * records in the import report.
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "gemini-cli";
const ADAPTER_VERSION = "0.2.0";

/** `CoreToolCallStatus` values that mean the call has run to an end. */
const FINISHED = new Set(["success", "error"]);
const IN_FLIGHT = new Set(["validating", "scheduled", "executing", "awaiting_approval"]);

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

/** An ISO timestamp the writer produced, or null: the caller inherits and counts. */
function isoTs(v: Json | undefined): string | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseLine(line: string): Rec | undefined {
  try {
    return asRec(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function isMetadata(r: Rec): boolean {
  return typeof r.sessionId === "string" && typeof r.projectHash === "string";
}

function isMessage(r: Rec): boolean {
  return typeof r.id === "string";
}

/**
 * The text of a `PartListUnion`, and the kinds of part that are not text.
 * A part is a text part when it carries `text` (the loader's own `isTextPart`).
 */
function partsText(content: Json | undefined, skip: (what: string) => void): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    const p = asRec(part);
    if (p === undefined) {
      skip("content-part-unreadable");
      continue;
    }
    if (typeof p.text === "string") {
      texts.push(p.text);
      continue;
    }
    const kind = Object.keys(p).find((k) => k !== "thought" && k !== "thoughtSignature") ?? "(empty)";
    skip(`content-part:${kind}`);
  }
  return texts.join("\n");
}

/**
 * A tool call's `result` as the text the model saw: `functionResponse.response`
 * is what Gemini CLI hands back, an object whose `output` (or `error`) is the
 * tool's text; anything else is serialized as it is.
 */
function resultText(result: Json | undefined): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  const parts = Array.isArray(result) ? result : [result];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      out.push(part);
      continue;
    }
    const p = asRec(part);
    const fr = asRec(p?.functionResponse);
    if (fr !== undefined) {
      const response = asRec(fr.response);
      const text = str(response?.output) ?? str(response?.error);
      out.push(text ?? JSON.stringify(fr.response ?? null));
    } else if (typeof p?.text === "string") {
      out.push(p.text);
    } else {
      out.push(JSON.stringify(part));
    }
  }
  return out.join("\n");
}

interface Folded {
  metadata: Rec;
  messages: Rec[];
}

/**
 * The loader's fold: the first metadata line, `$set` merged over it (with
 * `messages` replacing the list), a message upserted by `id` at its first
 * position, `$rewindTo` dropping that id and everything after — or the whole
 * list when the id is unknown, as the loader does.
 */
function fold(lines: string[], skip: (what: string, n?: number) => void): Folded {
  let metadata: Rec = {};
  const order: string[] = [];
  const byId = new Map<string, Rec>();
  const replaceAll = (list: Json): void => {
    order.length = 0;
    byId.clear();
    if (!Array.isArray(list)) return;
    for (const m of list) {
      const r = asRec(m);
      if (r !== undefined && isMessage(r)) {
        const id = r.id as string;
        if (!byId.has(id)) order.push(id);
        byId.set(id, r);
      }
    }
  };
  for (const line of lines) {
    const r = parseLine(line);
    if (r === undefined) {
      skip("unparseable-line");
      continue;
    }
    if (typeof r.$rewindTo === "string") {
      const idx = order.indexOf(r.$rewindTo);
      const dropped = idx === -1 ? order.splice(0) : order.splice(idx);
      for (const id of dropped) byId.delete(id);
      skip("rewind-dropped-message", dropped.length);
      continue;
    }
    if (isMessage(r)) {
      const id = r.id as string;
      if (!byId.has(id)) order.push(id);
      byId.set(id, r);
      continue;
    }
    const set = asRec(r.$set);
    if (set !== undefined) {
      if (set.messages !== undefined) replaceAll(set.messages);
      metadata = { ...metadata, ...set };
      continue;
    }
    if (isMetadata(r)) {
      metadata = { ...metadata, ...r };
      if (Array.isArray(r.messages)) replaceAll(r.messages);
      continue;
    }
    skip("unknown-record");
  }
  return { metadata, messages: order.map((id) => byId.get(id)!) };
}

/** A legacy single-document `.json` recording: the whole `ConversationRecord` at once. */
function legacyDocument(lines: string[]): Rec | undefined {
  const doc = parseLine(lines.join("\n"));
  return doc !== undefined && isMetadata(doc) && Array.isArray(doc.messages) ? doc : undefined;
}

export const geminiCliAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  /**
   * The first line names the session and its project hash — no other format
   * agit reads opens that way — or the file is one legacy document doing the
   * same. Cline SDK documents carry `sessionId` too but never `projectHash`.
   */
  detect(lines: string[]): boolean {
    const first = lines.find((l) => l.trim() !== "");
    if (first === undefined) return false;
    const r = parseLine(first);
    if (r !== undefined && isMetadata(r)) return true;
    return legacyDocument(lines) !== undefined;
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    const legacy = legacyDocument(lines);
    const { metadata, messages } =
      legacy !== undefined ? fold([JSON.stringify(legacy)], skip) : fold(lines, skip);
    const sessionId = str(metadata.sessionId);
    if (sessionId === null) throw new Error("not a Gemini CLI recording: no sessionId in its metadata");

    // The start, from the first metadata line. Fields the writer updates
    // later (`lastUpdated`, `summary`) stay out: session.start must not
    // change as the recording grows.
    let ts = isoTs(metadata.startTime);
    let inherited = 0;
    const stamp = (v: Json | undefined): string => {
      const iso = isoTs(v);
      if (iso === null) {
        inherited++;
        if (ts === null) throw new Error("this recording carries no timestamp agit can read");
        return ts;
      }
      ts = iso;
      return iso;
    };
    if (ts === null) {
      // No startTime: the first message dates the session, counted.
      const first = messages.map((m) => isoTs(m.timestamp)).find((t) => t !== null) ?? null;
      if (first === null) throw new Error("this recording carries no timestamp agit can read");
      ts = first;
      inherited++;
    }

    // Live: the last message is the one the writer re-pushes as tokens and
    // tool calls land, so it stays out until a newer message settles it.
    const settled = opts?.live ? messages.slice(0, -1) : messages;
    if (opts?.live && messages.length > settled.length) skip("live-last-message-held", 1);

    const drafts: DraftEvent[] = [];
    const directories = Array.isArray(metadata.directories)
      ? metadata.directories.filter((d): d is string => typeof d === "string")
      : [];
    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime: "gemini-cli",
        // The recording names no CLI version. Absent, not guessed.
        runtimeVersion: null,
        nativeSessionId: sessionId,
        // A main session's recording carries no cwd; a subagent's lists its
        // workspace directories, the first of which is where it ran.
        cwd: directories[0] ?? null,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: {
          projectHash: str(metadata.projectHash),
          ...(str(metadata.kind) !== null ? { kind: str(metadata.kind) } : {}),
          ...(directories.length > 0 ? { directories } : {}),
        },
      },
    });

    for (const m of settled) {
      const id = m.id as string;
      const type = str(m.type);
      const mts = stamp(m.timestamp);
      if (type === "user") {
        const text = partsText(m.content, skip);
        if (text !== "")
          drafts.push({ ts: mts, type: "message.user", payload: { text, native: { messageId: id } } });
        continue;
      }
      if (type !== "gemini") {
        skip(`message-type:${type ?? "(absent)"}`);
        continue;
      }
      const model = str(m.model);
      const blocks: Json[] = [];
      for (const t of Array.isArray(m.thoughts) ? m.thoughts : []) {
        const th = asRec(t);
        if (th === undefined) {
          skip("thought-unreadable");
          continue;
        }
        const subject = str(th.subject) ?? "";
        const description = str(th.description) ?? "";
        const text = [subject, description].filter((s) => s !== "").join("\n");
        if (text !== "") blocks.push({ type: "thinking", text });
      }
      const text = partsText(m.content, skip);
      if (text !== "") blocks.push({ type: "text", text });
      if (blocks.length > 0) {
        drafts.push({
          ts: mts,
          type: "message.assistant",
          payload: { model, blocks, stopReason: null, native: { messageId: id } },
        });
      }
      // The cost of the model call that produced this message, before the
      // tool calls it made: the call was paid for first.
      const tokens = asRec(m.tokens);
      if (tokens !== undefined) {
        drafts.push({
          ts: mts,
          type: "cost",
          payload: {
            model,
            usage: {
              inputTokens: num(tokens.input),
              outputTokens: num(tokens.output),
              cacheReadInputTokens: num(tokens.cached),
              cacheCreationInputTokens: 0,
            },
            native: {
              messageId: id,
              requestId: null,
              ...(typeof tokens.thoughts === "number" ? { thoughtsTokens: tokens.thoughts } : {}),
              ...(typeof tokens.tool === "number" ? { toolTokens: tokens.tool } : {}),
            },
          },
        });
      }
      for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        const tc = asRec(c);
        if (tc === undefined) {
          skip("tool-call-unreadable");
          continue;
        }
        const callId = str(tc.id);
        if (callId === null) skip("tool-call-without-id");
        const status = str(tc.status);
        const cts = stamp(tc.timestamp);
        const args = asRec(tc.args) ?? {};
        drafts.push({
          ts: cts,
          type: "tool.call",
          payload: {
            toolUseId: callId,
            name: str(tc.name) ?? "unknown",
            input: args,
            native: { messageId: id },
          },
        });
        if (status !== null && FINISHED.has(status)) {
          drafts.push({
            ts: cts,
            type: "tool.result",
            payload: {
              toolUseId: callId,
              isError: status === "error",
              output: resultText(tc.result),
              structured: null,
              native: { messageId: id },
            },
          });
        } else if (status === "cancelled") {
          skip("tool-call-cancelled");
        } else if (status !== null && IN_FLIGHT.has(status)) {
          skip(`tool-call-${status}`);
        } else {
          skip(`tool-call-status:${status ?? "(absent)"}`);
        }
      }
    }
    if (inherited > 0) skip("timestamp-inherited", inherited);

    if (!opts?.live) {
      drafts.push({ ts, type: "session.end", payload: { reason: "recording-end", synthesized: true } });
    }
    return {
      sessionId,
      drafts,
      records: legacy !== undefined ? 1 : lines.filter((l) => l.trim() !== "").length,
      skipped,
    };
  },
};
