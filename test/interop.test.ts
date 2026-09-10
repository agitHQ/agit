import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ATIF_SCHEMA_VERSION, GENAI_SCHEMA_URL, toAtif, toOtlpJson } from "../src/interop.js";
import { readSessionEvents, readSessionMeta } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");
const SESSION = "demo-ratelimit-0001";

function agit(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number };
}

function spansOf(doc: Record<string, unknown>): OtlpSpan[] {
  const rs = (doc.resourceSpans as { scopeSpans: { spans: OtlpSpan[] }[] }[])[0]!;
  return rs.scopeSpans[0]!.spans;
}

function attrsOf(s: OtlpSpan): Record<string, unknown> {
  return Object.fromEntries(s.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
}

let store: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-interop-"));
  expect(agit(["import", DEMO, "--dir", store]).code).toBe(0);
  expect(agit(["import", CODEX, "--dir", store]).code).toBe(0);
});

describe("OpenTelemetry GenAI export (#69)", () => {
  it("builds one agent span with chat and tool children", () => {
    const spans = spansOf(toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    const root = spans.find((s) => s.name.startsWith("invoke_agent"))!;
    expect(root.name).toBe("invoke_agent claude-code");
    expect(root.parentSpanId).toBeUndefined();
    // Every other span hangs off the session, so a trace is one tree.
    for (const s of spans.filter((x) => x !== root)) expect(s.parentSpanId).toBe(root.spanId);
    expect(spans.filter((s) => s.name.startsWith("chat ")).length).toBeGreaterThan(0);
    expect(spans.filter((s) => s.name.startsWith("execute_tool ")).length).toBeGreaterThan(0);
  });

  it("names spans the way the conventions do", () => {
    const spans = spansOf(toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    // spans.yaml: `execute_tool {gen_ai.tool.name}` and `{operation} {model}`.
    const tool = spans.find((s) => s.name.startsWith("execute_tool"))!;
    expect(tool.name).toBe(`execute_tool ${attrsOf(tool)["gen_ai.tool.name"] as string}`);
    const chat = spans.find((s) => s.name.startsWith("chat"))!;
    expect(chat.name).toBe(`chat ${attrsOf(chat)["gen_ai.request.model"] as string}`);
  });

  it("uses the current attribute names, not the renamed-away ones", () => {
    const spans = spansOf(toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    const chat = attrsOf(spans.find((s) => s.name.startsWith("chat"))!);
    expect(chat["gen_ai.provider.name"]).toBeDefined();
    // gen_ai.system was renamed to gen_ai.provider.name; cache_creation to
    // cache_write. Emitting the old names would look right and read wrong.
    expect(chat["gen_ai.system"]).toBeUndefined();
    expect(chat["gen_ai.usage.cache_creation.input_tokens"]).toBeUndefined();
    expect(chat["gen_ai.usage.cache_write.input_tokens"]).toBeDefined();
    expect(chat["gen_ai.usage.input_tokens"]).toBe("42");
    expect(chat["gen_ai.usage.output_tokens"]).toBe("180");
  });

  it("derives span ids from event hashes, so a span points at a verifiable line", () => {
    const events = readSessionEvents(store, SESSION);
    const spans = spansOf(toOtlpJson(events, readSessionMeta(store, SESSION)));
    for (const s of spans) {
      const a = attrsOf(s);
      const hash = a["agit.event.hash"] as string | undefined;
      if (hash === undefined) continue;
      // This is the property that makes a trace checkable against the log.
      expect(s.spanId).toBe(hash.slice(0, 16));
      expect(events.some((e) => e.hash === hash)).toBe(true);
    }
  });

  it("is deterministic — no random ids, no wall clock", () => {
    const a = JSON.stringify(toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    const b = JSON.stringify(toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    expect(a).toBe(b);
    // Two sessions must not collide onto one trace.
    const other = spansOf(toOtlpJson(readSessionEvents(store, "0199edit-0000-7aaa-8bbb-ccccdddd0001"), null));
    const mine = spansOf(toOtlpJson(readSessionEvents(store, SESSION), null));
    expect(other[0]!.traceId).not.toBe(mine[0]!.traceId);
  });

  it("emits ids and timestamps in the shapes OTLP requires", () => {
    const spans = spansOf(toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    for (const s of spans) {
      expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      // Nanoseconds go as decimal strings: they do not survive a double.
      expect(s.startTimeUnixNano).toMatch(/^\d+$/);
      expect(BigInt(s.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(s.startTimeUnixNano));
    }
  });

  it("says which moving target it was built against", () => {
    const doc = toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION));
    const scope = (doc.resourceSpans as { scopeSpans: { schemaUrl: string }[] }[])[0]!.scopeSpans[0]!;
    // The GenAI conventions have never cut a release, so this is the only
    // schema URL there is, and it ends in -dev for a reason.
    expect(scope.schemaUrl).toBe(GENAI_SCHEMA_URL);
    expect(scope.schemaUrl).toContain("-dev");
  });

  it("marks a failed tool call on its span status", () => {
    const events = readSessionEvents(store, SESSION).map((e) =>
      e.type === "tool.result" ? { ...e, payload: { ...(e.payload as object), isError: true } } : e,
    );
    const spans = spansOf(toOtlpJson(events, null));
    const tools = spans.filter((s) => s.name.startsWith("execute_tool"));
    expect(tools.every((s) => s.status.code === 2)).toBe(true);
  });

  it("names recorded files as a lower bound rather than a file list", () => {
    const spans = spansOf(toOtlpJson(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    const withFiles = spans.filter((s) => attrsOf(s)["agit.files.recorded"] !== undefined);
    expect(withFiles.length).toBeGreaterThan(0);
    // SPEC 5.7 has to travel with the export, or a dashboard reads "2 files"
    // as the complete set.
    for (const s of withFiles) expect(attrsOf(s)["agit.files.lower_bound"]).toBe(true);
  });
});

describe("ATIF export (#69)", () => {
  it("emits the schema version the format requires", () => {
    const t = toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION));
    expect(t.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(t.schema_version).toMatch(/^ATIF-v/);
    expect(t.session_id).toBe(SESSION);
    expect(t.agent).toMatchObject({ name: "claude-code" });
  });

  it("numbers steps from 1, contiguously, with a valid source on each", () => {
    const t = toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION));
    const steps = t.steps as { step_id: number; source: string; timestamp: string }[];
    expect(steps.length).toBeGreaterThan(0);
    steps.forEach((s, i) => {
      expect(s.step_id).toBe(i + 1);
      expect(["system", "user", "agent"]).toContain(s.source);
      expect(Number.isFinite(Date.parse(s.timestamp))).toBe(true);
    });
  });

  it("folds tool calls onto the agent step that made them, with results in observation", () => {
    const t = toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION));
    const steps = t.steps as {
      source: string;
      tool_calls?: { tool_call_id: string; function_name: string; arguments: object }[];
      observation?: { results: { source_call_id?: string }[] };
    }[];
    const withTools = steps.filter((s) => (s.tool_calls?.length ?? 0) > 0);
    expect(withTools.length).toBeGreaterThan(0);
    for (const s of withTools) {
      expect(s.source).toBe("agent");
      for (const c of s.tool_calls!) {
        expect(c.tool_call_id).toBeTruthy();
        expect(c.function_name).toBeTruthy();
        expect(typeof c.arguments).toBe("object");
        // Every call's result must be findable by its own id.
        const results = s.observation?.results ?? [];
        expect(results.some((r) => r.source_call_id === c.tool_call_id)).toBe(true);
      }
    }
  });

  it("puts thinking in reasoning_content, which is what it is for", () => {
    const t = toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION));
    const steps = t.steps as { reasoning_content?: string }[];
    expect(steps.some((s) => (s.reasoning_content ?? "") !== "")).toBe(true);
  });

  it("carries file edits and their hashes in extra, since ATIF has no edit step", () => {
    const t = toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION));
    const steps = t.steps as { observation?: { results: { extra?: Record<string, unknown> }[] } }[];
    const edits = steps
      .flatMap((s) => s.observation?.results ?? [])
      .flatMap((r) => (r.extra?.agitFileEdits as { path: string; afterHash: string }[] | undefined) ?? []);
    expect(edits.length).toBeGreaterThan(0);
    // Provenance an ordinary trajectory cannot carry: keep it rather than drop it.
    expect(edits[0]!.afterHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("totals usage, and says the file list is a floor", () => {
    const t = toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION));
    const m = t.final_metrics as Record<string, number>;
    expect(m.total_steps).toBe((t.steps as unknown[]).length);
    expect(m.prompt_tokens).toBe(142);
    expect(m.completion_tokens).toBe(1055);
    const extra = t.extra as Record<string, unknown>;
    expect(extra.agitHeadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(extra.agitFilesAreLowerBound).toContain("SPEC 5.7");
    expect(extra.agitVerifyWith).toContain("agit verify");
  });

  it("is deterministic", () => {
    const a = JSON.stringify(toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    const b = JSON.stringify(toAtif(readSessionEvents(store, SESSION), readSessionMeta(store, SESSION)));
    expect(a).toBe(b);
  });

  it("gives a tool call with no preceding assistant message a step, and says it did", () => {
    // Codex records edits without an assistant message before every call.
    const t = toAtif(readSessionEvents(store, "0199edit-0000-7aaa-8bbb-ccccdddd0001"), null);
    const steps = t.steps as { extra?: Record<string, unknown>; tool_calls?: unknown[] }[];
    const synthesized = steps.filter((s) => s.extra?.agitSynthesized === true);
    for (const s of synthesized) {
      expect(s.extra!.agitNote).toBeTruthy();
      expect((s.tool_calls ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe("agit export --otel / --atif", () => {
  it("writes valid JSON on stdout for both", () => {
    for (const flag of ["--otel", "--atif"]) {
      const r = agit(["export", "demo", flag, "--dir", store]);
      expect(r.code, flag).toBe(0);
      expect(() => JSON.parse(r.out)).not.toThrow();
    }
  });

  it("refuses both at once rather than silently picking one", () => {
    const r = agit(["export", "demo", "--otel", "--atif", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("pick one");
  });

  it("refuses a session whose chain does not verify", () => {
    // Feeding an eval or a dashboard from a log agit cannot vouch for is how
    // a verified pipeline quietly stops being one.
    const dir = mkdtempSync(join(tmpdir(), "agit-interop-bad-"));
    expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
    const p = join(dir, ".agit", "sessions", SESSION, "events.jsonl");
    const lines = execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(p)},"utf8"))`],
      { encoding: "utf8" },
    );
    writeFileSync(p, lines.replace("rate limiting", "RATE LIMITING"), "utf8");

    for (const flag of ["--otel", "--atif"]) {
      const r = agit(["export", "demo", flag, "--dir", dir]);
      expect(r.code, flag).toBe(1);
    }
  });

  it("leaves plain export untouched", () => {
    const r = agit(["export", "demo", "--dir", store]);
    expect(r.code).toBe(0);
    // Still the stored JSONL, chain intact — the interop flags are additions,
    // not a change to what export already did.
    expect(r.out.split("\n").filter((l) => l.trim() !== "").length).toBe(31);
    expect(JSON.parse(r.out.split("\n")[0]!)).toHaveProperty("hash");
  });
});
