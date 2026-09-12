/**
 * Adapter for Claude Code native session logs
 * (~/.claude/projects/<project-slug>/<session-uuid>.jsonl, observed at
 * runtime versions 2.1.2xx).
 *
 * Mapping rules follow SPEC.md §6 and §9: linearize in native file order,
 * preserve native ids under payload.native, skip and count what cannot be
 * mapped, never guess. Everything here was written against real logs; when a
 * real session contradicts this adapter, the adapter is what's wrong.
 */

import { createHash } from "node:crypto";
import type { DraftEvent, Json } from "../format/events.js";
import { NO_NEWLINE_MARKER } from "../patch.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const ADAPTER_NAME = "claude-code";
export const ADAPTER_VERSION = "0.1.0";

interface NativeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  version?: string;
  cwd?: string;
  gitBranch?: string;
  requestId?: string;
  message?: NativeMessage;
  toolUseResult?: Json;
  [key: string]: unknown;
}

interface NativeMessage {
  id?: string;
  model?: string;
  role?: string;
  content?: string | ContentBlock[];
  stop_reason?: string | null;
  usage?: NativeUsage;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Json;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface NativeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface PendingCost {
  messageId: string;
  requestId: string | null;
  model: string | null;
  usage: NativeUsage;
  ts: string;
}

export const claudeCodeAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  /**
   * Look for a Claude Code record among the first 25, rather than demanding
   * that the very first one be it. `convert` already skips-and-counts records
   * it cannot map (a `summary`, a title, a queue operation, a line still being
   * written); `detect` refusing the whole file over the same record is the
   * inconsistency — it made agit answer "no adapter recognizes this file" for
   * files this adapter converts perfectly.
   */
  detect(lines: string[]): boolean {
    for (const line of lines.slice(0, 25)) {
      if (line.trim() === "") continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // one unparseable line is not a verdict on the file
      }
      if (o === null || typeof o !== "object" || Array.isArray(o)) continue;
      const rec = o as NativeRecord;
      if (typeof rec.sessionId === "string" && typeof rec.type === "string") return true;
    }
    return false;
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (key: string) => {
      skipped[key] = (skipped[key] ?? 0) + 1;
    };

    const body: DraftEvent[] = [];
    /** toolUseId -> tool name, for labeling file.diff sources. */
    const toolNames = new Map<string, string>();
    let pendingCost: PendingCost | null = null;

    let sessionId: string | null = null;
    let runtimeVersion: string | null = null;
    let cwd: string | null = null;
    let gitBranch: string | null = null;

    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let records = 0;

    const flushCost = () => {
      if (!pendingCost) return;
      const u = pendingCost.usage;
      body.push({
        ts: pendingCost.ts,
        type: "cost",
        payload: {
          model: pendingCost.model,
          usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
          },
          native: { messageId: pendingCost.messageId, requestId: pendingCost.requestId },
        },
      });
      pendingCost = null;
    };

    for (const line of lines) {
      if (line.trim() === "") continue;
      records++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skip("<unparseable>");
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        // `null` parses cleanly and then throws on the first property read —
        // a corrupt line must be counted, never crash the import.
        skip("<non-object>");
        continue;
      }
      const rec = parsed as NativeRecord;

      if (sessionId === null && typeof rec.sessionId === "string") sessionId = rec.sessionId;

      const type = rec.type;
      const isConversation =
        (type === "user" || type === "assistant") &&
        typeof rec.uuid === "string" &&
        typeof rec.timestamp === "string" &&
        rec.message !== undefined &&
        rec.message !== null;

      if (!isConversation) {
        skip(typeof type === "string" ? type : "<untyped>");
        continue;
      }

      const ts = rec.timestamp!;
      if (firstTs === null) {
        firstTs = ts;
        runtimeVersion = typeof rec.version === "string" ? rec.version : null;
        cwd = typeof rec.cwd === "string" ? rec.cwd : null;
        gitBranch = typeof rec.gitBranch === "string" ? rec.gitBranch : null;
      }
      lastTs = ts;

      const native = { uuid: rec.uuid ?? null, parentUuid: rec.parentUuid ?? null };
      const m = rec.message!;

      if (type === "assistant") {
        const messageId = typeof m.id === "string" ? m.id : null;
        // Records of one API message arrive consecutively and share usage;
        // a record with a different id closes the previous message's cost.
        if (pendingCost && pendingCost.messageId !== messageId) flushCost();

        const blocks: Json[] = [];
        const toolCalls: DraftEvent[] = [];
        const content = Array.isArray(m.content) ? m.content : [];
        for (const b of content) {
          if (b.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
          } else if (b.type === "thinking") {
            const text = typeof b.thinking === "string" ? b.thinking : "";
            if (text !== "") blocks.push({ type: "thinking", text }); // signature dropped, SPEC §5.4
          } else if (b.type === "tool_use" && typeof b.id === "string") {
            if (typeof b.name === "string") toolNames.set(b.id, b.name);
            toolCalls.push({
              ts,
              type: "tool.call",
              payload: {
                toolUseId: b.id,
                name: b.name ?? null,
                input: (b.input ?? {}) as Json,
                native: { ...native, messageId },
              },
            });
          }
          // Other block types (e.g. redacted_thinking) carry nothing renderable; the record itself is still mapped.
        }
        if (blocks.length > 0) {
          body.push({
            ts,
            type: "message.assistant",
            payload: {
              model: m.model ?? null,
              blocks,
              stopReason: m.stop_reason ?? null,
              native: { ...native, messageId, requestId: rec.requestId ?? null },
            },
          });
        }
        body.push(...toolCalls);
        if (m.usage && messageId) {
          pendingCost = {
            messageId,
            requestId: typeof rec.requestId === "string" ? rec.requestId : null,
            model: m.model ?? null,
            usage: m.usage,
            ts,
          };
        }
        continue;
      }

      // type === "user": plain user message, tool results, or both.
      flushCost();
      const content = m.content;
      if (typeof content === "string") {
        body.push({ ts, type: "message.user", payload: { text: content, native } });
        continue;
      }
      const textParts: string[] = [];
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const toolUseId = b.tool_use_id;
          body.push({
            ts,
            type: "tool.result",
            payload: {
              toolUseId,
              isError: b.is_error === true,
              output: flattenResultContent(b.content),
              structured: (rec.toolUseResult ?? null) as Json,
              native,
            },
          });
          const diff = deriveFileDiff(rec.toolUseResult, toolUseId, toolNames.get(toolUseId));
          if (diff) body.push({ ts, type: "file.diff", payload: diff });
        } else if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (typeof b.type === "string") {
          textParts.push(`[${b.type}]`);
        }
      }
      if (textParts.length > 0) {
        body.push({ ts, type: "message.user", payload: { text: textParts.join("\n\n"), native } });
      }
    }
    // Live mode: everything past this point depends on where the file
    // currently ends — the pending cost may still gain records and the
    // session has not actually ended. Emitting neither keeps the result
    // prefix-stable as the log grows (ConvertOptions.live).
    if (!opts?.live) flushCost();

    if (firstTs === null || lastTs === null || sessionId === null) {
      throw new Error("no conversation records found — is this a Claude Code session log?");
    }

    const drafts: DraftEvent[] = [
      {
        ts: firstTs,
        type: "session.start",
        payload: {
          runtime: "claude-code",
          runtimeVersion,
          nativeSessionId: sessionId,
          cwd,
          gitBranch,
          // No model here: it belongs to message.assistant/cost events, and a
          // live share may begin before the first assistant record exists.
          adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        },
      },
      ...body,
    ];
    if (!opts?.live) {
      drafts.push({ ts: lastTs, type: "session.end", payload: { reason: "log-end", synthesized: true } });
    }

    return { sessionId, drafts, records, skipped };
  },
};

function flattenResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as ContentBlock[]) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b && typeof b.type === "string") parts.push(`[${b.type}]`);
  }
  return parts.join("\n");
}

interface FileDiffPayload {
  [key: string]: Json;
  path: string;
  kind: "create" | "modify";
  diff: string;
  beforeHash: string | null;
  afterHash: string;
  toolUseId: string;
  source: string;
}

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * Derive a file.diff payload from a structured toolUseResult, for the two
 * shapes Claude Code records structured edits in (SPEC §5.7):
 *  - Edit:  { filePath, oldString, newString, replaceAll, originalFile, structuredPatch }
 *  - Write: { type: "create"|"update", filePath, content, originalFile, structuredPatch }
 * Anything else produces no diff. Never guess.
 */
function deriveFileDiff(
  tur: Json | undefined,
  toolUseId: string,
  toolName: string | undefined,
): FileDiffPayload | null {
  if (tur === null || tur === undefined || typeof tur !== "object" || Array.isArray(tur)) return null;
  const t = tur as Record<string, Json>;
  const filePath = t.filePath;
  if (typeof filePath !== "string") return null;

  let before: string | null;
  let after: string;
  let source: string;

  if (
    typeof t.oldString === "string" &&
    typeof t.newString === "string" &&
    typeof t.originalFile === "string"
  ) {
    before = t.originalFile;
    after =
      t.replaceAll === true
        ? before.split(t.oldString).join(t.newString)
        : replaceFirst(before, t.oldString, t.newString);
    source = toolName ?? "Edit";
  } else if (
    typeof t.content === "string" &&
    (t.type === "create" || t.type === "update" || "originalFile" in t)
  ) {
    before = typeof t.originalFile === "string" ? t.originalFile : null;
    after = t.content;
    source = toolName ?? "Write";
  } else {
    return null;
  }

  const hunks = Array.isArray(t.structuredPatch) ? (t.structuredPatch as unknown as PatchHunk[]) : [];
  const diff = renderUnifiedDiff(filePath, before, after, hunks);

  return {
    path: filePath,
    kind: before === null ? "create" : "modify",
    diff,
    beforeHash: before === null ? null : sha256Utf8(before),
    afterHash: sha256Utf8(after),
    toolUseId,
    source,
  };
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  return i === -1 ? haystack : haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function renderUnifiedDiff(path: string, before: string | null, after: string, hunks: PatchHunk[]): string {
  const header = before === null ? `--- /dev/null\n+++ b/${path}` : `--- a/${path}\n+++ b/${path}`;

  if (hunks.length > 0 && hunks.every(isValidHunk)) {
    const parts = hunks.map(
      (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`,
    );
    return `${header}\n${parts.join("\n")}\n`;
  }

  // No usable hunks (e.g. Write create records structuredPatch: []).
  // Synthesize a correct, if unminimized, full-file diff.
  const beforeLines = before === null ? [] : splitLines(before);
  const afterLines = splitLines(after);
  const lines = [...sideLines(before, "-"), ...sideLines(after, "+")];
  return `${header}\n@@ -${beforeLines.length === 0 ? 0 : 1},${beforeLines.length} +${afterLines.length === 0 ? 0 : 1},${afterLines.length} @@\n${lines.join("\n")}\n`;
}

/**
 * One side of a synthesized diff, with the marker `diff` writes when the last
 * line has no newline after it.
 *
 * Without it the diff describes a trailing newline the file does not have, so
 * replaying it cannot reproduce `afterHash`: `agit fork` drops the file as
 * unreconstructible and `agit blame` reports the mismatch as proof the file
 * was edited outside the log. Plenty of ordinary files end without a newline.
 */
function sideLines(text: string | null, tag: "-" | "+"): string[] {
  if (text === null || text === "") return [];
  const lines = splitLines(text).map((l) => `${tag}${l}`);
  if (!text.endsWith("\n")) lines.push(NO_NEWLINE_MARKER);
  return lines;
}

function isValidHunk(h: unknown): h is PatchHunk {
  const x = h as PatchHunk;
  return (
    x !== null &&
    typeof x === "object" &&
    typeof x.oldStart === "number" &&
    typeof x.oldLines === "number" &&
    typeof x.newStart === "number" &&
    typeof x.newLines === "number" &&
    Array.isArray(x.lines) &&
    x.lines.every((l) => typeof l === "string")
  );
}

function splitLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
