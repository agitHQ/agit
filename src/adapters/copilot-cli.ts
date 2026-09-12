/**
 * Adapter for GitHub Copilot CLI session event logs (#64).
 *
 * Derived from GitHub Copilot CLI's session persistence implementation
 * (`github/copilot-cli`):
 *  - On-disk session event stream: `~/.copilot/session-state/<id>/events.jsonl`
 *  - Runtime session tracker: `src/runtime/src/session/store_tracking.rs`
 *  - Session storage layer: `src/runtime/src/session/store.rs`
 *
 * Event stream types mapped following SPEC.md §6:
 *  - `session.start`: session initialization -> `session.start`
 *  - `user.message`: user prompts -> `message.user`
 *  - `assistant.message`: model output (text, explanation/thinking) -> `message.assistant`
 *  - `tool.execution_start`: tool calls -> `tool.call`
 *  - `tool.execution_complete`: tool results -> `tool.result`
 *  - `assistant.usage` / token usage records: token counts -> `cost` (`payload.usage`)
 *  - `session.shutdown` / `session.task_complete`: session end -> `session.end`
 *
 * Unmapped runtime lifecycle events (`hook.start`, `hook.end`, `session.plan_changed`,
 * `subagent.*`) are skipped and counted in the import report, never guessed.
 * Timestamps are preserved deterministically from records without clock fallback (SPEC §7).
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const COPILOT_CLI_ADAPTER_NAME = "copilot-cli";
export const COPILOT_CLI_ADAPTER_VERSION = "0.2.0";

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

export const copilotCliAdapter: Adapter = {
  name: COPILOT_CLI_ADAPTER_NAME,
  version: COPILOT_CLI_ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    for (const line of lines.slice(0, 25)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let o: unknown;
      try {
        o = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const rec = asRec(o);
      if (!rec) continue;

      const type = str(rec.type);
      const isCopilotEvent =
        type === "session.start" ||
        type === "user.message" ||
        type === "assistant.message" ||
        type === "tool.execution_start" ||
        type === "tool.execution_complete" ||
        type === "assistant.usage" ||
        type === "session.task_complete" ||
        type === "session.shutdown";

      const hasCopilotMarker =
        (typeof rec.source === "string" && rec.source.includes("copilot")) ||
        (typeof rec.client === "string" && rec.client.includes("copilot")) ||
        (typeof rec.sessionId === "string" && rec.sessionId.includes("copilot")) ||
        (typeof rec.session_id === "string" && rec.session_id.includes("copilot")) ||
        (typeof rec.command === "string" && (rec.command.startsWith("gh copilot") || rec.suggested_command !== undefined));

      if (isCopilotEvent || hasCopilotMarker) {
        return true;
      }
    }
    return false;
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1) => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    const records: Rec[] = [];
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed);
        const r = asRec(parsed);
        if (r) records.push(r);
        else skip("<non-object-record>");
      } catch {
        skip("<unparseable-line>");
      }
    }

    if (records.length === 0) {
      throw new Error("this Copilot CLI session has no valid records");
    }

    let sessionId: string | null = null;
    for (const r of records) {
      const s = str(r.sessionId) ?? str(r.session_id) ?? str(r.id);
      if (s) {
        sessionId = s;
        break;
      }
    }
    if (!sessionId) {
      sessionId = "copilot-session-0001";
    }

    let firstTs: string | null = null;
    for (const r of records) {
      const t = str(r.timestamp) ?? str(r.ts) ?? str(r.created_at);
      if (t && !Number.isNaN(Date.parse(t))) {
        firstTs = new Date(t).toISOString();
        break;
      }
      if (typeof r.timestamp === "number" || typeof r.ts === "number") {
        const n = (r.timestamp ?? r.ts) as number;
        firstTs = new Date(n > 1e11 ? n : n * 1000).toISOString();
        break;
      }
    }

    if (!firstTs) {
      throw new Error(
        "this Copilot CLI session carries no timestamps on any record, and agit will not date events " +
          "from the clock (two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const drafts: DraftEvent[] = [];
    let currentTs = firstTs;
    let activeModel = "copilot-default";
    let emittedStart = false;

    for (const r of records) {
      const rawTs = str(r.timestamp) ?? str(r.ts) ?? str(r.created_at);
      if (rawTs && !Number.isNaN(Date.parse(rawTs))) {
        currentTs = new Date(rawTs).toISOString();
      } else if (typeof r.timestamp === "number" || typeof r.ts === "number") {
        const n = (r.timestamp ?? r.ts) as number;
        currentTs = new Date(n > 1e11 ? n : n * 1000).toISOString();
      }

      if (r.model && typeof r.model === "string") {
        activeModel = r.model;
      }

      const type = str(r.type);

      if (type === "session.start" || (!emittedStart && !type)) {
        if (!emittedStart) {
          drafts.push({
            ts: currentTs,
            type: "session.start",
            payload: {
              runtime: "copilot-cli",
              runtimeVersion: str(r.version) ?? null,
              nativeSessionId: sessionId,
              cwd: str(r.cwd) ?? str(records[0]?.cwd) ?? null,
              gitBranch: str(r.gitBranch) ?? str(records[0]?.gitBranch) ?? null,
              adapter: { name: COPILOT_CLI_ADAPTER_NAME, version: COPILOT_CLI_ADAPTER_VERSION },
              native: { sessionId },
            },
          });
          emittedStart = true;
          if (type === "session.start") continue;
        }
      }

      if (type === "user.message" || r.role === "user" || type === "user_prompt") {
        const text =
          str(r.text) ??
          str(r.prompt) ??
          str(r.content) ??
          (asRec(r.message) ? str(asRec(r.message)?.content) : null) ??
          "";
        if (text !== "") {
          drafts.push({
            ts: currentTs,
            type: "message.user",
            payload: {
              text,
              native: { type: type ?? "user" },
            },
          });
        }
        continue;
      }

      if (type === "assistant.message" || r.role === "assistant" || type === "agent_response") {
        const blocks: Json[] = [];
        const explanation = str(r.explanation) ?? str(r.thought);
        if (explanation) {
          blocks.push({ type: "thinking", text: explanation });
        }
        const text =
          str(r.text) ??
          str(r.content) ??
          str(r.message) ??
          (asRec(r.message) ? str(asRec(r.message)?.content) : null);
        if (text) {
          blocks.push({ type: "text", text });
        }

        const model = str(r.model) ?? activeModel;

        if (blocks.length > 0) {
          drafts.push({
            ts: currentTs,
            type: "message.assistant",
            payload: {
              model,
              blocks,
              stopReason: null,
              native: { type: type ?? "assistant" },
            },
          });
        }

        const usage = asRec(r.usage) ?? asRec(r.tokens);
        if (usage) {
          const inTokens = num(usage.inputTokens) || num(usage.prompt_tokens);
          const outTokens = num(usage.outputTokens) || num(usage.completion_tokens);
          if (inTokens > 0 || outTokens > 0) {
            drafts.push({
              ts: currentTs,
              type: "cost",
              payload: {
                model,
                usage: {
                  inputTokens: inTokens,
                  outputTokens: outTokens,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
                costUsd: null,
                native: { usage },
              },
            });
          }
        }
        continue;
      }

      if (type === "tool.execution_start") {
        const callId = str(r.toolCallId) ?? str(r.id) ?? ("call_" + drafts.length);
        const name = str(r.toolName) ?? str(r.name) ?? "tool";
        const input = (r.input as Json) ?? {};
        drafts.push({
          ts: currentTs,
          type: "tool.call",
          payload: {
            toolUseId: callId,
            name,
            input,
            native: { toolCallId: callId },
          },
        });
        continue;
      }

      if (type === "tool.execution_complete") {
        const callId = str(r.toolCallId) ?? str(r.id) ?? ("call_" + drafts.length);
        const output =
          str(r.output) ??
          (asRec(r.result) ? str(asRec(r.result)?.content) : null) ??
          String(r.output ?? "");
        const isError = r.success === false || r.isError === true;
        drafts.push({
          ts: currentTs,
          type: "tool.result",
          payload: {
            toolUseId: callId,
            isError,
            output,
            structured: null,
            native: { success: (r.success ?? null) as Json },
          },
        });
        continue;
      }

      if (type === "assistant.usage" || type === "cost") {
        const inTokens = num(r.inputTokens) || (asRec(r.usage) ? num(asRec(r.usage)?.prompt_tokens) : 0);
        const outTokens = num(r.outputTokens) || (asRec(r.usage) ? num(asRec(r.usage)?.completion_tokens) : 0);
        const model = str(r.model) ?? activeModel;
        drafts.push({
          ts: currentTs,
          type: "cost",
          payload: {
            model,
            usage: {
              inputTokens: inTokens,
              outputTokens: outTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            costUsd: null,
            native: { usage: (r.usage ?? r) as Json },
          },
        });
        continue;
      }

      if (type === "session.shutdown" || type === "session.task_complete") {
        if (!opts?.live) {
          drafts.push({
            ts: currentTs,
            type: "session.end",
            payload: {
              reason: "complete",
              native: { type },
            },
          });
        }
        continue;
      }

      const command = str(r.command) ?? str(r.suggestedCommand);
      if (command) {
        const callId = "call_" + drafts.length;
        drafts.push({
          ts: currentTs,
          type: "tool.call",
          payload: {
            toolUseId: callId,
            name: "shell",
            input: { command },
            native: { command },
          },
        });

        if (r.output !== undefined) {
          drafts.push({
            ts: currentTs,
            type: "tool.result",
            payload: {
              toolUseId: callId,
              isError: r.exitCode !== 0 && r.exit_code !== 0 && (r.exitCode !== undefined || r.exit_code !== undefined),
              output: String(r.output),
              structured: null,
              native: { exitCode: ((r.exitCode ?? r.exit_code) ?? null) as Json },
            },
          });
        }
        continue;
      }

      skip("unmapped-event:" + (type ?? "unknown"));
    }

    if (!emittedStart) {
      drafts.unshift({
        ts: firstTs,
        type: "session.start",
        payload: {
          runtime: "copilot-cli",
          runtimeVersion: null,
          nativeSessionId: sessionId,
          cwd: str(records[0]?.cwd) ?? null,
          gitBranch: str(records[0]?.gitBranch) ?? null,
          adapter: { name: COPILOT_CLI_ADAPTER_NAME, version: COPILOT_CLI_ADAPTER_VERSION },
          native: { sessionId },
        },
      });
    }

    const hasEnd = drafts.some((d) => d.type === "session.end");
    if (!hasEnd && !opts?.live) {
      drafts.push({
        ts: currentTs,
        type: "session.end",
        payload: {
          reason: "complete",
          native: {},
        },
      });
    }

    return {
      sessionId,
      drafts,
      records: records.length,
      skipped,
    };
  },
};
