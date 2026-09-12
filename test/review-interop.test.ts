import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgitEvent, DraftEvent, SessionMeta } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { toAtif, toOtlpJson } from "../src/interop.js";
import { loadPrivateKey, signHead, SIGNATURE_PAYLOAD_VERSION } from "../src/sign.js";
import { readSessionEvents, readSessionMeta, writeSession } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");
const CODEX_ID = "0199edit-0000-7aaa-8bbb-ccccdddd0001";
const T = "2026-09-06T09:00:00.000Z";

function agit(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

interface OtlpSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number };
}

function spansOf(doc: Record<string, unknown>): OtlpSpan[] {
  return (doc.resourceSpans as { scopeSpans: { spans: OtlpSpan[] }[] }[])[0]!.scopeSpans[0]!.spans;
}

function attrsOf(s: OtlpSpan): Record<string, unknown> {
  return Object.fromEntries(s.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
}

interface AtifStep {
  step_id: number;
  source: string;
  tool_calls?: { tool_call_id: string }[];
  observation?: { results: { source_call_id?: string; content?: string; extra?: Record<string, unknown> }[] };
  extra?: Record<string, unknown>;
}

function stepsOf(doc: Record<string, unknown>): AtifStep[] {
  return doc.steps as AtifStep[];
}

function chain(id: string, drafts: DraftEvent[]): AgitEvent[] {
  return buildChain(id, drafts);
}

/** Two id-less tool calls, the first of which failed: what the Cline SDK adapter produces. */
const CLINE_NOID = {
  version: 1,
  updated_at: "2026-05-02T09:14:22.000Z",
  agent: "lead",
  sessionId: "cline-noid-0001",
  taskType: "act",
  messages: [
    { id: "m1", role: "user", content: [{ type: "text", text: "run two commands" }] },
    {
      id: "m2",
      role: "assistant",
      ts: 1777713262000,
      modelInfo: { id: "some-model-v1" },
      content: [
        { type: "text", text: "Running." },
        { type: "tool_use", name: "bash", input: { cmd: "false" } },
      ],
    },
    { id: "m3", role: "user", content: [{ type: "tool_result", content: "command failed", is_error: true }] },
    {
      id: "m4",
      role: "assistant",
      ts: 1777713271000,
      modelInfo: { id: "some-model-v1" },
      content: [
        { type: "text", text: "Retrying." },
        { type: "tool_use", name: "bash", input: { cmd: "true" } },
      ],
    },
    { id: "m5", role: "user", content: [{ type: "tool_result", content: "ok", is_error: false }] },
  ],
};

let store: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-review-interop-"));
  const cline = join(store, "cline-noid.messages.json");
  writeFileSync(cline, JSON.stringify(CLINE_NOID), "utf8");
  expect(agit(["import", cline, "--dir", store]).code).toBe(0);
  expect(agit(["import", CODEX, "--dir", store]).code).toBe(0);
});

describe("tool results are matched by position, not by id alone", () => {
  it("gives a failed call its own result even when a later call shares the id", () => {
    // The Cline SDK adapter used to write "(missing)" for every block without
    // an id, so a map keyed by id handed both calls the last result and
    // exported the failure as the success that came after it. The adapter no
    // longer invents that id, but nothing stops another log from carrying
    // duplicates, so the chain is built by hand in the shape it produced.
    const t = (s: number): string => new Date(Date.parse(T) + s * 1000).toISOString();
    const events = chain("dupid-0001", [
      { ts: t(0), type: "session.start", payload: { runtime: "x", runtimeVersion: null, cwd: null } },
      {
        ts: t(1),
        type: "message.assistant",
        payload: { model: "m", blocks: [{ type: "text", text: "Running." }] },
      },
      {
        ts: t(2),
        type: "tool.call",
        payload: { toolUseId: "(missing)", name: "bash", input: { cmd: "false" } },
      },
      {
        ts: t(3),
        type: "tool.result",
        payload: { toolUseId: "(missing)", isError: true, output: "command failed" },
      },
      {
        ts: t(4),
        type: "message.assistant",
        payload: { model: "m", blocks: [{ type: "text", text: "Retrying." }] },
      },
      {
        ts: t(5),
        type: "tool.call",
        payload: { toolUseId: "(missing)", name: "bash", input: { cmd: "true" } },
      },
      { ts: t(6), type: "tool.result", payload: { toolUseId: "(missing)", isError: false, output: "ok" } },
    ]);
    const spans = spansOf(toOtlpJson(events, null));
    const tools = spans.filter((s) => s.name.startsWith("execute_tool"));
    expect(tools.length).toBe(2);
    const [first, second] = tools as [OtlpSpan, OtlpSpan];
    expect(first.status.code).toBe(2);
    expect(second.status.code).toBe(0);
    // The first call ends when its own result arrived, not the second one's.
    expect(first.endTimeUnixNano).toBe(String(BigInt(Date.parse(t(3))) * 1_000_000n));

    const steps = stepsOf(toAtif(events, null));
    const observed = steps.filter((s) => s.observation !== undefined).map((s) => s.observation!.results[0]!);
    expect(observed.map((r) => [r.content, r.extra?.isError])).toEqual([
      ["command failed", true],
      ["ok", false],
    ]);
  });

  it("keeps a result that names no call in both exports, unpaired, rather than pairing it by position", () => {
    // What the Cline SDK adapter produces now for blocks without an id: a
    // null toolUseId on both sides and a count, no invented id. Pairing the
    // result with the nearest call would be the old guess with less
    // evidence, so neither exporter does; but the output is in the log, so
    // both keep it — ATIF as an observation result without a
    // `source_call_id` (its own shape for output from outside the tool
    // format), OTLP by naming the events on the root, since a trace has no
    // span to end for a result with no call.
    const events = readSessionEvents(store, "cline-noid-0001");
    const results = events.filter((e) => e.type === "tool.result");
    expect(results.map((e) => (e.payload as { toolUseId: unknown }).toolUseId)).toEqual([null, null]);

    const spans = spansOf(toOtlpJson(events, readSessionMeta(store, "cline-noid-0001")));
    const tools = spans.filter((s) => s.name.startsWith("execute_tool"));
    expect(tools.map((s) => s.status.code)).toEqual([0, 0]);
    expect(attrsOf(spans[0]!)["agit.tool_results.unpaired"]).toBe(results.map((e) => e.hash).join("\n"));

    const steps = stepsOf(toAtif(events, readSessionMeta(store, "cline-noid-0001")));
    const observed = steps.flatMap((s) => s.observation?.results ?? []);
    expect(observed.map((r) => [r.source_call_id, r.content, r.extra?.isError])).toEqual([
      [undefined, "command failed", true],
      [undefined, "ok", false],
    ]);
    // Each unpaired result sits on the step it followed.
    const hosts = steps.filter((s) => s.observation !== undefined);
    expect(hosts.map((s) => s.tool_calls?.length)).toEqual([1, 1]);
  });

  it("does not let a result whose id spells seq-N attach to a call that had no id", () => {
    const events = chain("seqn-0001", [
      { ts: T, type: "session.start", payload: { runtime: "x", runtimeVersion: null, cwd: null } },
      { ts: T, type: "tool.call", payload: { toolUseId: null, name: "Bash", input: {} } },
      { ts: T, type: "tool.result", payload: { toolUseId: "seq-1", isError: true, output: "not yours" } },
    ]);
    const steps = stepsOf(toAtif(events, null));
    const host = steps.find((s) => (s.tool_calls?.length ?? 0) > 0)!;
    expect(host.tool_calls![0]!.tool_call_id).toBe("seq-1");
    // The result is kept, but as one that names no call: nothing credits it
    // to the call whose fallback id it happened to spell.
    expect(host.observation!.results.map((r) => [r.source_call_id, r.content])).toEqual([
      [undefined, "not yours"],
    ]);
  });

  it("credits an edit to the latest call under its id, not to every call under it", () => {
    const events = chain("dupedit-0001", [
      { ts: T, type: "session.start", payload: { runtime: "x", runtimeVersion: null, cwd: null } },
      { ts: T, type: "tool.call", payload: { toolUseId: "(missing)", name: "Write", input: {} } },
      { ts: T, type: "tool.result", payload: { toolUseId: "(missing)", isError: false, output: "" } },
      { ts: T, type: "file.diff", payload: { toolUseId: "(missing)", path: "a.ts", kind: "create" } },
      { ts: T, type: "tool.call", payload: { toolUseId: "(missing)", name: "Write", input: {} } },
      { ts: T, type: "tool.result", payload: { toolUseId: "(missing)", isError: false, output: "" } },
      { ts: T, type: "file.diff", payload: { toolUseId: "(missing)", path: "b.ts", kind: "create" } },
    ]);
    const tools = spansOf(toOtlpJson(events, null)).filter((s) => s.name.startsWith("execute_tool"));
    expect(tools.map((s) => attrsOf(s)["agit.files.recorded"])).toEqual(["a.ts", "b.ts"]);
  });
});

describe("edits no tool call claims are kept, not dropped", () => {
  it("lists them on the OTLP root span, with the lower-bound marker", () => {
    // The Codex fixture records notes.md and the hello.py -> renamed.py move
    // from item_completed and patch_apply_end records that have no
    // function_call, so nothing in the log claims them.
    const events = readSessionEvents(store, CODEX_ID);
    const spans = spansOf(toOtlpJson(events, readSessionMeta(store, CODEX_ID)));
    const root = attrsOf(spans.find((s) => s.name.startsWith("invoke_agent"))!);
    const listed = (root["agit.files.recorded"] as string).split("\n");
    expect(listed.some((p) => p.endsWith("notes.md"))).toBe(true);
    expect(listed.some((p) => p.endsWith("renamed.py"))).toBe(true);
    expect(root["agit.files.lower_bound"]).toBe(true);
    // Every path the log recorded is in the trace somewhere.
    const paths = new Set(
      events
        .filter((e) => e.type === "file.diff" || e.type === "file.delete")
        .map((e) => (e.payload as { path: string }).path),
    );
    for (const p of paths) expect(listed).toContain(p);
  });

  it("puts them on the ATIF step they happened during, hashes and all", () => {
    const events = readSessionEvents(store, CODEX_ID);
    const steps = stepsOf(toAtif(events, readSessionMeta(store, CODEX_ID)));
    const orphaned = steps.flatMap(
      (s) =>
        (s.extra?.agitFileEditsWithoutCall as
          | {
              toolUseId: string;
              path: string;
              kind: string;
              afterHash: string | null;
              agitEventHash: string;
            }[]
          | undefined) ?? [],
    );
    expect(orphaned.map((e) => [e.toolUseId, e.kind])).toEqual([
      ["fc_item_1", "create"],
      ["call_move", "delete"],
      ["call_move", "create"],
    ]);
    for (const e of orphaned) {
      expect(e.agitEventHash).toMatch(/^[0-9a-f]{64}$/);
      expect(events.some((x) => x.hash === e.agitEventHash)).toBe(true);
    }
    // The provenance the header promises: every file event's hash is in the
    // document, whether or not a call claimed it.
    const text = JSON.stringify(steps);
    for (const e of events.filter((x) => x.type === "file.diff" || x.type === "file.delete")) {
      expect(text).toContain(e.hash);
    }
  });

  it("synthesizes a step for an edit with no agent step to sit on, and says so", () => {
    const events = chain("orphan-0001", [
      { ts: T, type: "session.start", payload: { runtime: "x", runtimeVersion: null, cwd: null } },
      { ts: T, type: "message.user", payload: { text: "go" } },
      { ts: T, type: "file.diff", payload: { toolUseId: "nobody", path: "a.ts", kind: "create" } },
    ]);
    const steps = stepsOf(toAtif(events, null));
    const host = steps.find((s) => s.extra?.agitFileEditsWithoutCall !== undefined)!;
    expect(host.source).toBe("agent");
    expect(host.extra!.agitSynthesized).toBe(true);
    expect(host.extra!.agitNote).toContain("file edit");
  });
});

describe("timestamps are read as UTC, whatever the exporting machine's zone", () => {
  it("gives the same nanos for a zone-less ts under two different TZ settings", () => {
    // The ATIF adapter stores Python's naive isoformat() as it came, and
    // ECMAScript reads a string with no zone designator as local time.
    const dir = mkdtempSync(join(tmpdir(), "agit-review-tz-"));
    const events = chain("zoneless-0001", [
      {
        ts: "2026-04-01T10:00:00.000000",
        type: "session.start",
        payload: { runtime: "x", runtimeVersion: null, cwd: null },
      },
      { ts: "2026-04-01T10:00:05.000000", type: "message.user", payload: { text: "hi" } },
    ]);
    writeSession(dir, "zoneless-0001", toJsonl(events));
    const starts = ["Asia/Tokyo", "America/New_York"].map((tz) => {
      const r = agit(["export", "zoneless-0001", "--otel", "--dir", dir], { TZ: tz });
      expect(r.code, tz).toBe(0);
      return spansOf(JSON.parse(r.out) as Record<string, unknown>)[0]!.startTimeUnixNano;
    });
    expect(starts[0]).toBe(starts[1]);
    expect(starts[0]).toBe(String(BigInt(Date.parse("2026-04-01T10:00:00.000Z")) * 1_000_000n));
  });
});

describe("token counts neither format can carry are refused", () => {
  const cost = (usage: Record<string, number>): AgitEvent[] =>
    chain("huge-0001", [
      { ts: T, type: "session.start", payload: { runtime: "claude-code", runtimeVersion: "1", cwd: null } },
      { ts: T, type: "message.assistant", payload: { model: "m", blocks: [{ type: "text", text: "hi" }] } },
      { ts: T, type: "cost", payload: { model: "m", usage } },
      { ts: T, type: "session.end", payload: { reason: "log-end" } },
    ]);

  it("names the event and field for a count beyond int64 or with a fraction", () => {
    // 1e21 stringifies as "1e+21", which is not an int64 for a collector,
    // and Harbor's Metrics rejects both that and 1.5 outright.
    expect(() => toOtlpJson(cost({ inputTokens: 1e21, outputTokens: 1 }), null)).toThrow(
      /event 2 usage\.inputTokens/,
    );
    expect(() => toAtif(cost({ inputTokens: 1e21, outputTokens: 1 }), null)).toThrow(
      /event 2 usage\.inputTokens/,
    );
    expect(() => toOtlpJson(cost({ inputTokens: 1, outputTokens: 1.5 }), null)).toThrow(
      /usage\.outputTokens is 1\.5/,
    );
    expect(() => toAtif(cost({ inputTokens: 1, outputTokens: 1.5 }), null)).toThrow(
      /usage\.outputTokens is 1\.5/,
    );
  });

  it("still exports a large count that fits", () => {
    const spans = spansOf(toOtlpJson(cost({ inputTokens: 2 ** 53, outputTokens: 0 }), null));
    const chat = attrsOf(spans.find((s) => s.name.startsWith("chat"))!);
    expect(chat["gen_ai.usage.input_tokens"]).toBe("9007199254740992");
  });

  it("exits 1 with nothing on stdout from the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-review-huge-"));
    writeSession(dir, "huge-0001", toJsonl(cost({ inputTokens: 1e21, outputTokens: 1.5 })));
    for (const flag of ["--otel", "--atif"]) {
      const r = agit(["export", "huge-0001", flag, "--dir", dir]);
      expect(r.code, flag).toBe(1);
      expect(r.out, flag).toBe("");
      expect(r.err, flag).toContain("refusing to export");
    }
  });
});

describe("agitSigned reports verification, not presence", () => {
  const events = chain("signed-0001", [
    { ts: T, type: "session.start", payload: { runtime: "x", runtimeVersion: null, cwd: null } },
    { ts: T, type: "message.user", payload: { text: "hi" } },
  ]);
  const head = {
    sessionId: "signed-0001",
    headHash: events[events.length - 1]!.hash,
    eventCount: events.length,
  };
  const key = loadPrivateKey(
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );
  const metaWith = (signatures: SessionMeta["signatures"]): SessionMeta => ({
    agitSchema: 1,
    sessionId: "signed-0001",
    adapter: { name: "x", version: "0" },
    importedAt: T,
    source: { path: "x", sha256: "0".repeat(64), bytes: 0, records: 0 },
    skipped: {},
    redactions: {},
    eventCount: head.eventCount,
    headHash: head.headHash,
    signatures,
  });
  const sign = (over: typeof head) =>
    signHead(key, { agitSignature: SIGNATURE_PAYLOAD_VERSION, ...over, at: "2026-09-10T00:00:00.000Z" });

  it("is true for a signature that verifies against the head", () => {
    const extra = toAtif(events, metaWith([sign(head)])).extra as Record<string, unknown>;
    expect(extra.agitSigned).toBe(true);
    expect(extra.agitSignatures).toEqual([
      { keyFingerprint: key.fingerprint, at: "2026-09-10T00:00:00.000Z", ok: true },
    ]);
  });

  it("is false for a signature over a different head, which is what a rechained log carries", () => {
    // The forgery `agit verify` exists to catch: edit, rechain, keep the
    // original signature. A presence check exported that as signed provenance.
    const stale = sign({ ...head, headHash: "b".repeat(64) });
    const extra = toAtif(events, metaWith([stale])).extra as Record<string, unknown>;
    expect(extra.agitSigned).toBe(false);
    expect((extra.agitSignatures as { ok: boolean }[]).map((s) => s.ok)).toEqual([false]);
  });

  it("is false, without throwing, for a junk record from someone else's meta.json", () => {
    const junk = [1, null, { alg: "rot13" }] as unknown as SessionMeta["signatures"];
    const extra = toAtif(events, metaWith(junk)).extra as Record<string, unknown>;
    expect(extra.agitSigned).toBe(false);
    expect((extra.agitSignatures as { ok: boolean }[]).every((s) => !s.ok)).toBe(true);
  });
});

describe("ATIF refuses a session it cannot make a step from", () => {
  it("throws rather than emitting steps: [], which Harbor rejects", () => {
    const events = chain("empty-0001", [
      { ts: T, type: "session.start", payload: { runtime: "claude-code", runtimeVersion: "1", cwd: null } },
      { ts: T, type: "session.end", payload: { reason: "log-end" } },
    ]);
    expect(() => toAtif(events, null)).toThrow(/at least one step/);
  });

  it("exits 1 from the CLI on a Claude Code record whose content array is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-review-empty-"));
    const native = join(dir, "empty.jsonl");
    writeFileSync(
      native,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: T,
        sessionId: "empty-0001",
        cwd: "C:/app",
        version: "2.1.260",
        message: { role: "user", content: [] },
      }) + "\n",
      "utf8",
    );
    expect(agit(["import", native, "--dir", dir]).code).toBe(0);
    const r = agit(["export", "empty-0001", "--atif", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("at least one step");
  });
});

describe("the root span has its own id", () => {
  it("does not collide with the first event's span when seq 0 is not session.start", () => {
    // verifyChain does not require seq 0 to be session.start, and a chain
    // that opens with a tool call verified and exported as two spans with
    // one id, the child listing itself as its parent.
    const events = chain("first-0001", [
      { ts: T, type: "tool.call", payload: { toolUseId: "t1", name: "Bash", input: {} } },
      { ts: T, type: "tool.result", payload: { toolUseId: "t1", isError: false, output: "ok" } },
      { ts: T, type: "cost", payload: { model: "m", usage: { inputTokens: 1, outputTokens: 2 } } },
    ]);
    const spans = spansOf(toOtlpJson(events, null));
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length);
    for (const s of spans) expect(s.parentSpanId).not.toBe(s.spanId);
    const root = spans.find((s) => s.name.startsWith("invoke_agent"))!;
    for (const s of spans.filter((x) => x !== root)) expect(s.parentSpanId).toBe(root.spanId);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("a meta.json without an adapter", () => {
  const events = chain("noadapter-0001", [
    { ts: T, type: "session.start", payload: { runtime: "x", runtimeVersion: null, cwd: null } },
    { ts: T, type: "message.user", payload: { text: "hi" } },
  ]);
  // adoptBundle keeps a sibling meta.json verbatim, and one from someone
  // else need not carry the adapter agit's own imports write.
  const meta = {
    agitSchema: 1,
    sessionId: "noadapter-0001",
    importedAt: T,
    source: { path: "x", sha256: "0".repeat(64), bytes: 0, records: 0 },
    skipped: {},
    redactions: {},
    eventCount: events.length,
    headHash: events[events.length - 1]!.hash,
  } as unknown as SessionMeta;

  it("exports OTLP the way it already exported ATIF", () => {
    const doc = toOtlpJson(events, meta);
    const root = attrsOf(spansOf(doc).find((s) => s.name.startsWith("invoke_agent"))!);
    expect(root["agit.adapter.name"]).toBeUndefined();
    expect(root["agit.head.hash"]).toBe(meta.headHash);
    expect(() => toAtif(events, meta)).not.toThrow();
  });

  it("exits 0 from the CLI for --otel as it does for --atif", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-review-noadapter-"));
    writeSession(dir, "noadapter-0001", toJsonl(events), meta);
    for (const flag of ["--otel", "--atif"]) {
      const r = agit(["export", "noadapter-0001", flag, "--dir", dir]);
      expect(r.code, flag + r.err).toBe(0);
      expect(() => JSON.parse(r.out)).not.toThrow();
    }
  });
});
