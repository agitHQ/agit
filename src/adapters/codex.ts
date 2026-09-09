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
 * - Structured edits arrive as FileChange maps, on either of two paths
 *   depending on the thread's history mode (codex-rs/rollout/src/policy.rs):
 *   `patch_apply_end` (Legacy) or `item_completed` -> FileChange (Paginated).
 *   PatchApplyBegin and TurnDiff are transient and never persisted, so those
 *   two are the only sources. What each variant supports:
 *     add    -> full content recorded, so an exactly hashed create
 *     update -> unified_diff only; Codex never records the base, so hashes
 *               are real only when agit already holds that file's content
 *               from earlier in the same session, and the change is skipped
 *               otherwise rather than hashed on a guess
 *     delete -> content known, but SPEC has no deletion event (agit #30)
 *   Patches that failed or were declined changed nothing and are skipped.
 */

import { createHash } from "node:crypto";
import type { DraftEvent, Json } from "../format/events.js";
import { applyUnifiedDiff } from "../patch.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

export const CODEX_ADAPTER_NAME = "codex";
export const CODEX_ADAPTER_VERSION = "0.2.0";

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
    /**
     * File content agit can vouch for, keyed by the path Codex reports.
     * Seeded by Add (full content recorded) and carried forward through
     * Updates whose diff applies cleanly. An Update to a file that was never
     * seen in this session has no entry — Codex records only the diff, never
     * the base — and is skipped rather than hashed on a guess.
     */
    const known = new Map<string, string>();
    let sessionId: string | null = null;
    let startDraft: DraftEvent | null = null;
    let currentModel: string | null = null;
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let records = 0;

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
        skip("<non-object>"); // counted, never a crash
        continue;
      }
      const rec = parsed as Envelope;
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
        // Structured file edits. Codex records the same FileChange data on
        // two paths depending on the thread's history mode (verified against
        // codex-rs/rollout/src/policy.rs): Legacy persists `patch_apply_end`,
        // Paginated persists `item_completed` carrying a FileChange turn item.
        // PatchApplyBegin/TurnDiff are transient and never written, so this is
        // the only place structured edits appear.
        if (kind === "patch_apply_end") {
          emitFileDiffs({
            ts,
            changes: p.changes,
            callId: str(p.call_id),
            applied: p.success === true || p.status === "completed",
            status: str(p.status) || (p.success === true ? "completed" : "unknown"),
            body,
            known,
            skip,
          });
          continue;
        }
        if (kind === "item_completed") {
          const item = p.item;
          if (item !== null && typeof item === "object" && !Array.isArray(item)) {
            const it = item as Record<string, unknown>;
            // TurnItem is serde-tagged without a rename, so the variant tag is
            // "FileChange"; snake_case is accepted too since only the wire
            // form of the tag is in question, never the payload's meaning.
            if (it.type === "FileChange" || it.type === "file_change") {
              emitFileDiffs({
                ts,
                changes: it.changes,
                callId: str(it.id),
                applied: it.status === undefined || it.status === "completed",
                status: str(it.status) || "completed",
                body,
                known,
                skip,
              });
              continue;
            }
          }
          skip("event_msg:item_completed");
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

/**
 * Turn one patch application's `changes` map into file.diff drafts.
 *
 * What each FileChange variant gives us (codex-rs/protocol/src/protocol.rs):
 *  - add    { content }                    full after-content -> exact hashes
 *  - update { unified_diff, move_path }    diff only; hashes need the base,
 *                                          which agit has only if the file was
 *                                          created or updated earlier in this
 *                                          same session
 *  - delete { content }                    before-content, but agit has no
 *                                          deletion event (SPEC has 8 types)
 *
 * Only verified content is emitted: every draft carries hashes computed from
 * bytes agit actually holds. Anything else is skipped and counted, never
 * inferred — the same rule the shell-edit blind spot follows.
 */
function emitFileDiffs(args: {
  ts: string;
  changes: unknown;
  callId: string;
  applied: boolean;
  status: string;
  body: DraftEvent[];
  known: Map<string, string>;
  skip: (key: string) => void;
}): void {
  const { ts, changes, callId, applied, status, body, known, skip } = args;
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    skip("patch_apply:no changes");
    return;
  }
  if (!applied) {
    // Failed or declined patches changed nothing on disk.
    skip(`patch_apply:${status || "not applied"}`);
    return;
  }
  // Rust serializes `changes` from a HashMap, whose order is not stable.
  // Sorting keeps imports byte-identical run to run (SPEC §7).
  for (const path of Object.keys(changes as Record<string, unknown>).sort()) {
    const change = (changes as Record<string, unknown>)[path];
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      skip("patch_apply:malformed change");
      continue;
    }
    const c = change as Record<string, unknown>;
    const kind = str(c.type);

    if (kind === "add") {
      if (typeof c.content !== "string") {
        skip("patch_apply:add(no content)");
        continue;
      }
      body.push({
        ts,
        type: "file.diff",
        payload: fileDiffPayload(path, null, c.content, null, callId, "apply_patch"),
      });
      known.set(path, c.content);
      continue;
    }

    if (kind === "update") {
      if (typeof c.unified_diff !== "string") {
        skip("patch_apply:update(no diff)");
        continue;
      }
      if (typeof c.move_path === "string" && c.move_path !== "") {
        // Before schema v2 a rename had no honest encoding: two paths, and no
        // event type that said one became the other. file.delete gives it one,
        // so record what the filesystem saw -- the old path gone, the new one
        // created with the updated content. Same shape the OpenClaw adapter
        // emits (#52), so views need no Codex-specific case.
        const movedFrom = known.get(path);
        if (movedFrom === undefined) {
          // The file predates the session, so neither path has a base we could
          // hash. Skipping keeps the rule: never assert an unverified hash.
          skip("patch_apply:update(rename, base content not in log)");
          continue;
        }
        let moved: string;
        try {
          moved = applyUnifiedDiff(movedFrom, c.unified_diff);
        } catch {
          skip("patch_apply:update(rename, diff did not apply)");
          continue;
        }
        body.push({
          ts,
          type: "file.delete",
          payload: {
            path,
            beforeHash: sha256Utf8(movedFrom),
            toolUseId: callId,
            source: "apply_patch",
          },
        });
        body.push({
          ts,
          type: "file.diff",
          payload: fileDiffPayload(c.move_path, null, moved, null, callId, "apply_patch"),
        });
        known.delete(path);
        known.set(c.move_path, moved);
        continue;
      }
      const before = known.get(path);
      if (before === undefined) {
        // The file predates this session: Codex recorded the diff but never
        // the base, so no hash here would be verifiable.
        skip("patch_apply:update(base content not in log)");
        continue;
      }
      let after: string;
      try {
        after = applyUnifiedDiff(before, c.unified_diff);
      } catch {
        // Our reconstruction and the runtime's diff disagree — emitting a
        // hash now would assert something unproven.
        skip("patch_apply:update(diff did not apply)");
        continue;
      }
      body.push({
        ts,
        type: "file.diff",
        payload: fileDiffPayload(path, before, after, c.unified_diff, callId, "apply_patch"),
      });
      known.set(path, after);
      continue;
    }

    if (kind === "delete") {
      // Codex records the file's content at deletion. That is the content
      // actually removed, so it wins over agit's own reconstruction — and if
      // the two differ, replay flags it through beforeHash, exactly as it
      // does for a file.diff whose before contradicts the last known content.
      const recorded = typeof c.content === "string" ? c.content : undefined;
      const before = recorded ?? known.get(path);
      if (before === undefined) {
        skip("patch_apply:delete(content not recorded and not in log)");
        continue;
      }

      body.push({
        ts,
        type: "file.delete",
        payload: {
          path,
          beforeHash: sha256Utf8(before),
          toolUseId: callId,
          source: "apply_patch",
        },
      });
      known.delete(path);
      continue;
    }
    skip(`patch_apply:${kind || "?"}`);
  }
}

/** Same payload shape the Claude Code adapter emits, so views need no special cases. */
function fileDiffPayload(
  path: string,
  before: string | null,
  after: string,
  runtimeDiff: string | null,
  toolUseId: string,
  source: string,
): { [key: string]: Json } {
  return {
    path,
    kind: before === null ? "create" : "modify",
    diff: runtimeDiff ?? synthesizeDiff(path, before, after),
    beforeHash: before === null ? null : sha256Utf8(before),
    afterHash: sha256Utf8(after),
    toolUseId,
    source,
  };
}

/** A correct, if unminimized, full-file diff — used when the runtime gave none (adds). */
function synthesizeDiff(path: string, before: string | null, after: string): string {
  const header = before === null ? `--- /dev/null\n+++ b/${path}` : `--- a/${path}\n+++ b/${path}`;
  const split = (s: string): string[] => {
    if (s === "") return [];
    const lines = s.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const b = before === null ? [] : split(before);
  const a = split(after);
  const lines = [...b.map((l) => `-${l}`), ...a.map((l) => `+${l}`)];
  return `${header}\n@@ -${b.length === 0 ? 0 : 1},${b.length} +${a.length === 0 ? 0 : 1},${a.length} @@\n${lines.join("\n")}\n`;
}

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

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
