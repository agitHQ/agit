/**
 * Adapter for Cursor agent transcripts (~/.cursor/projects/<project>/agent-transcripts/<id>/, #62).
 *
 * Maps Cursor agent transcripts into agit's open event log:
 *  - User queries mapped to message.user
 *  - Agent responses (with thinking and text) mapped to message.assistant
 *  - Tool calls and results mapped to tool.call and tool.result
 *  - Unverifiable file edits skipped and counted rather than guessing hashes
 *  - Usage/token metrics mapped to cost events
 *
 * Implements prefix stability under live options and deterministic imports.
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const CURSOR_ADAPTER_NAME = "cursor";
export const CURSOR_ADAPTER_VERSION = "0.1.0";

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

export const cursorAdapter: Adapter = {
  name: CURSOR_ADAPTER_NAME,
  version: CURSOR_ADAPTER_VERSION,

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
        (typeof rec.agentId === "string" || typeof rec.transcriptId === "string") ||
        (rec.cursorVersion !== undefined) ||
        (typeof rec.sender === "string" && (rec.sender === "human" || rec.sender === "agent")) ||
        (rec.client === "cursor")
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
      throw new Error("this Cursor agent transcript has no valid records");
    }

    let sessionId: string | null = null;
    for (const r of records) {
      const s = str(r.transcriptId) ?? str(r.agentId) ?? str(r.sessionId) ?? str(r.id);
      if (s) {
        sessionId = s;
        break;
      }
    }
    if (!sessionId) {
      sessionId = "cursor-transcript-0001";
    }

    let firstTs: string | null = null;
    for (const r of records) {
      const t = str(r.timestamp) ?? str(r.ts) ?? str(r.createdAt);
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
        "this Cursor agent transcript carries no timestamps on any record, and agit will not date events " +
          "from the clock (two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const drafts: DraftEvent[] = [];
    let currentTs = firstTs;

    drafts.push({
      ts: currentTs,
      type: "session.start",
      payload: {
        runtime: "cursor",
        runtimeVersion: str(records[0]?.cursorVersion) ?? null,
        nativeSessionId: sessionId,
        cwd: str(records[0]?.cwd) ?? null,
        gitBranch: str(records[0]?.gitBranch) ?? null,
        adapter: { name: CURSOR_ADAPTER_NAME, version: CURSOR_ADAPTER_VERSION },
        native: {
          sessionId,
        },
      },
    });

    let toolCallSeq = 0;
    for (const r of records) {
      const rawTs = str(r.timestamp) ?? str(r.ts) ?? str(r.createdAt);
      if (rawTs && !Number.isNaN(Date.parse(rawTs))) {
        currentTs = new Date(rawTs).toISOString();
      } else if (typeof r.timestamp === "number" || typeof r.ts === "number") {
        currentTs = new Date((r.timestamp ?? r.ts) as number).toISOString();
      }

      const role = str(r.role) ?? (str(r.sender) === "human" ? "user" : str(r.sender) === "agent" ? "assistant" : null);
      const model = str(r.model) ?? "cursor-default";

      if (role === "system") {
        skip("system-prompt");
        continue;
      }

      if (role === "user") {
        const text = str(r.text) ?? str(r.content) ?? str(r.message) ?? "";
        if (text !== "") {
          drafts.push({
            ts: currentTs,
            type: "message.user",
            payload: {
              text,
              native: { id: str(r.id) ?? null },
            },
          });
        }
      } else if (role === "assistant") {
        const blocks: Json[] = [];
        const thinking = str(r.thought) ?? str(r.thinking);
        if (thinking) {
          blocks.push({ type: "thinking", text: thinking });
        }
        const text = str(r.text) ?? str(r.content) ?? str(r.message);
        if (text) {
          blocks.push({ type: "text", text });
        }

        // Handle tool calls if embedded in turn
        const toolCalls = Array.isArray(r.toolCalls) ? (r.toolCalls as Json[]) : [];
        for (const tc of toolCalls) {
          const recTc = asRec(tc);
          if (!recTc) continue;
          toolCallSeq++;
          const callId = str(recTc.id) ?? `call_${toolCallSeq}`;
          const name = str(recTc.name) ?? str(recTc.tool) ?? "tool";
          const input = (asRec(recTc.input) ?? asRec(recTc.args) ?? {}) as Json;

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

          // If tool result is attached
          if (recTc.result !== undefined) {
            const outStr = typeof recTc.result === "string" ? recTc.result : JSON.stringify(recTc.result);
            drafts.push({
              ts: currentTs,
              type: "tool.result",
              payload: {
                toolUseId: callId,
                isError: recTc.isError === true,
                output: outStr,
                structured: (asRec(recTc.result) as Json) ?? null,
                native: { result: (recTc.result ?? null) as Json },
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
              native: { id: str(r.id) ?? null },
            },
          });
        }

        const tokens = asRec(r.tokens) ?? asRec(r.usage);
        if (tokens) {
          const inTokens = num(tokens.inputTokens) || num(tokens.promptTokens);
          const outTokens = num(tokens.outputTokens) || num(tokens.completionTokens);
          if (inTokens > 0 || outTokens > 0) {
            drafts.push({
              ts: currentTs,
              type: "cost",
              payload: {
                model,
                inputTokens: inTokens,
                outputTokens: outTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: null,
                native: { usage: tokens },
              },
            });
          }
        }
      } else if (role === "tool") {
        toolCallSeq++;
        const callId = str(r.toolUseId) ?? str(r.callId) ?? `call_${toolCallSeq}`;
        const output = str(r.output) ?? str(r.result) ?? "";
        drafts.push({
          ts: currentTs,
          type: "tool.result",
          payload: {
            toolUseId: callId,
            isError: r.isError === true,
            output,
            structured: (asRec(r.structured) as Json) ?? null,
            native: { id: str(r.id) ?? null },
          },
        });
      } else {
        skip(`unknown-role:${role ?? "(missing)"}`);
      }

      if (r.fileEdit !== undefined) {
        // Cursor file edits without verifiable base/diff are logged as skipped edits
        skip("unverifiable-file-edit");
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
