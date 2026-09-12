/**
 * Adapter for OpenClaw session transcripts (JSONL, one entry per line).
 *
 * Mapping rules follow SPEC.md section 6: linearize in native file order,
 * preserve native ids under payload.native, skip and count what cannot be
 * mapped, never guess.
 *
 * Derived from OpenClaw's own type definitions rather than from a captured
 * log, and each shape below was checked against them:
 *   - the header entry, src/config/sessions/transcript-header.ts:
 *       { type: "session", version, id, timestamp, cwd, parentSession? }
 *   - the message entry, src/agents/sessions/session-manager-types.ts:
 *       SessionMessageEntry { type: "message", id, parentId, timestamp, message }
 *   - roles user | assistant | toolResult, content parts text | thinking |
 *     toolCall, and Usage { input, output, cacheRead, cacheWrite, cost },
 *     packages/llm-core/src/types.ts
 *
 * File edits: OpenClaw's apply_patch tool takes one patch string ("*** Begin
 * Patch" … "*** End Patch") and answers "Success. Updated the following
 * files:" with A/M/D lines (src/agents/apply-patch.ts). openclaw-patch.ts
 * parses that grammar and applies update hunks with OpenClaw's own matching
 * rules, so the content agit hashes is the content the runtime wrote. Only
 * files the result confirms are emitted: an add is a verified create; an
 * update is a verified modify when the file's content is already in the log
 * (created or updated earlier in the session); a delete is a file.delete
 * carrying the content's hash; a rename is a delete plus a create. Updates
 * to files that predate the session, failed patches, no-ops and unparseable
 * input are skipped and counted, never guessed.
 *
 * Still to be exercised against a real OpenClaw transcript (#6): a real log
 * that disagrees names its unmapped records in `agit import` output.
 */
import { createHash } from "node:crypto";
import { applyUpdate, parseApplyPatch, type PatchHunk } from "./openclaw-patch.js";
import type { DraftEvent, Json } from "../format/events.js";
import { seedKnownFromBase } from "../base.js";
import { NO_NEWLINE_MARKER } from "../patch.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "openclaw";
const ADAPTER_VERSION = "0.2.0";

type RecordValue = { [key: string]: Json };

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is RecordValue => Boolean(asRecord(part)))
    .filter((part) => part.type === "text" || part.type === "thinking")
    .map((part) => String(part.text ?? part.thinking ?? ""))
    .filter(Boolean)
    .join("\n");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A cost event in the shape the other adapters emit: model, four token
 * counts, and everything runtime-specific under native. Token fields are
 * coerced to numbers so a field missing from one record cannot make two
 * imports of the same log differ (SPEC §7).
 *
 * OpenClaw's Usage carries `cost` as well. It is not kept: SPEC §5.9 keeps
 * dollar amounts out of the log, since a price is a display-time computation
 * from a table and one hashed into an event is a stale snapshot nobody can
 * verify. The drop is reported through `skipped` so the import names it.
 */
function usagePayload(message: RecordValue, native: Json): { [key: string]: Json } | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;

  const nativeRecord = asRecord(native) ?? {};
  return {
    model: typeof message.model === "string" ? message.model : null,
    usage: {
      inputTokens: num(usage.input),
      outputTokens: num(usage.output),
      cacheReadInputTokens: num(usage.cacheRead),
      cacheCreationInputTokens: num(usage.cacheWrite),
    },
    native: {
      ...nativeRecord,
      ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    },
  };
}

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function fileDiffPayload(
  path: string,
  before: string | null,
  after: string,
  diff: string,
  toolUseId: string,
): { [key: string]: Json } {
  return {
    path,
    kind: before === null ? "create" : "modify",
    diff,
    beforeHash: before === null ? null : sha256Utf8(before),
    afterHash: sha256Utf8(after),
    toolUseId,
    source: "apply_patch",
  };
}

type PendingPatch = {
  ts: string;
  toolUseId: string;
  input: string | null;
};

type PatchSummary = { added: Set<string>; modified: Set<string>; deleted: Set<string> };

/** What the runtime says it did: details.summary when the transcript kept it, else the result text's A/M/D lines. */
function patchSummary(message: RecordValue): PatchSummary | null {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const summary = asRecord(asRecord(message.details)?.summary);
  if (summary) {
    return {
      added: new Set(list(summary.added)),
      modified: new Set(list(summary.modified)),
      deleted: new Set(list(summary.deleted)),
    };
  }
  const lines = textContent(message.content).split("\n");
  if (lines[0]?.trim() !== "Success. Updated the following files:") return null;
  const out: PatchSummary = { added: new Set(), modified: new Set(), deleted: new Set() };
  for (const l of lines.slice(1)) {
    if (l.startsWith("A ")) out.added.add(l.slice(2));
    else if (l.startsWith("M ")) out.modified.add(l.slice(2));
    else if (l.startsWith("D ")) out.deleted.add(l.slice(2));
  }
  return out;
}

/** The runtime reports display paths; a hunk path matches one exactly or as a suffix either way. */
function reported(set: Set<string>, path: string): boolean {
  const norm = (x: string): string => x.replace(/\\/g, "/").replace(/^\.\//, "");
  const p = norm(path);
  for (const s of set) {
    const q = norm(s);
    if (q === p || q.endsWith("/" + p) || p.endsWith("/" + q)) return true;
  }
  return false;
}

/** Log paths are absolute and OS-native (SPEC section 5.7); patch paths are workspace-relative. */
function absolutePath(cwd: string | undefined, p: string): string {
  if (cwd === undefined || /^([A-Za-z]:[\\/]|[\\/])/.test(p)) return p;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + p.replace(/[\\/]/g, sep);
}

/**
 * A whole-file unified diff: valid for replay to apply and verify, if not the
 * tightest to read.
 *
 * Each side carries the marker `diff` writes when its last line has no newline
 * after it. Without it the diff describes a trailing newline the file does not
 * have, so replaying it cannot reproduce `afterHash`: `agit fork` drops the
 * file as unreconstructible and `agit blame` reports the mismatch as proof the
 * file was edited outside the log.
 */
function synthesizeDiff(path: string, before: string | null, after: string): string {
  const header = before === null ? `--- /dev/null\n+++ b/${path}` : `--- a/${path}\n+++ b/${path}`;
  const split = (t: string): string[] => {
    if (t === "") return [];
    const lines = t.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const side = (text: string | null, tag: "-" | "+"): string[] => {
    if (text === null || text === "") return [];
    const out = split(text).map((l) => `${tag}${l}`);
    if (!text.endsWith("\n")) out.push(NO_NEWLINE_MARKER);
    return out;
  };
  const b = before === null ? [] : split(before);
  const a = split(after);
  const lines = [...side(before, "-"), ...side(after, "+")];
  return `${header}\n@@ -${b.length === 0 ? 0 : 1},${b.length} +${a.length === 0 ? 0 : 1},${a.length} @@\n${lines.join("\n")}\n`;
}

function deletePayload(path: string, before: string, toolUseId: string): { [key: string]: Json } {
  return { path, beforeHash: sha256Utf8(before), toolUseId, source: "apply_patch" };
}

/**
 * Turn one confirmed apply_patch call into file events. `known` is the content
 * agit can vouch for — files created or updated earlier in this session — and
 * nothing is hashed that is not in it.
 */
function emitPatchEvents(
  pending: PendingPatch,
  message: RecordValue,
  body: DraftEvent[],
  known: Map<string, string>,
  skip: (reason: string) => void,
  cwd: string | undefined,
): void {
  if (message.isError === true) {
    // Some hunks may have landed before the failure; there is no way to tell which.
    skip("apply_patch:failed(nothing attributed)");
    return;
  }
  if (pending.input === null) {
    skip("apply_patch:no input");
    return;
  }
  if (/^No changes made/.test(textContent(message.content))) {
    skip("apply_patch:no-op");
    return;
  }
  const summary = patchSummary(message);
  if (summary === null) {
    skip("apply_patch:unrecognized result");
    return;
  }
  let hunks: PatchHunk[];
  try {
    hunks = parseApplyPatch(pending.input);
  } catch {
    skip("apply_patch:unparseable input");
    return;
  }

  for (const h of hunks) {
    const path = absolutePath(cwd, h.path);

    if (h.kind === "add") {
      if (!reported(summary.added, h.path)) {
        skip("apply_patch:add(not confirmed by the result)");
        continue;
      }
      body.push({
        ts: pending.ts,
        type: "file.diff",
        payload: fileDiffPayload(
          path,
          null,
          h.contents,
          synthesizeDiff(path, null, h.contents),
          pending.toolUseId,
        ),
      });
      known.set(path, h.contents);
      continue;
    }

    if (h.kind === "delete") {
      if (!reported(summary.deleted, h.path)) {
        skip("apply_patch:delete(not confirmed by the result)");
        continue;
      }
      const before = known.get(path);
      if (before === undefined) {
        skip("apply_patch:delete(content not in log)");
        continue;
      }
      body.push({
        ts: pending.ts,
        type: "file.delete",
        payload: deletePayload(path, before, pending.toolUseId),
      });
      known.delete(path);
      continue;
    }

    const before = known.get(path);
    if (before === undefined) {
      skip("apply_patch:update(base content not in log)");
      continue;
    }
    let after: string;
    try {
      after = applyUpdate(before, h.chunks);
    } catch {
      skip("apply_patch:update(patch did not apply)");
      continue;
    }

    const dest = h.movePath === undefined ? path : absolutePath(cwd, h.movePath);
    if (dest !== path) {
      if (!reported(summary.modified, h.movePath!)) {
        skip("apply_patch:rename(not confirmed by the result)");
        continue;
      }
      // A rename is recorded as what the filesystem saw: the old path gone,
      // the new one created with the updated content.
      body.push({
        ts: pending.ts,
        type: "file.delete",
        payload: deletePayload(path, before, pending.toolUseId),
      });
      body.push({
        ts: pending.ts,
        type: "file.diff",
        payload: fileDiffPayload(dest, null, after, synthesizeDiff(dest, null, after), pending.toolUseId),
      });
      known.delete(path);
      known.set(dest, after);
      continue;
    }

    if (!reported(summary.modified, h.path)) {
      skip("apply_patch:update(not confirmed by the result)");
      continue;
    }
    body.push({
      ts: pending.ts,
      type: "file.diff",
      payload: fileDiffPayload(path, before, after, synthesizeDiff(path, before, after), pending.toolUseId),
    });
    known.set(path, after);
  }
}

export const openclawAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    for (const line of lines.slice(0, 25)) {
      try {
        const record = asRecord(JSON.parse(line));
        if (record?.type === "session" && typeof record.id === "string") {
          return true;
        }
      } catch {
        // Ignore malformed/unrelated leading records.
      }
    }
    return false;
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const drafts: DraftEvent[] = [];
    const skipped: Record<string, number> = {};

    let records = 0;
    let sessionId = "";
    let firstTs = "";
    let lastTs = "";
    let cwd: string | undefined;
    let sessionFormatVersion: Json = null;
    const known = new Map<string, string>();
    const pendingPatches = new Map<string, PendingPatch>();

    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    for (const line of lines) {
      if (!line.trim()) continue;

      records++;

      let record: RecordValue | undefined;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        skip("invalid-json");
        continue;
      }

      if (!record) {
        skip("non-object");
        continue;
      }

      const ts = typeof record.timestamp === "string" ? record.timestamp : "";
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      if (record.type === "session") {
        if (!sessionId && typeof record.id === "string") {
          sessionId = record.id;
          cwd = typeof record.cwd === "string" ? record.cwd : undefined;
          // Candidate pre-edit content for files that predate the session
          // (#85), keyed the way OpenClaw reports paths.
          seedKnownFromBase(known, opts?.base, cwd ?? null);
          sessionFormatVersion = typeof record.version === "number" ? record.version : null;
        }
        continue;
      }

      if (record.type !== "message") {
        skip(`type:${String(record.type ?? "unknown")}`);
        continue;
      }

      const message = asRecord(record.message);
      if (!message || typeof message.role !== "string") {
        skip("message:malformed");
        continue;
      }

      const role = message.role;
      // SPEC §6: keep the runtime's own ids, so the transcript DAG survives
      // the mapping and events can be traced back to their source records.
      const native: Json = {
        id: typeof record.id === "string" ? record.id : null,
        parentId: typeof record.parentId === "string" ? record.parentId : null,
      };

      if (role === "user") {
        const text = textContent(message.content);
        if (!text) {
          skip("message:user(empty)");
          continue;
        }

        drafts.push({
          ts,
          type: "message.user",
          payload: { text, native },
        });
        continue;
      }

      if (role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        // One native message becomes one message.assistant carrying its
        // blocks, plus a tool.call per call — the same shape the Claude Code
        // and Codex adapters emit. Every view reads `blocks`, so a payload
        // without it renders as an empty assistant turn.
        const blocks: Json[] = [];
        const toolCalls: DraftEvent[] = [];

        for (const partValue of content) {
          const part = asRecord(partValue);
          if (!part) {
            skip("assistant:malformed-content");
            continue;
          }

          if (part.type === "text" || part.type === "thinking") {
            const text = String(part.text ?? part.thinking ?? "");
            if (!text) {
              skip(`assistant:${String(part.type)}(empty)`);
              continue;
            }
            blocks.push({ type: part.type === "thinking" ? "thinking" : "text", text });
            continue;
          }

          if (part.type === "toolCall") {
            if (typeof part.id !== "string" || typeof part.name !== "string") {
              skip("toolCall:malformed");
              continue;
            }

            const input = (asRecord(part.arguments) ?? {}) as Json;

            toolCalls.push({
              ts,
              type: "tool.call",
              payload: {
                toolUseId: part.id,
                name: part.name,
                input,
                native,
              },
            });

            if (part.name === "apply_patch") {
              const inputRecord = asRecord(input);

              pendingPatches.set(part.id, {
                ts,
                toolUseId: part.id,
                input: typeof inputRecord?.input === "string" ? inputRecord.input : null,
              });
            }

            continue;
          }

          skip(`assistant:content:${String(part.type ?? "unknown")}`);
        }

        if (blocks.length > 0) {
          drafts.push({
            ts,
            type: "message.assistant",
            payload: {
              model: typeof message.model === "string" ? message.model : null,
              blocks,
              stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
              native,
            },
          });
        }
        drafts.push(...toolCalls);

        const usage = usagePayload(message, native);
        if (usage) {
          if (asRecord(asRecord(message.usage)?.cost)?.total !== undefined)
            skip("cost-usd-not-stored (SPEC §5.9)");
          drafts.push({
            ts,
            type: "cost",
            payload: usage,
          });
        }

        continue;
      }

      if (role === "toolResult") {
        if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") {
          skip("toolResult:malformed");
          continue;
        }

        drafts.push({
          ts,
          type: "tool.result",
          payload: {
            toolUseId: message.toolCallId,
            name: message.toolName,
            output: textContent(message.content),
            isError: message.isError === true,
            native,
          },
        });

        if (message.toolName === "apply_patch") {
          const pending = pendingPatches.get(message.toolCallId);

          if (pending) {
            emitPatchEvents(pending, message, drafts, known, skip, cwd);
            pendingPatches.delete(message.toolCallId);
          } else {
            skip("apply_patch:missing-call");
          }
        }

        continue;
      }

      skip(`message:${role}`);
    }

    if (!sessionId) {
      throw new Error("OpenClaw transcript has no session header");
    }

    if (!firstTs) firstTs = new Date(0).toISOString();
    if (!lastTs) lastTs = firstTs;

    const startPayload: { [key: string]: Json } = {
      runtime: "openclaw",
      // The header carries a session-format version, not an OpenClaw
      // version, so it goes under native rather than being passed off as one.
      runtimeVersion: null,
      nativeSessionId: sessionId,
      gitBranch: null,
      adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
      native: { sessionFormatVersion: sessionFormatVersion },
    };

    if (cwd !== undefined) startPayload.cwd = cwd;

    drafts.unshift({
      ts: firstTs,
      type: "session.start",
      payload: startPayload,
    });

    if (!opts?.live) {
      drafts.push({
        ts: lastTs,
        type: "session.end",
        payload: { reason: "log-end", synthesized: true },
      });
    }

    return { sessionId, drafts, records, skipped };
  },
};
