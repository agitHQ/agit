/**
 * Adapter for Cursor agent transcripts (~/.cursor/projects/<path>/agent-transcripts/<uuid>/<uuid>.jsonl, #62).
 *
 * Derived from Cursor 3.5.38 agent transcript format (source reference:
 * `cursor-history/src/core/store-stack/transcript.ts`).
 *
 * Cursor agent transcripts persist Anthropic-shaped conversation turn lines:
 *  - `{ role, type, message: { content: [...] }, parentMessageId, isSidechain, timestamp }`
 *  - Content blocks contain `text`, `tool_use` (with `id`, `name`, `input`),
 *    and `tool_result` (with `tool_use_id`, `content`, `is_error`).
 *
 * Mapping rules follow SPEC.md §6:
 *  - user text content -> `message.user`
 *  - assistant text and thinking content -> `message.assistant`
 *  - `tool_use` blocks -> `tool.call`
 *  - `tool_result` blocks -> `tool.result`
 *  - token usage -> `cost` events
 *
 * Sidechains (`isSidechain: true`) and system blocks are skipped and counted
 * honestly without altering the main trajectory. Built with zero dependencies.
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

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, Json>;
  tool_use_id?: string;
  content?: Json;
  is_error?: boolean;
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

      // Anthropic-shaped Cursor transcript record
      const hasParent = rec.parentMessageId !== undefined || rec.parentId !== undefined;
      const hasSidechain = rec.isSidechain !== undefined;
      const msg = asRec(rec.message);
      const isAnthropicShaped = typeof rec.role === "string" && msg !== undefined && Array.isArray(msg.content);

      if ((hasParent || hasSidechain) && isAnthropicShaped) {
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

    const sessionId = "cursor-transcript-0001";

    let firstTs: string | null = null;
    for (const r of records) {
      const t = str(r.timestamp) ?? str(r.createdAt);
      if (t && !Number.isNaN(Date.parse(t))) {
        firstTs = new Date(t).toISOString();
        break;
      }
      if (typeof r.timestamp === "number" || typeof r.createdAt === "number") {
        const n = (r.timestamp ?? r.createdAt) as number;
        firstTs = new Date(n > 1e11 ? n : n * 1000).toISOString();
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
        runtimeVersion: null,
        nativeSessionId: sessionId,
        cwd: null,
        gitBranch: null,
        adapter: { name: CURSOR_ADAPTER_NAME, version: CURSOR_ADAPTER_VERSION },
        native: {
          sessionId,
        },
      },
    });

    for (const r of records) {
      if (r.isSidechain === true) {
        skip("sidechain-turn");
        continue;
      }

      const rawTs = str(r.timestamp) ?? str(r.createdAt);
      if (rawTs && !Number.isNaN(Date.parse(rawTs))) {
        currentTs = new Date(rawTs).toISOString();
      } else if (typeof r.timestamp === "number" || typeof r.createdAt === "number") {
        const n = (r.timestamp ?? r.createdAt) as number;
        currentTs = new Date(n > 1e11 ? n : n * 1000).toISOString();
      }

      const msg = asRec(r.message) ?? r;
      const role = str(r.role) ?? str(msg.role);
      const blocks = (Array.isArray(msg.content) ? msg.content : [])
        .map(asRec)
        .filter((b): b is Rec => b !== undefined) as unknown as ContentBlock[];

      const model = str(msg.model) ?? "cursor-claude";

      if (role === "user") {
        const textParts: string[] = [];
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") {
            textParts.push(b.text);
          } else if (b.type === "tool_result") {
            const callId = b.tool_use_id ?? "(unknown)";
            let output = "";
            if (typeof b.content === "string") output = b.content;
            else if (b.content !== undefined) output = JSON.stringify(b.content);
            drafts.push({
              ts: currentTs,
              type: "tool.result",
              payload: {
                toolUseId: callId,
                isError: b.is_error === true,
                output,
                structured: (asRec(b.content) as Json) ?? null,
                native: { tool_use_id: callId },
              },
            });
          } else {
            skip(`unknown-user-block:${b.type ?? "(untyped)"}`);
          }
        }
        const text = textParts.join("\n").trim();
        if (text !== "") {
          drafts.push({
            ts: currentTs,
            type: "message.user",
            payload: {
              text,
              native: { id: str(msg.id) ?? null },
            },
          });
        }
      } else if (role === "assistant") {
        const assistantBlocks: Json[] = [];
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string" && b.text !== "") {
            assistantBlocks.push({ type: "text", text: b.text });
          } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking !== "") {
            assistantBlocks.push({ type: "thinking", text: b.thinking });
          } else if (b.type === "tool_use") {
            const callId = b.id ?? `call_${drafts.length + 1}`;
            const name = b.name ?? "tool";
            const input = (b.input as Json) ?? {};

            drafts.push({
              ts: currentTs,
              type: "tool.call",
              payload: {
                toolUseId: callId,
                name,
                input,
                native: { id: callId },
              },
            });
          }
        }

        if (assistantBlocks.length > 0) {
          drafts.push({
            ts: currentTs,
            type: "message.assistant",
            payload: {
              model,
              blocks: assistantBlocks,
              stopReason: str(msg.stop_reason) ?? null,
              native: { id: str(msg.id) ?? null },
            },
          });
        }

        const usage = asRec(msg.usage);
        if (usage) {
          const inTokens = num(usage.input_tokens) || num(usage.promptTokens);
          const outTokens = num(usage.output_tokens) || num(usage.completionTokens);
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
