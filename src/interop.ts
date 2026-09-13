/**
 * Interop exports (issue #69): OpenTelemetry GenAI traces and ATIF
 * trajectories.
 *
 * The README says agit is not an observability platform. The stronger version
 * of that sentence is that agit can *feed* every one of them, with a log that
 * verifies. Both of these are pure views over the events already stored —
 * nothing here changes SPEC, and nothing is recorded that was not already
 * there.
 *
 * **Determinism.** Trace and span ids are derived from the session id and
 * from each event's own hash, never generated. Exporting the same session
 * twice gives byte-identical output (SPEC §7), and more usefully, a span id
 * is a prefix of the hash of the event it came from — so a trace sitting in
 * Grafana can be tied back to a specific line of a log you can verify. The
 * full hash rides along as an attribute too, because a 64-bit prefix is a
 * convenience, not a proof.
 *
 * **What neither format can carry.** `file.diff` events have no home in
 * either schema: OpenTelemetry has no file-edit span and ATIF has no
 * file-edit step. They are attached as extras rather than dropped or bent
 * into a shape that means something else, and the SPEC §5.7 lower bound is
 * stated in the output so a downstream eval does not read "3 files" as "the
 * files this session changed". That includes an edit whose tool call the log
 * does not contain (Codex records a patch apply without a function call):
 * it rides on the root span and on the step it happened during, because an
 * edit nothing claims is still an edit the log holds.
 *
 * **Refusals.** A document the receiving side would reject is worse than no
 * document, so both exporters throw, with the reason, where a faithful one
 * cannot be made: a token count outside int64 or with a fraction, or a
 * session with nothing ATIF can make a step from. The CLI turns that into a
 * line on stderr and exit 1 rather than exit 0 and invalid JSON on stdout.
 */

import { createHash } from "node:crypto";
import type { AgitEvent, Json, SessionMeta } from "./format/events.js";
import { fileStateAt } from "./state.js";
import { verifySignature } from "./sign.js";

// --- shared -----------------------------------------------------------------

function payload(e: AgitEvent): Record<string, Json> {
  return e.payload as Record<string, Json>;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function firstOf(events: AgitEvent[], type: string, key: string): string | null {
  for (const e of events) if (e.type === type) return str(payload(e)[key]);
  return null;
}

/** Flatten an assistant event's text blocks. Thinking blocks are kept separate. */
function assistantText(e: AgitEvent): { text: string; thinking: string } {
  const blocks = payload(e).blocks;
  if (!Array.isArray(blocks)) return { text: "", thinking: "" };
  const pick = (kind: string): string =>
    blocks
      .filter((b): b is Record<string, Json> => typeof b === "object" && b !== null && !Array.isArray(b))
      .filter((b) => b.type === kind)
      .map((b) => str(b.text) ?? "")
      .join("\n");
  return { text: pick("text"), thinking: pick("thinking") };
}

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

/**
 * Token counts, checked rather than passed through. OTLP's intValue and
 * ATIF's Metrics are both int64, and the adapters forward whatever number the
 * native log carried: 1e21 stringifies as "1e+21" and 1.5 stays 1.5, and
 * either is a document the collector or Harbor rejects after agit has exited
 * 0. A count neither format can carry is a refusal naming the event, not a
 * clamp that reports a number the log does not contain.
 */
function usageOf(e: AgitEvent): Partial<Record<(typeof USAGE_KEYS)[number], number>> {
  const u = payload(e).usage;
  if (typeof u !== "object" || u === null || Array.isArray(u)) return {};
  const out: Partial<Record<(typeof USAGE_KEYS)[number], number>> = {};
  for (const k of USAGE_KEYS) {
    const v = u[k];
    if (typeof v !== "number") continue;
    if (!Number.isInteger(v) || Math.abs(v) >= 2 ** 63) {
      throw new Error(
        `refusing to export: event ${e.seq} usage.${k} is ${v}, not an integer within int64, ` +
          "which is the only token count OTLP and ATIF can carry",
      );
    }
    out[k] = v;
  }
  return out;
}

/**
 * Which result and which edits belong to which tool call, decided by position
 * rather than by id alone. Ids are not unique in every log: the Cline SDK
 * adapter writes "(missing)" for every block that had none, so a map keyed by
 * id gave every call the *last* result under that id, and a call that failed
 * was exported as the success that came after it. A result goes to the
 * earliest call with its id still waiting for one; an edit goes to the latest
 * call with its id seen so far, since edits follow the call that made them.
 * Edits naming no call the log contains are returned on their own, so both
 * exporters can keep them rather than drop them. So are results: a result
 * with no id (the Cline SDK adapter records a block that had none as
 * `toolUseId: null` and counts it, rather than inventing an id that would
 * pair it with the wrong call) or with an id no waiting call carries is
 * not paired by position either — that would be the same guess with less
 * evidence — but its output is still in the log, so it is still exported,
 * as a result that names no call.
 */
function pairToolEvents(events: AgitEvent[]): {
  resultOf: Map<AgitEvent, AgitEvent>;
  editsOf: Map<AgitEvent, AgitEvent[]>;
  unclaimedEdits: Set<AgitEvent>;
  unclaimedResults: Set<AgitEvent>;
} {
  const resultOf = new Map<AgitEvent, AgitEvent>();
  const editsOf = new Map<AgitEvent, AgitEvent[]>();
  const unclaimedEdits = new Set<AgitEvent>();
  const unclaimedResults = new Set<AgitEvent>();
  const awaitingResult = new Map<string, AgitEvent[]>();
  const latestCall = new Map<string, AgitEvent>();
  for (const e of events) {
    const isEdit = e.type === "file.diff" || e.type === "file.delete";
    const id = str(payload(e).toolUseId);
    if (id === null) {
      if (isEdit) unclaimedEdits.add(e);
      else if (e.type === "tool.result") unclaimedResults.add(e);
    } else if (e.type === "tool.call") {
      awaitingResult.set(id, [...(awaitingResult.get(id) ?? []), e]);
      latestCall.set(id, e);
    } else if (e.type === "tool.result") {
      const call = awaitingResult.get(id)?.shift();
      if (call !== undefined) resultOf.set(call, e);
      else unclaimedResults.add(e);
    } else if (isEdit) {
      const call = latestCall.get(id);
      if (call === undefined) unclaimedEdits.add(e);
      else editsOf.set(call, [...(editsOf.get(call) ?? []), e]);
    }
  }
  return { resultOf, editsOf, unclaimedEdits, unclaimedResults };
}

/**
 * `agitSigned` used to be a presence check, so a rechained log still carrying
 * its original signature (the forgery `agit verify` exists to catch) was
 * exported as signed provenance. Each record is checked against the head
 * meta.json names, the same check `verify` runs, and the document says which
 * ones held.
 */
function signatureVerdicts(
  meta: SessionMeta | null,
): { keyFingerprint: string | null; at: string | null; ok: boolean }[] {
  const sigs = Array.isArray(meta?.signatures) ? meta.signatures : [];
  const head = {
    sessionId: meta?.sessionId ?? "",
    headHash: meta?.headHash ?? "",
    eventCount: meta?.eventCount ?? 0,
  };
  return sigs.map((s) => {
    // meta.json can arrive in someone else's bundle, so a record is not
    // trusted to be an object until it has been checked.
    if (typeof s !== "object" || s === null) return { keyFingerprint: null, at: null, ok: false };
    const v = verifySignature(s, head);
    return { keyFingerprint: v.fingerprint ?? str(s.keyFingerprint), at: str(s.at), ok: v.ok };
  });
}

// --- OpenTelemetry ----------------------------------------------------------

/**
 * A trace id must be 16 bytes and a span id 8, both hex. Deriving them from
 * content rather than randomness is what makes the export reproducible and
 * lets a span be traced back to the event that produced it.
 */
function traceId(sessionId: string): string {
  return createHash("sha256").update(`agit-trace:${sessionId}`).digest("hex").slice(0, 32);
}

function spanId(eventHash: string): string {
  return eventHash.slice(0, 16);
}

/**
 * The root is anchored to the first event's hash, but in its own namespace:
 * nothing requires seq 0 to be session.start, and a chain that opens with a
 * tool call or a cost event would otherwise give the root and that event's
 * own span one id, with the child listed as its own parent.
 */
function rootSpanId(firstHash: string): string {
  return createHash("sha256").update(`agit-root:${firstHash}`).digest("hex").slice(0, 16);
}

/** An ISO date-time with no zone designator: no trailing Z and no offset. */
const ZONELESS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

function nanos(ts: string): string {
  // SPEC §2 says `ts` is UTC, but the ATIF adapter stores a step's timestamp
  // as it came, and Python's naive isoformat() carries no zone designator.
  // ECMAScript reads such a string as local time, so one verified log
  // exported on two machines gave two different traces. A date-time with no
  // designator is read as the UTC the SPEC declares it to be.
  const ms = Date.parse(ZONELESS.test(ts) ? `${ts}Z` : ts);
  // OTLP/JSON carries nanosecond timestamps as decimal strings, because they
  // do not fit a double without losing the low digits.
  return Number.isFinite(ms) ? String(BigInt(ms) * 1_000_000n) : "0";
}

type OtlpValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };

function attr(
  key: string,
  value: string | number | boolean | null,
): { key: string; value: OtlpValue } | null {
  if (value === null) return null;
  if (typeof value === "number") return { key, value: { intValue: String(Math.trunc(value)) } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

function attrs(pairs: [string, string | number | boolean | null][]): { key: string; value: OtlpValue }[] {
  return pairs.map(([k, v]) => attr(k, v)).filter((a): a is { key: string; value: OtlpValue } => a !== null);
}

export interface OtelOptions {
  /** Reported as gen_ai.provider.name; falls back to the runtime the log names. */
  provider?: string;
}

/**
 * The only schema URL the GenAI conventions offer. It ends in `-dev` because
 * that repository has never cut a release or a tag.
 */
export const GENAI_SCHEMA_URL = "https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev";

/**
 * OTLP/JSON spans following the OpenTelemetry GenAI semantic conventions.
 *
 * **These conventions are a moving target and this export says so.** They are
 * at Development stability, they moved out of the core semantic-conventions
 * repo into `semantic-conventions-genai` during 2026, and that repo has no
 * releases or tags — so there is no stable version to pin, only the `-dev`
 * schema URL emitted above. Recent breaking changes renamed
 * `gen_ai.system` to `gen_ai.provider.name` and `cache_creation` to
 * `cache_write`, both of which this targets. Expect to update it.
 *
 * Names here follow `model/gen-ai/spans.yaml`: `invoke_agent {agent}`,
 * `execute_tool {tool}`, and `{operation} {model}` for inference.
 */
export function toOtlpJson(
  events: AgitEvent[],
  meta: SessionMeta | null,
  opts: OtelOptions = {},
): Record<string, unknown> {
  const sessionId = events[0]?.session ?? meta?.sessionId ?? "unknown";
  const trace = traceId(sessionId);
  const runtime = firstOf(events, "session.start", "runtime") ?? "unknown";
  const provider = opts.provider ?? runtime;
  const cwd = firstOf(events, "session.start", "cwd");
  const first = events[0];
  const last = events[events.length - 1];

  const spans: Record<string, unknown>[] = [];

  const { resultOf, editsOf, unclaimedResults } = pairToolEvents(events);
  const pathsOf = (edits: AgitEvent[]): string[] =>
    edits.map((e) => str(payload(e).path)).filter((p): p is string => p !== null);
  // Every recorded edit, including one no tool call claims: the root span is
  // the only place in a trace where such an edit can appear at all.
  const allFiles = [
    ...new Set(pathsOf(events.filter((e) => e.type === "file.diff" || e.type === "file.delete"))),
  ].sort();

  // The root: the session itself. Its span id comes from the first event's
  // hash, so the whole trace is anchored to a line of the log.
  const rootId = first ? rootSpanId(first.hash) : "0".repeat(16);
  spans.push({
    traceId: trace,
    spanId: rootId,
    name: `invoke_agent ${runtime}`,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(first?.ts ?? ""),
    endTimeUnixNano: nanos(last?.ts ?? first?.ts ?? ""),
    attributes: attrs([
      ["gen_ai.operation.name", "invoke_agent"],
      ["gen_ai.provider.name", provider],
      ["gen_ai.agent.name", runtime],
      ["gen_ai.conversation.id", sessionId],
      ["agit.session.id", sessionId],
      ["agit.head.hash", meta?.headHash ?? null],
      ["agit.event.count", events.length],
      ["agit.schema.version", first?.v ?? null],
      // A bundle adopted from someone else keeps its meta.json verbatim, and
      // that file need not carry an adapter at all.
      ["agit.adapter.name", meta?.adapter?.name ?? null],
      ["agit.adapter.version", meta?.adapter?.version ?? null],
      ["agit.cwd", cwd],
      // Structured edits only (SPEC §5.7), named so nobody reads this as
      // the complete set of files the session touched.
      ["agit.files.recorded", allFiles.length > 0 ? allFiles.join("\n") : null],
      ["agit.files.lower_bound", allFiles.length > 0 ? true : null],
      // A result no call claims has no execute_tool span to end; a trace has
      // nowhere else to put it, so the root names the events by hash rather
      // than letting them vanish from the export.
      [
        "agit.tool_results.unpaired",
        unclaimedResults.size > 0 ? [...unclaimedResults].map((e) => e.hash).join("\n") : null,
      ],
    ]),
    status: { code: 0 },
  });

  for (const e of events) {
    if (e.type === "cost") {
      const u = usageOf(e);
      spans.push({
        traceId: trace,
        spanId: spanId(e.hash),
        parentSpanId: rootId,
        name: `chat ${str(payload(e).model) ?? "unknown"}`,
        kind: 3, // SPAN_KIND_CLIENT
        startTimeUnixNano: nanos(e.ts),
        endTimeUnixNano: nanos(e.ts),
        attributes: attrs([
          ["gen_ai.operation.name", "chat"],
          ["gen_ai.provider.name", provider],
          ["gen_ai.request.model", str(payload(e).model)],
          ["gen_ai.usage.input_tokens", u.inputTokens ?? null],
          ["gen_ai.usage.output_tokens", u.outputTokens ?? null],
          ["gen_ai.conversation.id", sessionId],
          // Cache tokens belong on the inference span, not the agent span:
          // aggregating them across models misleads (semconv-genai #469).
          // `cache_write` is the current name; it was `cache_creation` (#440).
          ["gen_ai.usage.cache_read.input_tokens", u.cacheReadInputTokens ?? null],
          ["gen_ai.usage.cache_write.input_tokens", u.cacheCreationInputTokens ?? null],
          ["agit.event.seq", e.seq],
          ["agit.event.hash", e.hash],
        ]),
        status: { code: 0 },
      });
      continue;
    }

    if (e.type === "tool.call") {
      const id = str(payload(e).toolUseId);
      // A tool span ends when its result arrived rather than being
      // zero-length, so the result has to be this call's own.
      const result = resultOf.get(e);
      const failed = result !== undefined && payload(result).isError === true;
      const files = pathsOf(editsOf.get(e) ?? []);
      spans.push({
        traceId: trace,
        spanId: spanId(e.hash),
        parentSpanId: rootId,
        // `execute_tool {gen_ai.tool.name}`, per spans.yaml in the GenAI repo.
        name: `execute_tool ${str(payload(e).name) ?? "unknown"}`,
        kind: 1, // INTERNAL: gen_ai.execute_tool.internal
        startTimeUnixNano: nanos(e.ts),
        endTimeUnixNano: nanos(result?.ts ?? e.ts),
        attributes: attrs([
          ["gen_ai.operation.name", "execute_tool"],
          ["gen_ai.provider.name", provider],
          ["gen_ai.tool.name", str(payload(e).name)],
          ["gen_ai.tool.call.id", id],
          ["gen_ai.conversation.id", sessionId],
          ["agit.event.seq", e.seq],
          ["agit.event.hash", e.hash],
          // Structured edits only (SPEC §5.7) — named so nobody reads this
          // as the complete set of files the tool touched.
          ["agit.files.recorded", files.length > 0 ? files.join("\n") : null],
          ["agit.files.lower_bound", files.length > 0 ? true : null],
        ]),
        status: failed ? { code: 2, message: "tool reported an error" } : { code: 0 },
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrs([
            ["service.name", "agit"],
            ["agit.session.id", sessionId],
            ["agit.runtime", runtime],
          ]),
        },
        scopeSpans: [
          {
            scope: { name: "agit", version: meta?.adapter?.version ?? "0" },
            // The GenAI conventions have never cut a release: there is no
            // stable schema URL to pin, only this -dev one. Saying which
            // moving target this was built against beats implying a version.
            schemaUrl: GENAI_SCHEMA_URL,
            spans,
          },
        ],
      },
    ],
  };
}

// --- ATIF -------------------------------------------------------------------

/** The revision this exporter targets; ATIF carries it in every document. */
export const ATIF_SCHEMA_VERSION = "ATIF-v1.8";

interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, Json>;
  extra?: Record<string, Json>;
}

interface AtifStep {
  step_id: number;
  timestamp: string;
  source: "system" | "user" | "agent";
  message: string;
  model_name?: string;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: { source_call_id?: string; content?: string; extra?: Record<string, Json> }[] };
  metrics?: Record<string, number>;
  /** How many model calls this step's metrics cover; ATIF's own field for it. */
  llm_call_count?: number;
  extra?: Record<string, Json>;
}

/**
 * Harbor's Agent Trajectory Interchange Format, as specified in that
 * project's RFC 0001 and implemented by its Pydantic models.
 *
 * **Every ATIF model sets `extra: "forbid"`.** An unknown key is a rejected
 * document rather than a field quietly ignored, so anything agit wants to add
 * goes in an `extra` dict and the field names below have to be exact. Two
 * that are easy to get wrong: `Agent.version` is required, and `FinalMetrics`
 * uses `total_prompt_tokens` rather than the `prompt_tokens` that per-step
 * `Metrics` uses.
 *
 * The mapping is not one-to-one and the places it is not are worth naming:
 *
 * - agit records one event per tool call; ATIF hangs tool calls off the
 *   agent step that made them, so calls are folded back onto the preceding
 *   assistant message and their results into that step's `observation`.
 * - `file.diff` has no ATIF equivalent. The edits are attached to the
 *   observation of the call that made them, in `extra` with their verified
 *   hashes, which is where ATIF puts anything it does not model. That beats
 *   dropping provenance a verified log has and an ordinary trajectory does
 *   not. An edit whose call the log does not contain goes on the step it
 *   happened during, under `agitFileEditsWithoutCall`, with the same hashes.
 * - Thinking blocks map to `reasoning_content`, which is what it is for.
 */
export function toAtif(events: AgitEvent[], meta: SessionMeta | null): Record<string, unknown> {
  const sessionId = events[0]?.session ?? meta?.sessionId ?? "unknown";
  const runtime = firstOf(events, "session.start", "runtime") ?? "unknown";
  const runtimeVersion = firstOf(events, "session.start", "runtimeVersion");

  const { resultOf, editsOf, unclaimedEdits, unclaimedResults } = pairToolEvents(events);
  const editRecord = (e: AgitEvent): Record<string, Json> => {
    const p = payload(e);
    return {
      path: p.path ?? null,
      kind: e.type === "file.delete" ? "delete" : (p.kind ?? null),
      beforeHash: p.beforeHash ?? null,
      afterHash: p.afterHash ?? null,
      agitEventHash: e.hash,
    };
  };

  const steps: AtifStep[] = [];
  let stepId = 1;
  const push = (s: Omit<AtifStep, "step_id">): AtifStep => {
    const step = { step_id: stepId++, ...s };
    steps.push(step);
    return step;
  };

  let lastAgentStep: AtifStep | null = null;
  const models = new Set<string>();

  for (const e of events) {
    switch (e.type) {
      case "message.user":
        lastAgentStep = null;
        push({
          timestamp: e.ts,
          source: "user",
          message: str(payload(e).text) ?? "",
          extra: { agitEventSeq: e.seq, agitEventHash: e.hash },
        });
        break;

      case "message.assistant": {
        const { text, thinking } = assistantText(e);
        const model = str(payload(e).model);
        if (model !== null) models.add(model);
        lastAgentStep = push({
          timestamp: e.ts,
          source: "agent",
          message: text,
          ...(model !== null ? { model_name: model } : {}),
          ...(thinking !== "" ? { reasoning_content: thinking } : {}),
          extra: { agitEventSeq: e.seq, agitEventHash: e.hash },
        });
        break;
      }

      case "tool.call": {
        const id = str(payload(e).toolUseId) ?? `seq-${e.seq}`;
        const input = payload(e).input;
        const call: AtifToolCall = {
          tool_call_id: id,
          function_name: str(payload(e).name) ?? "unknown",
          arguments: typeof input === "object" && input !== null && !Array.isArray(input) ? input : {},
          extra: { agitEventSeq: e.seq, agitEventHash: e.hash },
        };
        // A tool call with no assistant message before it (a runtime that
        // records them separately) still belongs somewhere: give it a step.
        const host =
          lastAgentStep ??
          (lastAgentStep = push({
            timestamp: e.ts,
            source: "agent",
            message: "",
            extra: { agitSynthesized: true, agitNote: "no assistant message preceded this tool call" },
          }));
        host.tool_calls = [...(host.tool_calls ?? []), call];

        // This call's own result and edits, by position: a second call under
        // the same id must not inherit the first one's, and a result whose id
        // happens to spell `seq-N` must not attach to a call that had none.
        const result = resultOf.get(e);
        const edits = editsOf.get(e)?.map(editRecord);
        if (result !== undefined || edits !== undefined) {
          host.observation = host.observation ?? { results: [] };
          host.observation.results.push({
            source_call_id: id,
            ...(result !== undefined ? { content: str(payload(result).output) ?? "" } : {}),
            extra: {
              ...(result !== undefined
                ? { isError: payload(result).isError ?? false, agitEventHash: result.hash }
                : {}),
              ...(edits !== undefined ? { agitFileEdits: edits } : {}),
            },
          });
        }
        break;
      }

      case "tool.result": {
        // Paired results were written into their call's observation above.
        // One that names no call the log contains still happened, and ATIF
        // has a shape for exactly that: an observation result without a
        // `source_call_id`, which its own definition reserves for output
        // from outside the tool-calling format. It goes on the step it
        // followed, unpaired, rather than being dropped.
        if (!unclaimedResults.has(e)) break;
        const host =
          lastAgentStep ??
          (lastAgentStep = push({
            timestamp: e.ts,
            source: "agent",
            message: "",
            extra: { agitSynthesized: true, agitNote: "no assistant message preceded this tool result" },
          }));
        host.observation = host.observation ?? { results: [] };
        host.observation.results.push({
          content: str(payload(e).output) ?? "",
          extra: {
            isError: payload(e).isError ?? false,
            agitEventHash: e.hash,
            agitNote: "names no tool call the log contains",
          },
        });
        break;
      }

      case "file.diff":
      case "file.delete": {
        // Credited edits were written into their call's observation above.
        // One that names no call the log contains still happened, so it goes
        // on the step it happened during, hashes and all, rather than
        // surviving only as a bare path in the session-level file list.
        if (!unclaimedEdits.has(e)) break;
        const host =
          lastAgentStep ??
          (lastAgentStep = push({
            timestamp: e.ts,
            source: "agent",
            message: "",
            extra: { agitSynthesized: true, agitNote: "no assistant message preceded this file edit" },
          }));
        const prior = host.extra?.agitFileEditsWithoutCall;
        host.extra = {
          ...(host.extra ?? {}),
          agitFileEditsWithoutCall: [
            ...(Array.isArray(prior) ? prior : []),
            { toolUseId: payload(e).toolUseId ?? null, ...editRecord(e) },
          ],
        };
        break;
      }

      case "cost": {
        // Usage belongs on the agent step it paid for.
        if (lastAgentStep === null) break;
        const u = usageOf(e);
        // ATIF's Metrics is per step, so several cost events between two
        // assistant messages fold into one object. `llm_call_count` is the
        // field that says how many, and without it a reader sees five steps
        // and concludes there were five calls when there were seven.
        lastAgentStep.llm_call_count = (lastAgentStep.llm_call_count ?? 0) + 1;
        lastAgentStep.metrics = {
          ...(lastAgentStep.metrics ?? {}),
          prompt_tokens: (lastAgentStep.metrics?.prompt_tokens ?? 0) + (u.inputTokens ?? 0),
          completion_tokens: (lastAgentStep.metrics?.completion_tokens ?? 0) + (u.outputTokens ?? 0),
          cached_tokens: (lastAgentStep.metrics?.cached_tokens ?? 0) + (u.cacheReadInputTokens ?? 0),
        };
        break;
      }

      default:
        break;
    }
  }

  const totals = events
    .filter((e) => e.type === "cost")
    .reduce(
      (acc, e) => {
        const u = usageOf(e);
        acc.prompt_tokens += u.inputTokens ?? 0;
        acc.completion_tokens += u.outputTokens ?? 0;
        acc.cached_tokens += u.cacheReadInputTokens ?? 0;
        acc.llm_calls += 1;
        return acc;
      },
      { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, llm_calls: 0 },
    );

  // Harbor's Trajectory model requires at least one step, and a log of only
  // session.start and session.end (a Claude Code record whose content array
  // is empty imports that way) has nothing to make one from. An empty list
  // is a document Harbor rejects, so this refuses with the reason rather
  // than exiting 0 behind invalid output.
  if (steps.length === 0) {
    throw new Error(
      `refusing to export: ${sessionId} has no message, tool or file events, and ATIF requires at least one step`,
    );
  }

  const editedPaths = new Set<string>();
  for (const e of events) {
    if (e.type !== "file.diff" && e.type !== "file.delete") continue;
    const path = str(payload(e).path);
    if (path !== null) editedPaths.add(path);
  }
  const signatures = signatureVerdicts(meta);

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: {
      name: runtime,
      // `version` is required, not optional. A runtime that does not report
      // one still needs the field, and saying "unknown" is honest where
      // omitting it would simply fail validation.
      version: runtimeVersion ?? "unknown",
      ...(models.size > 0 ? { model_name: [...models].sort()[0] } : {}),
    },
    steps,
    // FinalMetrics does NOT reuse the per-step Metrics names: it is
    // total_prompt_tokens, not prompt_tokens. Every ATIF model sets
    // `extra: "forbid"`, so a near-miss name is a rejected document, not a
    // field quietly ignored.
    final_metrics: {
      total_steps: steps.length,
      total_prompt_tokens: totals.prompt_tokens,
      total_completion_tokens: totals.completion_tokens,
      total_cached_tokens: totals.cached_tokens,
      extra: { llmCalls: totals.llm_calls },
    },
    extra: {
      // Provenance an ordinary trajectory cannot carry: this one came from a
      // hash-chained log, and every step names the event it came from.
      source: "agit",
      agitSessionId: sessionId,
      agitHeadHash: meta?.headHash ?? null,
      agitEventCount: events.length,
      agitSchemaVersion: events[0]?.v ?? null,
      agitAdapter: meta?.adapter ? `${meta.adapter.name}@${meta.adapter.version}` : null,
      // True only when every signature on the head verifies, which is the
      // verdict `agit verify` gives; a signature that is merely present is
      // what a forged log carries too.
      agitSigned: signatures.length > 0 && signatures.every((s) => s.ok),
      agitSignatures: signatures,
      agitFilesRecorded: [...editedPaths].sort(),
      agitFilesAreLowerBound:
        "Structured edits only. Files changed by shell commands leave no record (SPEC 5.7), " +
        "so this is a floor on what the session touched, not the complete set.",
      agitVerifyWith: `agit verify ${sessionId}`,
    },
  };
}

// --- Markdown ------------------------------------------------------------

/**
 * Inline code that stays inline whatever the text holds: a run of backticks
 * one longer than any inside, and a space on each side when the text starts
 * or ends with one (CommonMark strips exactly one). A tool name or path
 * with a backtick in it used to close the span and turn the rest into
 * Markdown structure.
 */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** A fenced block whose fence is longer than any backtick run inside it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text}\n${ticks}`;
}

/** A GFM table cell: a pipe would end it, a newline would end the row. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * A session as a Markdown audit report — the view that drops into a PR
 * body or a review ticket. A fold over the stored events, like the other
 * exporters, and refused for an unverified session by the same gate.
 *
 * Everything a log contributes is untrusted text: message bodies and tool
 * output go into fenced blocks, names and paths into inline code, both
 * built so the text cannot close them; a table cell escapes its pipes. An
 * "audit" that let a user message turn itself into a heading, or a file
 * the agent read aloud plant a tracking image, would be worse than none.
 *
 * Token totals come from the cost events' `usage` (SPEC §5.9), all four
 * counts, the same fold `agit stats` runs. The file list is the structured
 * edits the log holds and says so (SPEC §5.7). The report states what the
 * store established about the log — chain verified, signatures and their
 * verdicts — rather than leaving a reader to assume it.
 */
export function toMarkdown(events: AgitEvent[], meta: SessionMeta | null): string {
  const sessionId = events[0]?.session ?? meta?.sessionId ?? "unknown";
  const runtime = firstOf(events, "session.start", "runtime") ?? "unknown";
  const runtimeVersion = firstOf(events, "session.start", "runtimeVersion");
  const cwd = firstOf(events, "session.start", "cwd");
  const first = events[0];
  const last = events[events.length - 1];

  const out: string[] = [];
  out.push(`# Session audit: ${inlineCode(sessionId)}`, "");
  out.push(`- **Runtime**: ${inlineCode(runtime)}${runtimeVersion ? ` ${inlineCode(runtimeVersion)}` : ""}`);
  if (cwd !== null) out.push(`- **Working directory**: ${inlineCode(cwd)}`);
  if (first && last) out.push(`- **Span**: ${first.ts} to ${last.ts}`);
  out.push(`- **Events**: ${events.length}`);
  if (last) out.push(`- **Head hash**: ${inlineCode(last.hash)}`);
  // `agit export` refuses a session whose chain does not verify, so a
  // report that exists is a report over a verified chain.
  out.push(`- **Chain**: verified, ${events.length} event${events.length === 1 ? "" : "s"} hash-linked`);
  const sigs = signatureVerdicts(meta);
  if (sigs.length === 0) {
    out.push("- **Signatures**: none (unsigned)");
  } else {
    for (const s of sigs) {
      out.push(
        `- **Signature**: ${s.ok ? "verifies" : "DOES NOT MATCH"} — key ${inlineCode(s.keyFingerprint ?? "(unreadable)")}` +
          (s.at !== null ? ` at ${s.at}` : ""),
      );
    }
  }
  if (meta?.importedAt) out.push(`- **Imported**: ${meta.importedAt}`);
  out.push("");

  // Usage: the same fold as `agit stats`, over the four counts SPEC §5.9 names.
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const models = new Set<string>();
  let calls = 0;
  for (const e of events) {
    if (e.type !== "cost") continue;
    calls++;
    const u = usageOf(e);
    usage.inputTokens += u.inputTokens ?? 0;
    usage.outputTokens += u.outputTokens ?? 0;
    usage.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    usage.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
    const model = str(payload(e).model);
    if (model !== null) models.add(model);
  }
  if (calls > 0) {
    const n = (v: number): string => v.toLocaleString("en-US");
    out.push("## Usage", "");
    out.push(
      `- **Models**: ${models.size > 0 ? [...models].sort().map(inlineCode).join(", ") : "(not recorded)"}`,
    );
    out.push(`- **API messages**: ${calls}`);
    out.push(`- **Input tokens**: ${n(usage.inputTokens)}`);
    out.push(`- **Output tokens**: ${n(usage.outputTokens)}`);
    out.push(`- **Cache read tokens**: ${n(usage.cacheReadInputTokens)}`);
    out.push(`- **Cache creation tokens**: ${n(usage.cacheCreationInputTokens)}`);
    out.push("");
  }

  // Files: the same fold `show` and `ls` use — created or modified over the
  // session, deleted if a structured deletion ended it, with the edit count.
  const files = [...fileStateAt(events).values()].sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > 0) {
    out.push("## Files touched", "");
    out.push("| Action | Path | Edits |", "|---|---|---|");
    for (const f of files) {
      const action = f.deletedAtSeq !== undefined ? "delete" : f.kind;
      out.push(`| ${cell(inlineCode(action))} | ${cell(inlineCode(f.path))} | ${f.edits} |`);
    }
    out.push("");
    out.push(
      "> Structured edits only (SPEC §5.7): a file changed through a shell command leaves no record, " +
        "so this is a lower bound on what the session touched, not the complete set.",
      "",
    );
  }

  // Timeline: messages fenced, tool calls named, results by outcome. A
  // heading after a run of list items gets the blank line Markdown wants.
  out.push("## Timeline", "");
  const heading = (h: string): void => {
    if (out[out.length - 1] !== "") out.push("");
    out.push(h, "");
  };
  for (const e of events) {
    const p = payload(e);
    switch (e.type) {
      case "message.user":
        heading(`### ${e.seq} · user · ${e.ts}`);
        out.push(fenced(str(p.text) ?? ""), "");
        break;
      case "message.assistant": {
        const { text, thinking } = assistantText(e);
        const model = str(p.model);
        heading(`### ${e.seq} · assistant · ${e.ts}${model !== null ? ` · ${inlineCode(model)}` : ""}`);
        if (thinking !== "") out.push("Thinking:", "", fenced(thinking), "");
        if (text !== "") out.push(fenced(text), "");
        break;
      }
      case "tool.call":
        out.push(`- **${e.seq} tool call** ${inlineCode(str(p.name) ?? "unknown")}`);
        break;
      case "tool.result":
        out.push(`- **${e.seq} tool result** ${p.isError === true ? "error" : "ok"}`);
        break;
      case "file.diff":
        out.push(`- **${e.seq} file ${str(p.kind) ?? "modify"}** ${inlineCode(str(p.path) ?? "?")}`);
        break;
      case "file.delete":
        out.push(`- **${e.seq} file delete** ${inlineCode(str(p.path) ?? "?")}`);
        break;
      default:
        break;
    }
  }
  return out.join("\n") + "\n";
}
