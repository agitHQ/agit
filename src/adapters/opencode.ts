/**
 * Adapter for OpenCode agent sessions (#64).
 *
 * Derived from OpenCode's own session schema and persistence implementation
 * (`anomalyco/opencode`):
 *  - Message types: `packages/schema/src/session-message.ts` (`@opencode-ai/schema/session-message`)
 *  - Session storage: `packages/core/src/session/store.ts` (`@opencode/v2/SessionStore`)
 *  - Session models: `packages/schema/src/session.ts`
 *
 * Mappings follow SPEC.md §6:
 *  - User messages (`type: "user"`) -> `message.user`
 *  - Assistant messages (`type: "assistant"`):
 *      - Text blocks (`type: "text"`) -> text blocks in `message.assistant`
 *      - Reasoning blocks (`type: "reasoning"`) -> thinking blocks in `message.assistant`
 *      - Tool blocks (`type: "tool"`) -> `tool.call` and `tool.result` (from tool state)
 *      - Token usage (`tokens: { input, output, ... }`) -> `cost` event (`payload.usage`, SPEC §5.9)
 *  - Shell executions (`type: "shell"`) -> `tool.call` and `tool.result`
 *  - Context compaction (`type: "compaction"`) -> skipped and counted in import summary
 *
 * Timestamps use `time.created` epoch milliseconds deterministically (SPEC §7).
 * Implements prefix stability under live options.
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const OPENCODE_ADAPTER_NAME = "opencode";
export const OPENCODE_ADAPTER_VERSION = "0.2.0";

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

export const opencodeAdapter: Adapter = {
  name: OPENCODE_ADAPTER_NAME,
  version: OPENCODE_ADAPTER_VERSION,

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

      const id = str(rec.id);
      const isOpenCodeMsg = typeof id === "string" && (id.startsWith("msg_") || id.startsWith("ses_"));
      const hasOpenCodeTime = asRec(rec.time) && (typeof asRec(rec.time)?.created === "number");
      const hasOpenCodeAssistant =
        rec.type === "assistant" &&
        (typeof rec.agent === "string" || Array.isArray(rec.content) || asRec(rec.tokens) !== undefined);
      const hasOpenCodeMarker =
        (typeof rec.sessionID === "string" && rec.sessionID.includes("opencode")) ||
        (typeof rec.session_id === "string" && rec.session_id.includes("opencode")) ||
        (rec.client === "opencode" || rec.runtime === "opencode");

      if ((isOpenCodeMsg && hasOpenCodeTime) || hasOpenCodeAssistant || hasOpenCodeMarker) {
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
      throw new Error("this OpenCode session has no valid records");
    }

    let sessionId: string | null = null;
    for (const r of records) {
      const s = str(r.sessionID) ?? str(r.session_id) ?? str(r.sessionId) ?? (str(r.id)?.startsWith("ses_") ? str(r.id) : null);
      if (s) {
        sessionId = s;
        break;
      }
    }
    if (!sessionId) {
      sessionId = "opencode-session-0001";
    }

    let firstTs: string | null = null;
    for (const r of records) {
      const timeObj = asRec(r.time);
      if (timeObj && typeof timeObj.created === "number") {
        firstTs = new Date(timeObj.created).toISOString();
        break;
      }
      const t = str(r.timestamp) ?? str(r.ts) ?? str(r.createdAt);
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
        "this OpenCode session carries no timestamps on any record, and agit will not date events " +
          "from the clock (two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const drafts: DraftEvent[] = [];
    let currentTs = firstTs;

    let cwd: string | null = null;
    let gitBranch: string | null = null;
    for (const r of records) {
      if (str(r.cwd) || str(r.directory)) {
        cwd = str(r.cwd) ?? str(r.directory);
      }
      if (str(r.gitBranch)) {
        gitBranch = str(r.gitBranch);
      }
    }

    drafts.push({
      ts: currentTs,
      type: "session.start",
      payload: {
        runtime: "opencode",
        runtimeVersion: null,
        nativeSessionId: sessionId,
        cwd,
        gitBranch,
        adapter: { name: OPENCODE_ADAPTER_NAME, version: OPENCODE_ADAPTER_VERSION },
        native: { sessionId },
      },
    });

    let toolCallSeq = 0;
    for (const r of records) {
      const timeObj = asRec(r.time);
      if (timeObj && typeof timeObj.created === "number") {
        currentTs = new Date(timeObj.created).toISOString();
      } else {
        const rawTs = str(r.timestamp) ?? str(r.ts) ?? str(r.createdAt);
        if (rawTs && !Number.isNaN(Date.parse(rawTs))) {
          currentTs = new Date(rawTs).toISOString();
        } else if (typeof r.timestamp === "number" || typeof r.ts === "number") {
          const n = (r.timestamp ?? r.ts) as number;
          currentTs = new Date(n > 1e11 ? n : n * 1000).toISOString();
        }
      }

      const type = str(r.type) ?? str(r.role);

      if (type === "session") {
        continue;
      }

      if (type === "compaction") {
        skip("compaction");
        continue;
      }

      if (type === "user" || type === "prompt") {
        const text = str(r.text) ?? str(r.content) ?? str(r.prompt) ?? "";
        if (text !== "") {
          drafts.push({
            ts: currentTs,
            type: "message.user",
            payload: {
              text,
              native: { id: (r.id ?? null) as Json },
            },
          });
        }
        continue;
      }

      if (type === "assistant" || type === "response") {
        const blocks: Json[] = [];
        let modelStr = "opencode-default";
        if (typeof r.model === "string") {
          modelStr = r.model;
        } else if (asRec(r.model) && typeof asRec(r.model)?.id === "string") {
          modelStr = asRec(r.model)?.id as string;
        }

        // Check OpenCode content array
        if (Array.isArray(r.content)) {
          for (const item of r.content as Json[]) {
            const block = asRec(item);
            if (!block) continue;
            const bType = str(block.type);

            if (bType === "text" && str(block.text)) {
              blocks.push({ type: "text", text: str(block.text)! });
            } else if (bType === "reasoning" && str(block.text)) {
              blocks.push({ type: "thinking", text: str(block.text)! });
            } else if (bType === "tool") {
              toolCallSeq++;
              const callId = str(block.id) ?? ("call_" + toolCallSeq);
              const toolName = str(block.name) ?? "tool";
              const state = asRec(block.state);
              const input = (state ? state.input : {}) as Json;

              drafts.push({
                ts: currentTs,
                type: "tool.call",
                payload: {
                  toolUseId: callId,
                  name: toolName,
                  input: input ?? {},
                  native: { toolId: callId },
                },
              });

              if (state && (state.status === "completed" || state.status === "error")) {
                const resVal = state.result;
                const output = typeof resVal === "string" ? resVal : JSON.stringify(resVal ?? "");
                const isError = state.status === "error";
                drafts.push({
                  ts: currentTs,
                  type: "tool.result",
                  payload: {
                    toolUseId: callId,
                    isError,
                    output,
                    structured: (asRec(resVal) as Json) ?? null,
                    native: { status: (state.status ?? null) as Json },
                  },
                });
              }
            }
          }
        } else {
          // Flat text / thought fields
          const thought = str(r.thought) ?? str(r.thinking);
          if (thought) {
            blocks.push({ type: "thinking", text: thought });
          }
          const text = str(r.content) ?? str(r.text) ?? str(r.response);
          if (text) {
            blocks.push({ type: "text", text });
          }

          const toolCalls = Array.isArray(r.toolCalls) ? (r.toolCalls as Json[]) : Array.isArray(r.tool_calls) ? (r.tool_calls as Json[]) : [];
          for (const tc of toolCalls) {
            const recTc = asRec(tc);
            if (!recTc) continue;
            toolCallSeq++;
            const callId = str(recTc.id) ?? ("call_" + toolCallSeq);
            const name = str(recTc.name) ?? str(recTc.tool) ?? "tool";
            const input = (asRec(recTc.input) ?? asRec(recTc.arguments) ?? {}) as Json;

            drafts.push({
              ts: currentTs,
              type: "tool.call",
              payload: {
                toolUseId: callId,
                name,
                input,
                native: { toolCall: (tc ?? null) as Json },
              },
            });

            if (recTc.output !== undefined || recTc.result !== undefined) {
              const outVal = recTc.output ?? recTc.result;
              const output = typeof outVal === "string" ? outVal : JSON.stringify(outVal);
              drafts.push({
                ts: currentTs,
                type: "tool.result",
                payload: {
                  toolUseId: callId,
                  isError: recTc.isError === true,
                  output,
                  structured: (asRec(outVal) as Json) ?? null,
                  native: { result: (outVal ?? null) as Json },
                },
              });
            }
          }
        }

        if (blocks.length > 0) {
          drafts.push({
            ts: currentTs,
            type: "message.assistant",
            payload: {
              model: modelStr,
              blocks,
              stopReason: str(r.finish) ?? str(r.stopReason) ?? null,
              native: { id: (r.id ?? null) as Json },
            },
          });
        }

        const tokens = asRec(r.tokens) ?? asRec(r.usage);
        if (tokens) {
          const inTokens = num(tokens.input) || num(tokens.prompt_tokens) || num(tokens.inputTokens);
          const outTokens = num(tokens.output) || num(tokens.completion_tokens) || num(tokens.outputTokens);
          const cacheRead = asRec(tokens.cache) ? num(asRec(tokens.cache)?.read) : (num(tokens.cacheReadTokens) || 0);
          const cacheWrite = asRec(tokens.cache) ? num(asRec(tokens.cache)?.write) : (num(tokens.cacheWriteTokens) || 0);

          if (inTokens > 0 || outTokens > 0) {
            drafts.push({
              ts: currentTs,
              type: "cost",
              payload: {
                model: modelStr,
                usage: {
                  inputTokens: inTokens,
                  outputTokens: outTokens,
                  cacheReadTokens: cacheRead,
                  cacheWriteTokens: cacheWrite,
                },
                costUsd: typeof r.cost === "number" ? r.cost : null,
                native: { tokens },
              },
            });
          }
        }
        continue;
      }

      if (type === "shell") {
        toolCallSeq++;
        const callId = str(r.callID) ?? str(r.id) ?? ("call_" + toolCallSeq);
        const command = str(r.command) ?? "";
        const output = str(r.output) ?? "";
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
        drafts.push({
          ts: currentTs,
          type: "tool.result",
          payload: {
            toolUseId: callId,
            isError: false,
            output,
            structured: null,
            native: {},
          },
        });
        continue;
      }

      skip("unknown-record:" + (type ?? "(missing)"));
    }

    if (!opts?.live) {
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
