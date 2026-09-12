/**
 * Adapter for Gemini CLI session logs (~/.gemini/tmp/<hash>/chats/*.jsonl).
 *
 * Derived from Google's Gemini CLI source:
 *  - `packages/cli/src/session/session-manager.ts` (JSONL turn envelope)
 *  - `packages/core/src/types/content.ts` and Gemini API Content schema
 *
 * In the Gemini Content schema, there is no tool role: function execution results
 * are submitted back to the model as user turns (`role: "user"`) containing
 * `parts: [{ functionResponse: { name, response, id } }]`.
 *
 * Mapping rules follow SPEC.md §6:
 *  - `role: "user"` parts with text -> `message.user`
 *  - `role: "user"` parts with `functionResponse` -> `tool.result`
 *  - `role: "model"` parts with `thought` -> `message.assistant` thinking blocks
 *  - `role: "model"` parts with `text` -> `message.assistant` text blocks
 *  - `role: "model"` parts with `functionCall` -> `tool.call`
 *  - `usageMetadata` -> `cost` events (promptTokenCount, candidatesTokenCount)
 *
 * Unverifiable or system records are counted in skip totals without guessing.
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const GEMINI_CLI_ADAPTER_NAME = "gemini-cli";
export const GEMINI_CLI_ADAPTER_VERSION = "0.1.0";

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

interface FunctionCallPart {
  name: string;
  args?: Record<string, Json>;
  id?: string;
}

interface FunctionResponsePart {
  name?: string;
  response?: Json;
  id?: string;
}

export const geminiCliAdapter: Adapter = {
  name: GEMINI_CLI_ADAPTER_NAME,
  version: GEMINI_CLI_ADAPTER_VERSION,

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

      if (
        (typeof rec.role === "string" && Array.isArray(rec.parts) && (rec.role === "user" || rec.role === "model")) ||
        (asRec(rec.usageMetadata) !== undefined && typeof rec.role === "string")
      ) {
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
      throw new Error("this Gemini CLI session has no valid records");
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
      sessionId = "gemini-session-0001";
    }

    let firstTs: string | null = null;
    for (const r of records) {
      const t = str(r.timestamp) ?? str(r.ts) ?? str(r.time);
      if (t && !Number.isNaN(Date.parse(t))) {
        firstTs = new Date(t).toISOString();
        break;
      }
      if (typeof r.timestamp === "number" || typeof r.ts === "number") {
        const n = (r.timestamp ?? r.ts) as number;
        firstTs = new Date(n).toISOString();
        break;
      }
    }

    if (!firstTs) {
      throw new Error(
        "this Gemini CLI session carries no timestamps on any record, and agit will not date events " +
          "from the clock (two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const drafts: DraftEvent[] = [];
    let currentTs = firstTs;

    drafts.push({
      ts: currentTs,
      type: "session.start",
      payload: {
        runtime: "gemini-cli",
        runtimeVersion: str(records[0]?.version) ?? null,
        nativeSessionId: sessionId,
        cwd: str(records[0]?.cwd) ?? null,
        gitBranch: str(records[0]?.gitBranch) ?? null,
        adapter: { name: GEMINI_CLI_ADAPTER_NAME, version: GEMINI_CLI_ADAPTER_VERSION },
        native: {
          sessionId,
        },
      },
    });

    let toolCallSeq = 0;
    for (const r of records) {
      const rawTs = str(r.timestamp) ?? str(r.ts);
      if (rawTs && !Number.isNaN(Date.parse(rawTs))) {
        currentTs = new Date(rawTs).toISOString();
      } else if (typeof r.timestamp === "number" || typeof r.ts === "number") {
        currentTs = new Date((r.timestamp ?? r.ts) as number).toISOString();
      }

      const role = str(r.role);
      const model = str(r.model) ?? "gemini-2.5-pro";
      const parts = Array.isArray(r.parts) ? (r.parts as Json[]) : [];

      if (role === "system") {
        skip("system-prompt");
        continue;
      }

      if (role === "user") {
        const textParts: string[] = [];
        for (const p of parts) {
          const recP = asRec(p);
          if (!recP) continue;

          if (typeof recP.text === "string") {
            textParts.push(recP.text);
          } else if (asRec(recP.functionResponse)) {
            // Function results arrive under role: "user" in the Gemini API specification
            const fr = asRec(recP.functionResponse) as unknown as FunctionResponsePart;
            const callId = fr.id ?? `call_${toolCallSeq}`;
            let output = "";
            if (typeof fr.response === "string") {
              output = fr.response;
            } else if (fr.response !== undefined && fr.response !== null) {
              output = JSON.stringify(fr.response);
            }
            drafts.push({
              ts: currentTs,
              type: "tool.result",
              payload: {
                toolUseId: callId,
                isError: false,
                output,
                structured: (asRec(fr.response) as Json) ?? null,
                native: { functionResponse: (recP.functionResponse ?? null) as Json },
              },
            });
          } else {
            skip(`unknown-user-part:${Object.keys(recP).join(",")}`);
          }
        }

        const text = textParts.join("\n").trim();
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
      } else if (role === "model" || role === "assistant") {
        const blocks: Json[] = [];
        for (const p of parts) {
          const recP = asRec(p);
          if (!recP) continue;

          if (typeof recP.thought === "string" && recP.thought !== "") {
            blocks.push({ type: "thinking", text: recP.thought });
          }
          if (typeof recP.text === "string" && recP.text !== "") {
            blocks.push({ type: "text", text: recP.text });
          }

          if (asRec(recP.functionCall)) {
            const fc = asRec(recP.functionCall) as unknown as FunctionCallPart;
            toolCallSeq++;
            const callId = fc.id ?? `call_${toolCallSeq}`;
            const toolName = fc.name ?? "tool";
            const input = (asRec(fc.args) as Json) ?? {};

            drafts.push({
              ts: currentTs,
              type: "tool.call",
              payload: {
                toolUseId: callId,
                name: toolName,
                input,
                native: { functionCall: (recP.functionCall ?? null) as Json },
              },
            });
          }
        }

        if (blocks.length > 0) {
          drafts.push({
            ts: currentTs,
            type: "message.assistant",
            payload: {
              model,
              blocks,
              stopReason: str(r.stopReason) ?? null,
              native: { role: "model" },
            },
          });
        }

        const usage = asRec(r.usageMetadata);
        if (usage) {
          const promptTokens = num(usage.promptTokenCount);
          const candidatesTokens = num(usage.candidatesTokenCount);
          if (promptTokens > 0 || candidatesTokens > 0) {
            drafts.push({
              ts: currentTs,
              type: "cost",
              payload: {
                model,
                usage: {
                  inputTokens: promptTokens,
                  outputTokens: candidatesTokens,
                  cacheReadTokens: num(usage.cachedContentTokenCount),
                  cacheWriteTokens: 0,
                },
                costUsd: null,
                native: { usageMetadata: usage },
              },
            });
          }
        }
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
