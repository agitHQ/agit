/**
 * Adapter for Kimi Code CLI's wire log (#64, #119).
 *
 * Kimi Code CLI (MoonshotAI/kimi-cli) keeps a session under
 * `~/.kimi/sessions/<md5 of the work dir>/<session id>/` — `context.jsonl`
 * (the model context), `state.json`, and `wire.jsonl`, "Wire events during
 * the session … used for session replay" (docs/en/configuration/
 * data-locations.md; `KIMI_SHARE_DIR` moves the root). The wire log is the
 * one with timestamps, so it is the one read here. Every shape below is
 * from the runtime's own source:
 *
 *   - the file, from src/kimi_cli/wire/file.py: line one is
 *     `{ "type": "metadata", "protocol_version" }` (`WireFileMetadata`),
 *     every other line a `WireMessageRecord` — `{ "timestamp": <epoch
 *     seconds>, "message": { "type": <class name>, "payload": {…} } }`,
 *     the envelope being `model_dump(mode="json")` of the wire message
 *     (`WireMessageEnvelope` in src/kimi_cli/wire/types.py);
 *   - the messages, from wire/types.py and the kosong package beside it
 *     (packages/kosong/src/kosong/message.py, tooling/__init__.py,
 *     chat_provider/__init__.py): `TurnBegin` / `SteerInput` carry
 *     `user_input` (a string or content parts); `StepBegin` carries `n`;
 *     `TextPart` (`text`) and `ThinkPart` (`think`, `encrypted`) stream
 *     the assistant's output in pieces that merge in order (`TextPart.
 *     merge_in_place`); `ToolCall` is `{ id, function: { name, arguments } }`
 *     with `arguments` a JSON string, and a following `ToolCallPart`
 *     appends `arguments_part` to it; `ToolResult` is `{ tool_call_id,
 *     return_value: { is_error, output, message, display } }`;
 *     `StatusUpdate` carries `token_usage` — `{ input_other, output,
 *     input_cache_read, input_cache_creation }` — for the current step,
 *     and `message_id`; `TurnEnd`, `StepInterrupted`, `StepRetry`,
 *     compaction, MCP, hook, approval, question, notification, plan and
 *     subagent events are the rest of the union;
 *   - the turn structure, from src/kimi_cli/ui/shell/replay.py, which
 *     rebuilds a session from this file the same way: a `TurnBegin` (or
 *     `SteerInput`) opens a turn, the events until the next one belong to
 *     it, and a `/clear` or `/reset` turn drops everything before it.
 *
 * Mapping: `TurnBegin` / `SteerInput` → `message.user`; within a step, the
 * merged `ThinkPart`s → a thinking block and the merged `TextPart`s → a text
 * block of one `message.assistant`, each `ToolCall` (with its parts folded
 * in) → `tool.call`, each `ToolResult` → `tool.result` (`output` flattened
 * to text, `is_error`), and the step's `token_usage` → one `cost`, dated by
 * the `StatusUpdate` that carried it. The wire names no model, so `model`
 * is null. A step interrupted or retried keeps what streamed before the
 * interruption, counted. Every other message type is counted by name, as
 * is a `display` block on a result (a `DiffDisplayBlock` is a viewer's
 * excerpt of an edit — `old_text`, `new_text`, start lines, `is_summary` —
 * not the file, so nothing is hashed from it).
 *
 * **No `file.diff`**, then: an edit is a tool call whose result is prose
 * plus a display excerpt, and no file content is recorded beside it.
 * **The session id is the directory name** (docs: "each session
 * corresponds to a subdirectory named with the session ID"), read from
 * `ConvertOptions.path`; without a path it is derived from the first
 * turn's record (`kimi-<sha256 prefix>`), deterministically, and the
 * report says so. Timestamps are the records' own, epoch seconds to
 * millisecond UTC. Derived from the source above and validated against a
 * fixture built to it; a real wire log that disagrees names its unmapped
 * messages in the import report.
 */

import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "kimi-code";
const ADAPTER_VERSION = "0.2.0";

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

const MIN_TS_S = -62167219200;
const MAX_TS_S = 253402300799;

/** A record's `timestamp`, epoch seconds as a float, to millisecond UTC. */
function isoTs(v: Json | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < MIN_TS_S || v > MAX_TS_S) return null;
  return new Date(Math.round(v * 1000)).toISOString();
}

function parseLine(line: string): Rec | undefined {
  try {
    return asRec(JSON.parse(line));
  } catch {
    return undefined;
  }
}

interface WireRecord {
  ts: number | null;
  type: string;
  payload: Rec;
}

function recordOf(r: Rec): WireRecord | undefined {
  const message = asRec(r.message);
  const type = str(message?.type);
  const payload = asRec(message?.payload);
  if (type === null || payload === undefined) return undefined;
  return { ts: typeof r.timestamp === "number" ? r.timestamp : null, type, payload };
}

/** Content parts (kosong `ContentPart`s) to text; the kinds that are not text are named. */
function partsText(v: Json | undefined, skip: (what: string) => void): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  const out: string[] = [];
  for (const part of v) {
    const p = asRec(part);
    if (p === undefined) {
      skip("content-part-unreadable");
      continue;
    }
    const type = str(p.type);
    if (type === "text" && typeof p.text === "string") out.push(p.text);
    else if (type === "think" && typeof p.think === "string") out.push(p.think);
    else skip(`content-part:${type ?? "(untyped)"}`);
  }
  return out.join("\n");
}

/** A tool call's `arguments` JSON string as an object; anything else is kept as text under `raw`. */
function argsOf(v: Json | undefined): Rec {
  if (typeof v !== "string") return {};
  try {
    const parsed = JSON.parse(v) as Json;
    const rec = asRec(parsed);
    return rec ?? { raw: v };
  } catch {
    return { raw: v };
  }
}

/** The session id the directory carries; null when there is no path or it does not look like one. */
function sessionIdFromPath(path: string | undefined): string | null {
  if (path === undefined) return null;
  const dir = basename(dirname(path));
  return /^[A-Za-z0-9._-]+$/.test(dir) && dir !== "." && dir !== ".." ? dir : null;
}

/** A user's `/clear` or `/reset`, which replay.py treats as dropping everything before it. */
function isClear(userInput: Json | undefined): boolean {
  const text = partsText(userInput, () => undefined).trim();
  return /^\/(clear|reset)(\s|$)/.test(text);
}

interface Step {
  ts: string;
  text: string;
  think: string;
  calls: { ts: string; id: string | null; name: string; args: string | null }[];
  usage: Rec | null;
  usageTs: string | null;
  messageId: string | null;
}

export const kimiCodeAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  /** Line one is the wire metadata; nothing else agit reads opens that way. */
  detect(lines: string[]): boolean {
    const first = lines.find((l) => l.trim() !== "");
    if (first === undefined) return false;
    const r = parseLine(first);
    return r !== undefined && r.type === "metadata" && typeof r.protocol_version === "string";
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    const nonEmpty = lines.filter((l) => l.trim() !== "");
    let protocolVersion: string | null = null;
    const records: WireRecord[] = [];
    for (const line of nonEmpty) {
      const r = parseLine(line);
      if (r === undefined) {
        skip("unparseable-line");
        continue;
      }
      if (r.type === "metadata") {
        protocolVersion = str(r.protocol_version);
        continue;
      }
      const rec = recordOf(r);
      if (rec === undefined) {
        skip("record-without-message");
        continue;
      }
      records.push(rec);
    }

    // replay.py: a `/clear` or `/reset` turn drops everything before it.
    let from = 0;
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      if (r.type === "TurnBegin" && isClear(r.payload.user_input)) {
        skip("cleared-record", i + 1 - from);
        from = i + 1;
      }
    }
    const kept = records.slice(from);
    const firstTs = kept.map((r) => isoTs(r.ts)).find((t) => t !== null) ?? null;
    if (firstTs === null) throw new Error("this wire log carries no timestamp agit can read");

    const fromPath = sessionIdFromPath(opts?.path);
    const sessionId =
      fromPath ??
      `kimi-${createHash("sha256")
        .update(JSON.stringify(kept[0] ?? null), "utf8")
        .digest("hex")
        .slice(0, 12)}`;
    if (fromPath === null) skip("session-id-derived-without-path");

    let ts = firstTs;
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

    const drafts: DraftEvent[] = [];
    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime: "kimi-code",
        // The wire records its protocol version, not the CLI's.
        runtimeVersion: null,
        nativeSessionId: sessionId,
        // The work directory is the md5 of the directory the session sits
        // under, resolved through ~/.kimi/kimi.json — not in this file.
        cwd: null,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: { ...(protocolVersion !== null ? { protocolVersion } : {}) },
      },
    });

    // One step at a time: text and thinking pieces merge, tool calls fold
    // their parts, and the step's usage becomes its cost when it closes.
    let step: Step | null = null;
    const openStep = (at: number | null): Step => ({
      ts: stamp(at),
      text: "",
      think: "",
      calls: [],
      usage: null,
      usageTs: null,
      messageId: null,
    });
    const closeStep = (): void => {
      if (step === null) return;
      const blocks: Json[] = [];
      if (step.think !== "") blocks.push({ type: "thinking", text: step.think });
      if (step.text !== "") blocks.push({ type: "text", text: step.text });
      const native: Rec = step.messageId !== null ? { messageId: step.messageId } : {};
      if (blocks.length > 0) {
        drafts.push({
          ts: step.ts,
          type: "message.assistant",
          payload: { model: null, blocks, stopReason: null, native },
        });
      }
      for (const c of step.calls) {
        if (c.id === null) skip("tool-call-without-id");
        drafts.push({
          ts: c.ts,
          type: "tool.call",
          payload: { toolUseId: c.id, name: c.name, input: argsOf(c.args), native },
        });
      }
      if (step.usage !== null) {
        drafts.push({
          ts: step.usageTs ?? step.ts,
          type: "cost",
          payload: {
            model: null,
            usage: {
              inputTokens: num(step.usage.input_other),
              outputTokens: num(step.usage.output),
              cacheReadInputTokens: num(step.usage.input_cache_read),
              cacheCreationInputTokens: num(step.usage.input_cache_creation),
            },
            native: { messageId: step.messageId, requestId: null },
          },
        });
      }
      step = null;
    };

    for (const r of kept) {
      const p = r.payload;
      switch (r.type) {
        case "TurnBegin":
        case "SteerInput": {
          closeStep();
          const text = partsText(p.user_input, skip);
          const uts = stamp(r.ts);
          if (text !== "") drafts.push({ ts: uts, type: "message.user", payload: { text, native: {} } });
          break;
        }
        case "StepBegin":
          closeStep();
          step = openStep(r.ts);
          break;
        case "TextPart":
          step ??= openStep(r.ts);
          step.text += str(p.text) ?? "";
          break;
        case "ThinkPart":
          step ??= openStep(r.ts);
          step.think += str(p.think) ?? "";
          break;
        case "ToolCall": {
          step ??= openStep(r.ts);
          const fn = asRec(p.function);
          step.calls.push({
            ts: stamp(r.ts),
            id: str(p.id),
            name: str(fn?.name) ?? "unknown",
            args: str(fn?.arguments),
          });
          break;
        }
        case "ToolCallPart": {
          const last = step?.calls[step.calls.length - 1];
          if (last === undefined) {
            skip("tool-call-part-without-call");
            break;
          }
          last.args = (last.args ?? "") + (str(p.arguments_part) ?? "");
          break;
        }
        case "ToolResult": {
          // A result answers a call the step already made: the step's
          // message, calls and cost go out first, then the result.
          closeStep();
          const rv = asRec(p.return_value);
          const rts = stamp(r.ts);
          const message = str(rv?.message);
          drafts.push({
            ts: rts,
            type: "tool.result",
            payload: {
              toolUseId: str(p.tool_call_id),
              isError: rv?.is_error === true,
              output: partsText(rv?.output, skip),
              structured: null,
              native: { ...(message !== null && message !== "" ? { message } : {}) },
            },
          });
          for (const d of Array.isArray(rv?.display) ? rv.display : []) {
            skip(`display-block:${str(asRec(d)?.type) ?? "(untyped)"}`);
          }
          break;
        }
        case "StatusUpdate": {
          const usage = asRec(p.token_usage);
          const messageId = str(p.message_id);
          if (usage !== undefined) {
            step ??= openStep(r.ts);
            step.usage = usage;
            step.usageTs = stamp(r.ts);
          }
          if (messageId !== null && step !== null) step.messageId = messageId;
          break;
        }
        case "TurnEnd":
          closeStep();
          break;
        case "StepInterrupted":
        case "StepRetry":
          skip(`step:${r.type === "StepInterrupted" ? "interrupted" : "retried"}`);
          closeStep();
          break;
        default:
          skip(`message-type:${r.type}`);
      }
    }
    closeStep();
    if (inherited > 0) skip("timestamp-inherited", inherited);

    if (!opts?.live) {
      drafts.push({ ts, type: "session.end", payload: { reason: "wire-end", synthesized: true } });
    }
    return { sessionId, drafts, records: nonEmpty.length, skipped };
  },
};
