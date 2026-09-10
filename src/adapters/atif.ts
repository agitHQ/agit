/**
 * Adapter for ATIF — Harbor's Agent Trajectory Interchange Format (#64).
 *
 * The first adapter that reads a *standard* rather than one runtime's private
 * log. Anything emitting ATIF imports here: Harbor's own agents, Terminus-2,
 * and whatever its OpenHands adapter converts. It is the import half of the
 * `agit export --atif` pair.
 *
 * Derived from the format's own definition rather than from a captured file:
 * the RFC at harbor-framework/harbor rfcs/0001-trajectory-format.md, and the
 * Pydantic models under laude-institute/harbor
 * src/harbor/models/trajectories/. Field names below are exact because every
 * ATIF model sets `extra: "forbid"`, so a near miss is a rejected document
 * rather than an ignored field.
 *
 * **This adapter emits no `file.diff`, and that is not an oversight.** ATIF
 * has no file-edit construct: a write is an ordinary tool call whose result
 * is prose. agit's file events carry SHA-256 hashes over content it actually
 * holds, and a trajectory does not carry that content. Even a document agit
 * itself exported carries only the *hashes* of the edits in `extra`, never
 * the bytes, so reconstructing file events from it would mean emitting a hash
 * agit did not compute — precisely what every other adapter refuses to do.
 * The edits are counted and named in the import report instead.
 *
 * What that costs: `blame`, `why`, `fork`, `merge` and `diff` have nothing to
 * work with on an ATIF import. What survives: `verify`, `replay`, `grep`,
 * `show`, `stats`, `sign`, `share` and the MCP server, because the
 * conversation, the tool calls and the token usage are all really there.
 *
 * Timestamps are optional in ATIF and mandatory in agit. A step without one
 * inherits the last timestamp seen, which is deterministic and preserves
 * order; how many steps needed that is reported in the import's skip counts,
 * so the inference is never silent. A trajectory with no timestamps anywhere
 * is refused rather than dated from the clock, which would make two imports
 * of the same bytes differ (SPEC §7).
 */

import { createHash } from "node:crypto";
import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "atif";
const ADAPTER_VERSION = "0.1.0";

/** The revision this adapter was written against; older ones are read too. */
export const ATIF_KNOWN_VERSION = "ATIF-v1.8";

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

/** ATIF's `message` is a string or a list of ContentPart; flatten to text. */
function messageText(v: Json | undefined): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .map((part) => {
      const p = asRec(part);
      if (p === undefined) return "";
      if (p.type === "text") return str(p.text) ?? "";
      // Non-text parts are flattened to a marker, the same way the Claude Code
      // adapter handles image blocks: named, not silently dropped.
      const src = asRec(p.source);
      const media = src ? (str(src.media_type) ?? str(p.type)) : str(p.type);
      return `[${media ?? "content"}]`;
    })
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Is this schema version newer than the one the adapter was written against?
 *
 * Compared numerically, not as strings: `ATIF-v1.10` sorts *below*
 * `ATIF-v1.8` lexically, so a string comparison would go quiet at exactly the
 * point the format outgrew one digit.
 */
export function isNewerThanKnown(version: string): boolean {
  const parse = (v: string): number[] =>
    (/^ATIF-v(\d+)\.(\d+)$/.exec(v) ?? []).slice(1).map((n) => Number(n));
  const a = parse(version);
  const b = parse(ATIF_KNOWN_VERSION);
  if (a.length !== 2 || b.length !== 2) return false; // unrecognized shape: not a claim either way
  return a[0]! > b[0]! || (a[0] === b[0] && a[1]! > b[1]!);
}

function parseDocument(lines: string[]): Rec | undefined {
  // One JSON document, however it happens to be wrapped across lines.
  try {
    return asRec(JSON.parse(lines.join("\n")));
  } catch {
    return undefined;
  }
}

function isAtif(doc: Rec | undefined): boolean {
  const v = str(doc?.schema_version);
  return v !== null && v.startsWith("ATIF-v") && Array.isArray(doc?.steps);
}

export const atifAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    return isAtif(parseDocument(lines));
  },

  convert(lines: string[]): ConvertResult {
    const doc = parseDocument(lines);
    if (!isAtif(doc)) throw new Error("not an ATIF trajectory");
    const t = doc!;

    const steps = (t.steps as Json[]).filter((s): s is Rec => asRec(s) !== undefined);
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    if (steps.length === 0) throw new Error("this ATIF trajectory has no steps");

    // A trajectory with no timestamp anywhere cannot be dated without reading
    // the clock, which would break determinism (SPEC §7).
    const anyTs = steps.some((s) => str(s.timestamp) !== null);
    if (!anyTs) {
      throw new Error(
        "this ATIF trajectory carries no timestamps on any step, and agit will not date events from the clock " +
          "(two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const agent = asRec(t.agent) ?? {};
    const runtime = str(agent.name) ?? "atif";

    // A trajectory that names itself keeps its own id. One that does not gets
    // a stable id derived from its bytes, not from the agent's name: two
    // different unnamed trajectories from the same agent would otherwise
    // collide on one id, and the second import would be refused as "already
    // exists with different content".
    const declaredId = str(t.trajectory_id) ?? str(t.session_id);
    const sessionId =
      declaredId ??
      `atif-${runtime}-${createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12)}`;

    // Newer than what this adapter was written against. Read it anyway —
    // ATIF has been additive — but never silently, because a field this
    // adapter cannot see is a field it is dropping.
    const declaredVersion = str(t.schema_version);
    if (declaredVersion !== null && isNewerThanKnown(declaredVersion)) {
      skip(`schema-newer-than-${ATIF_KNOWN_VERSION}:${declaredVersion}`);
    }

    const drafts: DraftEvent[] = [];
    let ts = steps.find((s) => str(s.timestamp) !== null)!.timestamp as string;

    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime,
        runtimeVersion: str(agent.version),
        nativeSessionId: str(t.session_id),
        // ATIF records no working directory. Absent, not guessed.
        cwd: null,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: {
          schemaVersion: str(t.schema_version),
          trajectoryId: str(t.trajectory_id),
          ...(str(t.notes) !== null ? { notes: str(t.notes) } : {}),
        },
      },
    });

    let inferredTs = 0;
    for (const step of steps) {
      const own = str(step.timestamp);
      if (own !== null) ts = own;
      else inferredTs++;

      const source = str(step.source);
      const model = str(step.model_name);

      if (source === "user") {
        drafts.push({
          ts,
          type: "message.user",
          payload: {
            text: messageText(step.message),
            native: { stepId: num(step.step_id) },
          },
        });
      } else if (source === "agent") {
        const text = messageText(step.message);
        const reasoning = str(step.reasoning_content);
        const blocks: Json[] = [];
        // ATIF keeps reasoning in its own field; agit carries it as a
        // thinking block, which is where every other adapter puts it.
        if (reasoning !== null && reasoning !== "") blocks.push({ type: "thinking", text: reasoning });
        if (text !== "") blocks.push({ type: "text", text });
        if (blocks.length > 0) {
          drafts.push({
            ts,
            type: "message.assistant",
            payload: {
              model,
              blocks,
              stopReason: null,
              native: { stepId: num(step.step_id) },
            },
          });
        }
      } else if (source === "system") {
        // agit has no system-message event (SPEC §5). Counted, not bent into
        // a user message it is not.
        skip("system-step");
      } else {
        skip(`unknown-source:${source ?? "(absent)"}`);
      }

      // Tool calls hang off the step in ATIF; agit records one event each, in
      // order, with results matched by the id the trajectory itself uses.
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const results = new Map<string, Rec>();
      const obs = asRec(step.observation);
      if (obs !== undefined && Array.isArray(obs.results)) {
        for (const r of obs.results) {
          const rr = asRec(r);
          const id = rr === undefined ? null : str(rr.source_call_id);
          if (rr !== undefined && id !== null) results.set(id, rr);
        }
      }

      for (const c of calls) {
        const call = asRec(c);
        if (call === undefined) {
          skip("unparseable-tool-call");
          continue;
        }
        const id = str(call.tool_call_id) ?? `atif-step${num(step.step_id)}`;
        drafts.push({
          ts,
          type: "tool.call",
          payload: {
            toolUseId: id,
            name: str(call.function_name) ?? "(unnamed)",
            input: asRec(call.arguments) ?? {},
            native: { stepId: num(step.step_id) },
          },
        });
        const r = results.get(id);
        if (r !== undefined) {
          const extra = asRec(r.extra);
          drafts.push({
            ts,
            type: "tool.result",
            payload: {
              toolUseId: id,
              isError: extra?.isError === true,
              output: messageText(r.content),
              structured: null,
              native: { stepId: num(step.step_id) },
            },
          });
          // A write tool's result is prose here. The file it touched is real
          // but its content is not in the document, so no file.diff can be
          // emitted over bytes agit does not hold.
          if (extra !== undefined && Array.isArray(extra.agitFileEdits)) {
            skip("file-edit-without-content", extra.agitFileEdits.length);
          }
        }
      }

      const metrics = asRec(step.metrics);
      // ATIF's metrics are per step, so one object may cover several model
      // calls; `llm_call_count` says how many. agit emits one cost event
      // either way, because the trajectory records no per-call split to
      // recover — the token totals are right, the call count is a floor, and
      // the difference is counted here rather than left for someone to notice
      // when `stats` disagrees with the source.
      const llmCalls = num(step.llm_call_count);
      if (metrics !== undefined && llmCalls > 1) skip("cost-events-folded-into-one", llmCalls - 1);
      if (metrics !== undefined) {
        drafts.push({
          ts,
          type: "cost",
          payload: {
            model,
            usage: {
              inputTokens: num(metrics.prompt_tokens),
              outputTokens: num(metrics.completion_tokens),
              // ATIF's cached_tokens is a subset of prompt_tokens, and maps to
              // the read side; nothing in the format records cache writes.
              cacheReadInputTokens: num(metrics.cached_tokens),
              cacheCreationInputTokens: 0,
            },
            native: {
              messageId: null,
              requestId: null,
              stepId: num(step.step_id),
              ...(metrics.cost_usd !== undefined ? { costUsd: num(metrics.cost_usd) } : {}),
            },
          },
        });
      }
    }

    // Nested trajectories would have to be linearized into this one, which
    // would attribute a subagent's work to its parent. Counted instead.
    if (Array.isArray(t.subagent_trajectories) && t.subagent_trajectories.length > 0) {
      skip("subagent-trajectory", t.subagent_trajectories.length);
    }
    if (inferredTs > 0) skip("step-timestamp-inherited", inferredTs);

    drafts.push({
      ts,
      type: "session.end",
      payload: { reason: "trajectory-end", synthesized: true },
    });

    return { sessionId, drafts, records: steps.length, skipped };
  },
};
