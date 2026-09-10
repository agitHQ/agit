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
 * files this session changed".
 */

import { createHash } from "node:crypto";
import type { AgitEvent, Json, SessionMeta } from "./format/events.js";

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

function usageOf(e: AgitEvent): Record<string, number> {
  const u = payload(e).usage;
  if (typeof u !== "object" || u === null || Array.isArray(u)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(u)) if (typeof v === "number") out[k] = v;
  return out;
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

function nanos(ts: string): string {
  const ms = Date.parse(ts);
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

  // The root: the session itself. Its span id comes from the first event's
  // hash, so the whole trace is anchored to a line of the log.
  const rootId = first ? spanId(first.hash) : "0".repeat(16);
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
      ["agit.adapter.name", meta?.adapter.name ?? null],
      ["agit.adapter.version", meta?.adapter.version ?? null],
      ["agit.cwd", cwd],
    ]),
    status: { code: 0 },
  });

  // Tool results are matched to their calls by toolUseId so a tool span can
  // end when its result arrived rather than being zero-length.
  const resultOf = new Map<string, AgitEvent>();
  for (const e of events) {
    if (e.type !== "tool.result") continue;
    const id = str(payload(e).toolUseId);
    if (id !== null) resultOf.set(id, e);
  }
  // Files an edit touched, credited to the tool call that produced them.
  const filesOf = new Map<string, string[]>();
  for (const e of events) {
    if (e.type !== "file.diff" && e.type !== "file.delete") continue;
    const id = str(payload(e).toolUseId);
    const path = str(payload(e).path);
    if (id === null || path === null) continue;
    filesOf.set(id, [...(filesOf.get(id) ?? []), path]);
  }

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
      const result = id === null ? undefined : resultOf.get(id);
      const failed = result !== undefined && payload(result).isError === true;
      const files = id === null ? [] : (filesOf.get(id) ?? []);
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
            scope: { name: "agit", version: meta?.adapter.version ?? "0" },
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
 * - `file.diff` has no ATIF equivalent. The edits are attached to the step's
 *   `extra` with their verified hashes, which is where ATIF puts anything it
 *   does not model — better than dropping provenance a verified log has and
 *   an ordinary trajectory does not.
 * - Thinking blocks map to `reasoning_content`, which is what it is for.
 */
export function toAtif(events: AgitEvent[], meta: SessionMeta | null): Record<string, unknown> {
  const sessionId = events[0]?.session ?? meta?.sessionId ?? "unknown";
  const runtime = firstOf(events, "session.start", "runtime") ?? "unknown";
  const runtimeVersion = firstOf(events, "session.start", "runtimeVersion");

  const resultOf = new Map<string, AgitEvent>();
  for (const e of events) {
    if (e.type !== "tool.result") continue;
    const id = str(payload(e).toolUseId);
    if (id !== null) resultOf.set(id, e);
  }
  const editsOf = new Map<string, Record<string, Json>[]>();
  for (const e of events) {
    if (e.type !== "file.diff" && e.type !== "file.delete") continue;
    const id = str(payload(e).toolUseId);
    if (id === null) continue;
    const p = payload(e);
    editsOf.set(id, [
      ...(editsOf.get(id) ?? []),
      {
        path: p.path ?? null,
        kind: e.type === "file.delete" ? "delete" : (p.kind ?? null),
        beforeHash: p.beforeHash ?? null,
        afterHash: p.afterHash ?? null,
        agitEventHash: e.hash,
      },
    ]);
  }

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

        const result = resultOf.get(id);
        const edits = editsOf.get(id);
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

  const editedPaths = new Set<string>();
  for (const list of editsOf.values())
    for (const ed of list) if (typeof ed.path === "string") editedPaths.add(ed.path);

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
      agitSigned: (meta?.signatures ?? []).length > 0,
      agitFilesRecorded: [...editedPaths].sort(),
      agitFilesAreLowerBound:
        "Structured edits only. Files changed by shell commands leave no record (SPEC 5.7), " +
        "so this is a floor on what the session touched, not the complete set.",
      agitVerifyWith: `agit verify ${sessionId}`,
    },
  };
}
