/**
 * Adapter for OpenAI Codex CLI rollout logs
 * (~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl, observed at
 * cli_version 0.142.x).
 *
 * Mapping rules follow SPEC.md §6: linearize in native file order, preserve
 * native ids under payload.native, skip and count what cannot be mapped,
 * never guess. Built against a real 297-record rollout; every disambiguation
 * below was verified empirically there (issue #5):
 *
 * - `event_msg/agent_message` and `task_complete.last_agent_message`
 *   duplicate `response_item/message` role=assistant text for text — the
 *   response_item is canonical (it carries the response id), the others are
 *   skip-counted as duplicates.
 * - `event_msg/user_message` is the human's actual input;
 *   `response_item/message` role=user/developer/system is scaffolding
 *   (environment context, permissions preamble) and is skip-counted.
 * - `reasoning` items carry encrypted content and, in the sampled config, an
 *   always-empty summary. A non-empty summary maps to a thinking block; the
 *   encrypted payload is dropped (same policy as thinking signatures,
 *   SPEC §5.4) and counted.
 * - `token_count.info.last_token_usage` is the per-response delta (verified
 *   against total_token_usage accumulation) → one cost event each, with the
 *   model taken from the most recent turn_context.
 * - No file.diff events yet: the sampled logs contain no structured edit
 *   records (no apply_patch results). Emitting diffs without observed data
 *   would be guessing; real rollouts containing apply_patch are wanted.
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const CODEX_ADAPTER_NAME = "codex";
export const CODEX_ADAPTER_VERSION = "0.1.0";

interface Envelope {
  timestamp?: string;
  type?: string;
  payload?: { type?: string; [key: string]: unknown };
}

const ENVELOPE_TYPES = new Set(["session_meta", "response_item", "event_msg", "turn_context", "compacted"]);

export const codexAdapter: Adapter = {
  name: CODEX_ADAPTER_NAME,
  version: CODEX_ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    for (const line of lines.slice(0, 25)) {
      if (line.trim() === "") continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o === null || typeof o !== "object" || Array.isArray(o)) continue;
      const rec = o as Envelope;
      if (
        typeof rec.timestamp === "string" &&
        typeof rec.type === "string" &&
        ENVELOPE_TYPES.has(rec.type) &&
        rec.payload !== null &&
        typeof rec.payload === "object"
      ) {
        return true;
      }
    }
    return false;
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (key: string) => {
      skipped[key] = (skipped[key] ?? 0) + 1;
    };

    const body: DraftEvent[] = [];
    let sessionId: string | null = null;
    let startDraft: DraftEvent | null = null;
    let currentModel: string | null = null;
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let records = 0;

    for (const line of lines) {
      if (line.trim() === "") continue;
      records++;
      let rec: Envelope;
      try {
        rec = JSON.parse(line) as Envelope;
      } catch {
        skip("<unparseable>");
        continue;
      }
      const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
      const p = rec.payload;
      if (ts === null || p === null || typeof p !== "object") {
        skip(typeof rec.type === "string" ? rec.type : "<untyped>");
        continue;
      }
      if (firstTs === null) firstTs = ts;
      lastTs = ts;

      if (rec.type === "session_meta") {
        sessionId = typeof p.id === "string" ? p.id : null;
        startDraft = {
          ts,
          type: "session.start",
          payload: {
            runtime: "codex",
            runtimeVersion: str(p.cli_version),
            nativeSessionId: sessionId,
            cwd: str(p.cwd),
            gitBranch: null,
            adapter: { name: CODEX_ADAPTER_NAME, version: CODEX_ADAPTER_VERSION },
            native: {
              originator: str(p.originator),
              source: str(p.source),
              modelProvider: str(p.model_provider),
            },
          },
        };
        continue;
      }

      if (rec.type === "turn_context") {
        // Not an event; harvested for the model that subsequent costs bill to.
        if (typeof p.model === "string") currentModel = p.model;
        skip("turn_context");
        continue;
      }

      if (rec.type === "response_item") {
        const kind = p.type;
        if (kind === "message") {
          const role = str(p.role);
          if (role !== "assistant") {
            // user/developer/system items are scaffolding or duplicates of
            // event_msg/user_message (verified on real logs).
            skip(`response_item:message(${role || "?"})`);
            continue;
          }
          const text = contentText(p.content);
          body.push({
            ts,
            type: "message.assistant",
            payload: {
              model: currentModel,
              blocks: [{ type: "text", text }],
              stopReason: null,
              native: { id: (p.id ?? null) as Json },
            },
          });
          continue;
        }
        if (kind === "reasoning") {
          const summary = Array.isArray(p.summary) ? contentText(p.summary) : "";
          if (summary !== "") {
            body.push({
              ts,
              type: "message.assistant",
              payload: {
                model: currentModel,
                blocks: [{ type: "thinking", text: summary }],
                stopReason: null,
                native: { id: (p.id ?? null) as Json },
              },
            });
          } else {
            skip("response_item:reasoning(encrypted)"); // opaque content dropped, SPEC §5.4 policy
          }
          continue;
        }
        if (kind === "function_call" || kind === "custom_tool_call") {
          const callId = str(p.call_id);
          if (callId === "") {
            skip(`response_item:${kind}(no call_id)`);
            continue;
          }
          body.push({
            ts,
            type: "tool.call",
            payload: {
              toolUseId: callId,
              name: str(p.name) || null,
              input: toolInput(kind, p),
              native: { id: (p.id ?? null) as Json, turnId: turnIdOf(p) },
            },
          });
          continue;
        }
        if (kind === "function_call_output" || kind === "custom_tool_call_output") {
          const callId = str(p.call_id);
          if (callId === "") {
            skip(`response_item:${kind}(no call_id)`);
            continue;
          }
          body.push({
            ts,
            type: "tool.result",
            payload: {
              toolUseId: callId,
              // No error flag exists in the observed format; failures arrive
              // as ordinary output text ("Script failed…").
              isError: false,
              output: outputText(p.output),
              structured: (p.output ?? null) as Json,
              native: {},
            },
          });
          continue;
        }
        skip(`response_item:${str(kind) || "?"}`);
        continue;
      }

      if (rec.type === "event_msg") {
        const kind = p.type;
        if (kind === "user_message") {
          body.push({
            ts,
            type: "message.user",
            payload: { text: str(p.message), native: { clientId: (p.client_id ?? null) as Json } },
          });
          continue;
        }
        if (kind === "token_count") {
          const info = p.info;
          const usage =
            info !== null && typeof info === "object" && !Array.isArray(info)
              ? (info as { last_token_usage?: unknown }).last_token_usage
              : undefined;
          if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
            skip("event_msg:token_count(no usage)");
            continue;
          }
          const u = usage as Record<string, unknown>;
          body.push({
            ts,
            type: "cost",
            payload: {
              model: currentModel,
              usage: {
                inputTokens: num(u.input_tokens),
                outputTokens: num(u.output_tokens),
                cacheReadInputTokens: num(u.cached_input_tokens),
                cacheCreationInputTokens: 0,
              },
              native: {
                reasoningOutputTokens: num(u.reasoning_output_tokens),
                totalTokens: num(u.total_tokens),
              },
            },
          });
          continue;
        }
        // agent_message and task_complete duplicate assistant response_items
        // text for text (verified); everything else is runtime telemetry.
        skip(`event_msg:${str(kind) || "?"}`);
        continue;
      }

      skip(typeof rec.type === "string" ? rec.type : "<untyped>");
    }

    if (startDraft === null || sessionId === null || firstTs === null || lastTs === null) {
      throw new Error("no session_meta record found — is this a Codex rollout?");
    }

    const drafts: DraftEvent[] = [startDraft, ...body];
    if (!opts?.live) {
      drafts.push({ ts: lastTs, type: "session.end", payload: { reason: "log-end", synthesized: true } });
    }
    return { sessionId, drafts, records, skipped };
  },
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Concatenate the text parts of a Responses-API content array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c !== null && typeof c === "object" && !Array.isArray(c) ? str((c as { text?: unknown }).text) : "",
    )
    .filter((t) => t !== "")
    .join("\n");
}

/** Tool result output: a plain string, or a content array of text parts. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return contentText(output);
}

/**
 * tool.call input is a Json object. function_call carries JSON-encoded
 * `arguments`; custom_tool_call carries a raw `input` string. An
 * unparseable/non-object arguments string is preserved under _raw rather
 * than repaired.
 */
function toolInput(kind: string, p: { [key: string]: unknown }): Json {
  if (kind === "custom_tool_call") return { input: str(p.input) };
  const raw = str(p.arguments);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
  } catch {
    /* fall through */
  }
  return { _raw: raw };
}

function turnIdOf(p: { [key: string]: unknown }): Json {
  const m = p.metadata;
  if (m !== null && typeof m === "object" && !Array.isArray(m)) {
    return ((m as { turn_id?: unknown }).turn_id ?? null) as Json;
  }
  return null;
}
