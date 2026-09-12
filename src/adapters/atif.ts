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
 *
 * A continuation file (Terminus 2 writes one after each context summary)
 * carries the earlier trajectory's steps with `is_copied_context` set. Those
 * are the earlier trajectory's work: importing them again here would record
 * the same messages and tool calls under two sessions, so they are counted
 * and left out, and `continued_trajectory_ref` is kept on session.start so
 * the other file can be found. A result that points at a subagent's
 * trajectory in another file gets the same treatment as an embedded one:
 * counted, with the reference kept, never linearized into this session.
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

/**
 * Is a field there at all? A null is absence, not a wrong type: ATIF's
 * Pydantic models serialize an unset `Optional` as JSON null unless the
 * producer opts into exclude_none, so `tool_calls: null` is an ordinary step
 * with no tool calls, while `tool_calls: {...}` is a producer bug that would
 * otherwise lose every call on the step without a word in the report.
 */
function present(v: Json | undefined): boolean {
  return v !== undefined && v !== null;
}

/** A declared id that is the empty string is no id; a producer that initialises string fields to "" hits this. */
function declaredId(v: Json | undefined): string | null {
  const s = str(v);
  return s === null || s === "" ? null : s;
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

    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    // Every entry of `steps` is a native record, readable or not. The count
    // the import reports is over all of them, and an entry that is not an
    // object is named here rather than filtered out of existence, which used
    // to make meta.json say fewer records than the file holds.
    const entries = t.steps as Json[];
    const steps: Rec[] = [];
    let copied = 0;
    for (const entry of entries) {
      const step = asRec(entry);
      if (step === undefined) {
        skip("unparseable-step");
        continue;
      }
      // A step copied in from an earlier trajectory is that trajectory's
      // work, not this one's. Importing it here too would record the same
      // messages and tool calls under both sessions, and `stats` and `grep`
      // would count them twice. Counted, with the link kept on session.start.
      if (step.is_copied_context === true) {
        copied++;
        continue;
      }
      steps.push(step);
    }
    if (copied > 0) skip("copied-context-step", copied);

    if (steps.length === 0) {
      throw new Error(
        copied > 0
          ? "every step in this ATIF trajectory is copied context from another trajectory; import that one"
          : "this ATIF trajectory has no steps",
      );
    }

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
    // exists with different content". The agent's name is in the id only to
    // be readable in `agit ls`, and it is free text from the document: an
    // agent called "Terminus 2" used to make the whole import refuse over a
    // session id the document never declared, so anything outside what SPEC
    // §1 allows in an id becomes "-".
    const ownId = declaredId(t.trajectory_id) ?? declaredId(t.session_id);
    const sessionId =
      ownId ??
      `atif-${runtime.replace(/[^A-Za-z0-9._-]+/g, "-")}-${createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12)}`;

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
          // The other half of a trajectory split across files. Kept so the
          // steps this import left out as copied context can be found.
          ...(str(t.continued_trajectory_ref) !== null
            ? { continuedTrajectoryRef: str(t.continued_trajectory_ref) }
            : {}),
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
      let calls: Json[] = [];
      if (Array.isArray(step.tool_calls)) calls = step.tool_calls;
      else if (present(step.tool_calls)) skip("tool-calls-not-a-list");

      // Results are grouped under the call id each one names. A result that
      // names none is, by ATIF's own definition, the output of something
      // outside the tool-calling format (an observation on a system step,
      // for instance), and agit has no event for a result with no call:
      // counted, not paired with a call it does not claim. A result naming a
      // call that is not on this step is counted the same way once the calls
      // have been read. Both used to vanish with nothing in the report.
      const results = new Map<string, Rec[]>();
      const obs = asRec(step.observation);
      if (obs === undefined && present(step.observation)) skip("observation-not-an-object");
      if (obs !== undefined && !Array.isArray(obs.results) && present(obs.results)) {
        skip("observation-results-not-a-list");
      }
      if (obs !== undefined && Array.isArray(obs.results)) {
        for (const r of obs.results) {
          const rr = asRec(r);
          if (rr === undefined) {
            skip("unparseable-observation-result");
            continue;
          }
          const id = str(rr.source_call_id);
          if (id === null) {
            skip("observation-result-without-call-id");
            continue;
          }
          results.set(id, [...(results.get(id) ?? []), rr]);
        }
      }

      for (const [i, c] of calls.entries()) {
        const call = asRec(c);
        if (call === undefined) {
          skip("unparseable-tool-call");
          continue;
        }
        // ATIF requires tool_call_id, so this fallback only ever serves a
        // producer that broke the rule. It carries the call's position on the
        // step as well: one id per step let a single result attach to every
        // id-less call on it, a pairing the document never stated.
        const id = str(call.tool_call_id) ?? `atif-step${num(step.step_id)}-${i}`;
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
        // Every result naming this call is recorded, in document order. Two
        // results under one id is the document's own claim about that call;
        // keeping only the last, as this used to, threw the first away
        // without a word, and choosing between them would be a guess.
        for (const r of results.get(id) ?? []) {
          const extra = asRec(r.extra);
          // A result that points at a subagent's trajectory in another file
          // says this call was delegated. The work lives there, not here, so
          // it is counted like an embedded subagent trajectory and the
          // reference is kept so the other file can be found.
          const refs = Array.isArray(r.subagent_trajectory_ref) ? r.subagent_trajectory_ref : [];
          drafts.push({
            ts,
            type: "tool.result",
            payload: {
              toolUseId: id,
              isError: extra?.isError === true,
              output: messageText(r.content),
              structured: null,
              native: {
                stepId: num(step.step_id),
                ...(refs.length > 0 ? { subagentTrajectoryRef: refs } : {}),
              },
            },
          });
          if (refs.length > 0) skip("subagent-trajectory-ref", refs.length);
          // A write tool's result is prose here. The file it touched is real
          // but its content is not in the document, so no file.diff can be
          // emitted over bytes agit does not hold.
          if (extra !== undefined && Array.isArray(extra.agitFileEdits)) {
            skip("file-edit-without-content", extra.agitFileEdits.length);
          }
        }
        results.delete(id);
      }
      for (const orphans of results.values()) skip("observation-result-without-call", orphans.length);

      const metrics = asRec(step.metrics);
      if (metrics === undefined && present(step.metrics)) skip("metrics-not-an-object");
      // ATIF's metrics are per step, so one object may cover several model
      // calls; `llm_call_count` says how many. agit emits one cost event
      // either way, because the trajectory records no per-call split to
      // recover — the token totals are right, the call count is a floor, and
      // the difference is counted here rather than left for someone to notice
      // when `stats` disagrees with the source.
      const llmCalls = num(step.llm_call_count);
      if (metrics !== undefined && llmCalls > 1) skip("cost-events-folded-into-one", llmCalls - 1);
      // ATIF's cost_usd is a dollar figure. SPEC §5.9 keeps those out of the
      // log — a price is a display-time computation from a table, and one
      // hashed into an event is a stale snapshot nobody can verify — so a
      // figure the document holds is counted, not carried. A null is
      // pydantic's None: nothing there to count.
      if (metrics !== undefined && metrics.cost_usd !== undefined && metrics.cost_usd !== null) {
        skip("cost-usd-not-stored (SPEC §5.9)");
      }
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

    return { sessionId, drafts, records: entries.length, skipped };
  },
};
