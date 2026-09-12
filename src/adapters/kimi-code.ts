/**
 * Adapter for Kimi Code sessions (~/.kimi-code/sessions/<project>/<session>/agents/<name>/*.jsonl, #64).
 *
 * Derived from Moonshot / Kimi Code agent session format (as read by claude-replay):
 * Sessions are persisted per agent in JSONL containing standard chat turns:
 *  - `{ id, created_at, role: "user" | "assistant" | "tool" | "system", content, tool_calls, tool_call_id, model, usage }`
 *
 * Mapping rules follow SPEC.md §6:
 *  - `role: "user"` -> `message.user`
 *  - `role: "assistant"` -> `message.assistant` (mapping `reasoning_content` to thinking blocks if present)
 *  - `tool_calls` -> `tool.call`
 *  - `role: "tool"` -> `tool.result`
 *  - `usage` -> `cost` events (`payload.usage`)
 *
 * `system` records are counted in skip totals without guessing.
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const KIMI_CODE_ADAPTER_NAME = "kimi-code";
export const KIMI_CODE_ADAPTER_VERSION = "0.1.0";

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

interface FunctionCallItem {
  id?: string;
  name?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, Json>;
  };
}

export const kimiCodeAdapter: Adapter = {
  name: KIMI_CODE_ADAPTER_NAME,
  version: KIMI_CODE_ADAPTER_VERSION,

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

      const model = str(rec.model);
      const isKimiModel = model !== null && (model.includes("kimi") || model.includes("moonshot"));
      const isAgentSession = typeof rec.agent_name === "string" || typeof rec.agentId === "string";
      const hasChatTurn = typeof rec.role === "string" && (rec.content !== undefined || rec.tool_calls !== undefined);

      if ((isKimiModel || isAgentSession) && hasChatTurn) {
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
      throw new Error("this Kimi Code session has no valid records");
    }

    let sessionId: string | null = null;
    for (const r of records) {
      const s = str(r.session_id) ?? str(r.sessionId) ?? str(r.id);
      if (s) {
        sessionId = s;
        break;
      }
    }
    if (!sessionId) {
      sessionId = "kimi-session-0001";
    }

    let firstTs: string | null = null;
    for (const r of records) {
      const t = str(r.timestamp) ?? str(r.created_at);
      if (t && !Number.isNaN(Date.parse(t))) {
        firstTs = new Date(t).toISOString();
        break;
      }
      if (typeof r.timestamp === "number" || typeof r.created_at === "number" || typeof r.created === "number") {
        const n = (r.timestamp ?? r.created_at ?? r.created) as number;
        firstTs = new Date(n > 1e11 ? n : n * 1000).toISOString();
        break;
      }
    }

    if (!firstTs) {
      throw new Error(
        "this Kimi Code session carries no timestamps on any record, and agit will not date events " +
          "from the clock (two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const drafts: DraftEvent[] = [];
    let currentTs = firstTs;

    drafts.push({
      ts: currentTs,
      type: "session.start",
      payload: {
        runtime: "kimi-code",
        runtimeVersion: null,
        nativeSessionId: sessionId,
        cwd: str(records[0]?.cwd) ?? null,
        gitBranch: str(records[0]?.gitBranch) ?? null,
        adapter: { name: KIMI_CODE_ADAPTER_NAME, version: KIMI_CODE_ADAPTER_VERSION },
        native: {
          sessionId,
          agentName: str(records[0]?.agent_name) ?? null,
        },
      },
    });

    let toolCallSeq = 0;
    for (const r of records) {
      const rawTs = str(r.timestamp) ?? str(r.created_at);
      if (rawTs && !Number.isNaN(Date.parse(rawTs))) {
        currentTs = new Date(rawTs).toISOString();
      } else if (typeof r.timestamp === "number" || typeof r.created_at === "number" || typeof r.created === "number") {
        const n = (r.timestamp ?? r.created_at ?? r.created) as number;
        currentTs = new Date(n > 1e11 ? n : n * 1000).toISOString();
      }

      const role = str(r.role);
      const model = str(r.model) ?? "kimi-k1.5";

      if (role === "system") {
        skip("system-prompt");
        continue;
      }

      if (role === "user") {
        const text = str(r.content) ?? str(r.text) ?? "";
        if (text !== "") {
          drafts.push({
            ts: currentTs,
            type: "message.user",
            payload: {
              text,
              native: { role: "user" },
            },
          });
        }
      } else if (role === "assistant") {
        const blocks: Json[] = [];
        const reasoning = str(r.reasoning_content) ?? str(r.thought);
        if (reasoning) {
          blocks.push({ type: "thinking", text: reasoning });
        }
        const text = str(r.content) ?? str(r.text);
        if (text) {
          blocks.push({ type: "text", text });
        }

        const toolCalls = Array.isArray(r.tool_calls) ? (r.tool_calls as Json[]) : [];
        for (const tc of toolCalls) {
          const recTc = asRec(tc) as unknown as FunctionCallItem | undefined;
          if (!recTc) continue;
          toolCallSeq++;
          const callId = recTc.id ?? `call_${toolCallSeq}`;
          const fn = recTc.function;
          const toolName = fn?.name ?? recTc.name ?? "tool";

          let parsedArgs: Json = {};
          if (typeof fn?.arguments === "string") {
            try {
              parsedArgs = JSON.parse(fn.arguments);
            } catch {
              parsedArgs = { raw: fn.arguments };
            }
          } else if (asRec(fn?.arguments)) {
            parsedArgs = fn?.arguments as unknown as Json;
          }

          drafts.push({
            ts: currentTs,
            type: "tool.call",
            payload: {
              toolUseId: callId,
              name: toolName,
              input: parsedArgs,
              native: { toolCall: (tc ?? null) as Json },
            },
          });
        }

        if (blocks.length > 0) {
          drafts.push({
            ts: currentTs,
            type: "message.assistant",
            payload: {
              model,
              blocks,
              stopReason: str(r.finish_reason) ?? null,
              native: { role: "assistant" },
            },
          });
        }

        const usage = asRec(r.usage);
        if (usage) {
          const inTokens = num(usage.prompt_tokens);
          const outTokens = num(usage.completion_tokens);
          if (inTokens > 0 || outTokens > 0) {
            drafts.push({
              ts: currentTs,
              type: "cost",
              payload: {
                model,
                usage: {
                  inputTokens: inTokens,
                  outputTokens: outTokens,
                  cacheReadTokens: num(usage.cached_tokens),
                  cacheWriteTokens: 0,
                },
                costUsd: null,
                native: { usage },
              },
            });
          }
        }
      } else if (role === "tool") {
        toolCallSeq++;
        const callId = str(r.tool_call_id) ?? str(r.toolUseId) ?? `call_${toolCallSeq}`;
        const output = str(r.content) ?? str(r.output) ?? "";
        drafts.push({
          ts: currentTs,
          type: "tool.result",
          payload: {
            toolUseId: callId,
            isError: r.is_error === true,
            output,
            structured: (asRec(r.structured) as Json) ?? null,
            native: { role: "tool" },
          },
        });
      } else {
        skip(`unknown-role:${role ?? "(missing)"}`);
      }
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
