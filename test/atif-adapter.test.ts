import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atifAdapter, isNewerThanKnown } from "../src/adapters/atif.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import type { AgitEvent, SessionMeta } from "../src/format/events.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const ATIF = join(ROOT, "fixtures", "atif", "simple.json");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");

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

function linesOf(path: string): string[] {
  return readFileSync(path, "utf8").split("\n");
}

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agit-atif-"));
}

function eventsIn(dir: string, id: string): AgitEvent[] {
  return readFileSync(join(dir, ".agit", "sessions", id, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AgitEvent);
}

function counts(events: AgitEvent[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const e of events) c[e.type] = (c[e.type] ?? 0) + 1;
  return c;
}

describe("detection (#64)", () => {
  it("recognizes an ATIF trajectory", () => {
    expect(atifAdapter.detect(linesOf(ATIF))).toBe(true);
  });

  it("does not claim the other runtimes' logs, and they do not claim ATIF", () => {
    // Adapters are tried in order, so an over-eager detect steals another
    // runtime's file rather than merely being wrong about its own.
    for (const other of [DEMO, CODEX]) {
      expect(atifAdapter.detect(linesOf(other)), other).toBe(false);
    }
    for (const a of [claudeCodeAdapter, codexAdapter, openclawAdapter]) {
      expect(a.detect(linesOf(ATIF)), a.name).toBe(false);
    }
  });

  it("declines JSON that is not ATIF", () => {
    expect(atifAdapter.detect(['{"steps": []}'])).toBe(false);
    expect(atifAdapter.detect(['{"schema_version": "ATIF-v1.8"}'])).toBe(false);
    expect(atifAdapter.detect(["not json at all"])).toBe(false);
  });
});

describe("the mapping", () => {
  const r = atifAdapter.convert(linesOf(ATIF));

  it("takes its session id from the trajectory", () => {
    expect(r.sessionId).toBe("atif-fixture-0001");
  });

  it("opens with the agent as the runtime", () => {
    const start = r.drafts[0]!;
    expect(start.type).toBe("session.start");
    const p = start.payload as Record<string, unknown>;
    expect(p.runtime).toBe("harbor-terminus");
    expect(p.runtimeVersion).toBe("2.0.0");
    // ATIF records no working directory, so agit records none rather than
    // inventing one.
    expect(p.cwd).toBeNull();
  });

  it("maps user and agent steps, keeping reasoning as a thinking block", () => {
    const assistant = r.drafts.find((d) => d.type === "message.assistant")!;
    const blocks = (assistant.payload as { blocks: { type: string; text: string }[] }).blocks;
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(blocks[0]!.text).toContain("Write the helper first");
    expect(r.drafts.filter((d) => d.type === "message.user")).toHaveLength(2);
  });

  it("pairs each tool call with the result carrying its id", () => {
    const calls = r.drafts.filter((d) => d.type === "tool.call");
    const results = r.drafts.filter((d) => d.type === "tool.result");
    expect(calls.map((c) => (c.payload as { name: string }).name)).toEqual(["file_write", "run_tests"]);
    for (const c of calls) {
      const id = (c.payload as { toolUseId: string }).toolUseId;
      expect(results.some((x) => (x.payload as { toolUseId: string }).toolUseId === id)).toBe(true);
    }
    const failed = results.find((x) => (x.payload as { isError: boolean }).isError);
    expect((failed!.payload as { output: string }).output).toContain("1 failing");
  });

  it("maps metrics onto a cost event, cached tokens to the read side", () => {
    const cost = r.drafts.find((d) => d.type === "cost")!;
    const u = (cost.payload as { usage: Record<string, number> }).usage;
    expect(u.inputTokens).toBe(1200);
    expect(u.outputTokens).toBe(340);
    expect(u.cacheReadInputTokens).toBe(900);
    // Nothing in ATIF records a cache write, so it is zero rather than guessed.
    expect(u.cacheCreationInputTokens).toBe(0);
  });

  it("flattens a non-text content part to a named marker", () => {
    const withImage = r.drafts.filter((d) => d.type === "message.assistant")[1]!;
    const blocks = (withImage.payload as { blocks: { text: string }[] }).blocks;
    expect(blocks[0]!.text).toContain("[image/png]");
  });
});

describe("what it declines, and says it declined", () => {
  const r = atifAdapter.convert(linesOf(ATIF));

  it("counts a system step rather than bending it into a user message", () => {
    // SPEC 5 has no system-message event. Inventing one, or filing it as a
    // user message, would put words in the user's mouth.
    expect(r.skipped["system-step"]).toBe(1);
    for (const d of r.drafts) {
      expect((d.payload as { text?: string }).text ?? "").not.toContain("You are a helpful coding agent");
    }
  });

  it("counts a subagent trajectory rather than linearizing it", () => {
    // Flattening a subagent's work into its parent would attribute it to the
    // wrong agent.
    expect(r.skipped["subagent-trajectory"]).toBe(1);
    expect(r.drafts.some((d) => JSON.stringify(d.payload).includes("lint rules"))).toBe(false);
  });

  it("says when a step inherited its timestamp", () => {
    expect(r.skipped["step-timestamp-inherited"]).toBe(1);
    for (const d of r.drafts) expect(Number.isFinite(Date.parse(d.ts))).toBe(true);
  });

  it("says how many model calls one metrics object covered", () => {
    // llm_call_count is 2 on that step, so one cost event stands for two
    // calls. The tokens are right; the call count is a floor.
    expect(r.skipped["cost-events-folded-into-one"]).toBe(1);
  });

  it("emits no file.diff, because a trajectory holds no file content", () => {
    // The whole reason this adapter cannot do what the others do: agit's file
    // hashes are over bytes it holds, and ATIF records a write as prose.
    expect(r.drafts.some((d) => d.type === "file.diff" || d.type === "file.delete")).toBe(false);
  });

  it("will not date a trajectory that carries no timestamps at all", () => {
    // Reading the clock here would make two imports of the same bytes differ.
    const doc = JSON.parse(readFileSync(ATIF, "utf8")) as { steps: Record<string, unknown>[] };
    for (const s of doc.steps) delete s.timestamp;
    expect(() => atifAdapter.convert([JSON.stringify(doc)])).toThrow(/no timestamps/);
  });
});

describe("trajectories that name themselves badly, or not at all", () => {
  const doc = (extra: Record<string, unknown>, message = "hello"): string[] => [
    JSON.stringify({
      schema_version: "ATIF-v1.8",
      agent: { name: "anon", version: "1" },
      steps: [{ step_id: 1, timestamp: "2026-01-01T00:00:00.000Z", source: "user", message }],
      ...extra,
    }),
  ];

  it("keeps a trajectory's own id when it has one", () => {
    expect(atifAdapter.convert(doc({ trajectory_id: "mine" })).sessionId).toBe("mine");
    expect(atifAdapter.convert(doc({ session_id: "also-mine" })).sessionId).toBe("also-mine");
  });

  it("gives two anonymous trajectories from one agent different ids", () => {
    // Deriving the id from the agent's name alone would collide, and the
    // second import would be refused as "already exists with different
    // content" — the wrong error for two genuinely different sessions.
    const a = atifAdapter.convert(doc({}, "first")).sessionId;
    const b = atifAdapter.convert(doc({}, "second")).sessionId;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^atif-anon-[0-9a-f]{12}$/);
    // Still deterministic: the same bytes give the same id.
    expect(atifAdapter.convert(doc({}, "first")).sessionId).toBe(a);
  });

  it("reads a newer schema version, and says that it did", () => {
    // ATIF has been additive, so refusing would be unhelpful. Staying quiet
    // would hide that fields this adapter cannot see were dropped.
    const r = atifAdapter.convert(doc({ schema_version: "ATIF-v2.0" }));
    expect(r.skipped["schema-newer-than-ATIF-v1.8:ATIF-v2.0"]).toBe(1);
    expect(atifAdapter.convert(doc({})).skipped["schema-newer-than-ATIF-v1.8:ATIF-v1.8"]).toBeUndefined();
  });

  it("compares versions numerically, not as strings", () => {
    // "ATIF-v1.10" sorts below "ATIF-v1.8" lexically, so a string comparison
    // goes quiet exactly when the format outgrows one digit.
    expect(isNewerThanKnown("ATIF-v1.10")).toBe(true);
    expect(isNewerThanKnown("ATIF-v1.9")).toBe(true);
    expect(isNewerThanKnown("ATIF-v2.0")).toBe(true);
    expect(isNewerThanKnown("ATIF-v1.8")).toBe(false);
    expect(isNewerThanKnown("ATIF-v1.0")).toBe(false);
    expect(isNewerThanKnown("ATIF-vNonsense")).toBe(false);
  });

  it("refuses a trajectory with no steps rather than importing an empty session", () => {
    expect(() => atifAdapter.convert([JSON.stringify({ schema_version: "ATIF-v1.8", steps: [] })])).toThrow(
      /no steps/,
    );
  });

  it("survives fields that are the wrong type instead of the right one, and names each loss", () => {
    // A foreign producer will get something wrong eventually; one bad field
    // should cost that field, not the import. But a `tool_calls` that is one
    // object where the list should be loses every call on the step, and the
    // report has to say so rather than read the field as absent.
    const rough = JSON.stringify({
      schema_version: "ATIF-v1.8",
      agent: {},
      steps: [
        {
          step_id: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          source: "agent",
          message: null,
          tool_calls: { tool_call_id: "c1", function_name: "bash", arguments: {} },
          observation: { results: "not-an-array" },
          metrics: "12 tokens",
        },
        {
          step_id: 2,
          timestamp: "2026-01-01T00:00:01.000Z",
          source: "agent",
          message: "x",
          observation: "prose",
        },
      ],
    });
    const r = atifAdapter.convert([rough]);
    expect(r.drafts[0]!.type).toBe("session.start");
    expect(r.drafts.some((d) => d.type === "tool.call")).toBe(false);
    expect(r.skipped["tool-calls-not-a-list"]).toBe(1);
    expect(r.skipped["observation-results-not-a-list"]).toBe(1);
    expect(r.skipped["metrics-not-an-object"]).toBe(1);
    expect(r.skipped["observation-not-an-object"]).toBe(1);
  });

  it("reads a null field as absent, not as the wrong type", () => {
    // Pydantic writes an unset Optional as null unless the producer opts
    // out, so `tool_calls: null` is an ordinary step and must not be counted
    // as a producer bug.
    const r = atifAdapter.convert(
      doc({
        steps: [
          {
            step_id: 1,
            timestamp: "2026-01-01T00:00:00.000Z",
            source: "agent",
            message: "x",
            tool_calls: null,
            observation: null,
            metrics: null,
          },
        ],
      }),
    );
    expect(r.skipped).toEqual({});
  });

  it("counts a step that is not an object, and still counts it as a record", () => {
    // Filtering them out used to make meta.json say fewer records than the
    // file holds, with nothing in skipped to account for the difference.
    const r = atifAdapter.convert(
      doc({
        steps: [
          { step_id: 1, timestamp: "2026-01-01T00:00:00.000Z", source: "user", message: "hi" },
          null,
          "junk",
          42,
        ],
      }),
    );
    expect(r.records).toBe(4);
    expect(r.skipped["unparseable-step"]).toBe(3);
  });

  it("makes the derived id safe when the agent's name is not", () => {
    // The agent's name is free text. "Terminus 2" used to produce an id with
    // a space in it, and writeSession refused the whole import over an id
    // the document never declared.
    for (const name of ["Terminus 2", "openhands/CodeActAgent", "a:b"]) {
      const id = atifAdapter.convert(doc({ agent: { name, version: "1" } })).sessionId;
      expect(id, name).toMatch(/^atif-[A-Za-z0-9._-]+-[0-9a-f]{12}$/);
    }
    expect(atifAdapter.convert(doc({ agent: { name: "Terminus 2", version: "1" } })).sessionId).toMatch(
      /^atif-Terminus-2-/,
    );
  });

  it("treats an empty declared id as no id", () => {
    // A producer that initialises string fields to "" rather than omitting
    // them used to name the session "" and shadow a perfectly good
    // session_id underneath.
    expect(atifAdapter.convert(doc({ trajectory_id: "", session_id: "good-id" })).sessionId).toBe("good-id");
    expect(atifAdapter.convert(doc({ trajectory_id: "", session_id: "" })).sessionId).toMatch(
      /^atif-anon-[0-9a-f]{12}$/,
    );
  });
});

describe("observation results the adapter cannot pair, and ones it must not pair twice", () => {
  const T = "2026-01-01T00:00:00.000Z";
  const one = (step: Record<string, unknown>): string[] => [
    JSON.stringify({ schema_version: "ATIF-v1.8", agent: { name: "anon", version: "1" }, steps: [step] }),
  ];
  const call = (id?: string, name = "bash"): Record<string, unknown> => ({
    ...(id !== undefined ? { tool_call_id: id } : {}),
    function_name: name,
    arguments: {},
  });
  const results = (r: ReturnType<typeof atifAdapter.convert>): { toolUseId: string; output: string }[] =>
    r.drafts
      .filter((d) => d.type === "tool.result")
      .map((d) => d.payload as { toolUseId: string; output: string });

  it("counts a result that names no call rather than dropping it", () => {
    // ATIF says a null source_call_id is the output of something outside the
    // tool-calling format; v1.2 added observations on system steps for
    // exactly that. agit has no event for a result with no call, so it is
    // counted, not paired with a call it does not claim and not lost.
    const r = atifAdapter.convert([
      JSON.stringify({
        schema_version: "ATIF-v1.8",
        agent: { name: "anon", version: "1" },
        steps: [
          {
            step_id: 1,
            timestamp: T,
            source: "agent",
            message: "",
            tool_calls: [call("c1")],
            observation: { results: [{ content: "file1\nfile2" }] },
          },
          {
            step_id: 2,
            timestamp: T,
            source: "system",
            message: "container restarted",
            observation: { results: [{ content: "restart log here" }] },
          },
        ],
      }),
    ]);
    expect(results(r)).toEqual([]);
    expect(r.skipped["observation-result-without-call-id"]).toBe(2);
  });

  it("counts a result naming a call that is not on the step", () => {
    const r = atifAdapter.convert(
      one({
        step_id: 1,
        timestamp: T,
        source: "agent",
        message: "",
        tool_calls: [call("c1")],
        observation: { results: [{ source_call_id: "nope", content: "orphan" }] },
      }),
    );
    expect(results(r)).toEqual([]);
    expect(r.skipped["observation-result-without-call"]).toBe(1);
  });

  it("keeps every result the document files under one call, in order", () => {
    // Two results under one id is the document's own claim about that call.
    // Keeping only the last, as this used to, threw the first away without
    // a word.
    const r = atifAdapter.convert(
      one({
        step_id: 1,
        timestamp: T,
        source: "agent",
        message: "",
        tool_calls: [call("c1")],
        observation: {
          results: [
            { source_call_id: "c1", content: "FIRST" },
            { source_call_id: "c1", content: "SECOND" },
          ],
        },
      }),
    );
    expect(results(r).map((x) => x.output)).toEqual(["FIRST", "SECOND"]);
    expect(r.skipped).toEqual({});
  });

  it("counts a result that is not an object", () => {
    const r = atifAdapter.convert(
      one({ step_id: 1, timestamp: T, source: "agent", message: "", observation: { results: ["prose", 7] } }),
    );
    expect(r.skipped["unparseable-observation-result"]).toBe(2);
  });

  it("gives id-less calls on one step different ids, so one result cannot attach to all of them", () => {
    // ATIF requires tool_call_id, so only a broken producer gets here. The
    // old fallback was one id per step, and a result naming it was emitted
    // after every id-less call on the step: the same output attributed to
    // calls it may not belong to.
    const r = atifAdapter.convert(
      one({
        step_id: 3,
        timestamp: T,
        source: "agent",
        message: "x",
        tool_calls: [call(undefined, "a"), call(undefined, "b")],
        observation: { results: [{ source_call_id: "atif-step3", content: "whose?" }] },
      }),
    );
    const ids = r.drafts
      .filter((d) => d.type === "tool.call")
      .map((d) => (d.payload as { toolUseId: string }).toolUseId);
    expect(new Set(ids).size).toBe(2);
    expect(results(r)).toEqual([]);
    expect(r.skipped["observation-result-without-call"]).toBe(1);
  });

  it("counts a subagent reference on a result and keeps the pointer", () => {
    // ATIF's primary subagent linkage is a reference to another file, not
    // the embedded list; Terminus 2's summarization path writes refs. The
    // delegation used to become a tool.result with an empty output and no
    // trace of where the work went.
    const refs = [{ session_id: "sub-1", trajectory_path: "sub/trajectory.json" }];
    const r = atifAdapter.convert(
      one({
        step_id: 1,
        timestamp: T,
        source: "agent",
        message: "delegate",
        tool_calls: [call("c1", "spawn_subagent")],
        observation: { results: [{ source_call_id: "c1", subagent_trajectory_ref: refs }] },
      }),
    );
    expect(r.skipped["subagent-trajectory-ref"]).toBe(1);
    const native = (
      r.drafts.find((d) => d.type === "tool.result")!.payload as { native: Record<string, unknown> }
    ).native;
    expect(native.subagentTrajectoryRef).toEqual(refs);
  });
});

describe("a trajectory continued from another file", () => {
  const T = "2026-01-01T00:00:00.000Z";
  const continuation = (steps: Record<string, unknown>[]): string[] => [
    JSON.stringify({
      schema_version: "ATIF-v1.8",
      session_id: "s-cont-1",
      continued_trajectory_ref: "trajectory.cont-2.json",
      agent: { name: "terminus-2", version: "1" },
      steps,
    }),
  ];
  const copiedSteps = [
    { step_id: 1, timestamp: T, source: "user", message: "original task", is_copied_context: true },
    {
      step_id: 2,
      timestamp: T,
      source: "agent",
      message: "did it",
      is_copied_context: true,
      tool_calls: [{ tool_call_id: "c1", function_name: "bash", arguments: { cmd: "make" } }],
      observation: { results: [{ source_call_id: "c1", content: "ok" }] },
    },
  ];

  it("leaves copied context out, counts it, and keeps the link to the other file", () => {
    // Copied steps are the earlier trajectory's work. Importing both files
    // used to record the same messages and tool calls under two sessions,
    // with nothing to tell them apart.
    const r = atifAdapter.convert(
      continuation([
        ...copiedSteps,
        { step_id: 3, timestamp: "2026-01-01T00:00:09.000Z", source: "agent", message: "continuing" },
      ]),
    );
    expect(r.skipped["copied-context-step"]).toBe(2);
    expect(r.records).toBe(3);
    expect(r.drafts.map((d) => d.type)).toEqual(["session.start", "message.assistant", "session.end"]);
    expect(JSON.stringify(r.drafts)).not.toContain("original task");
    const native = (r.drafts[0]!.payload as { native: Record<string, unknown> }).native;
    expect(native.continuedTrajectoryRef).toBe("trajectory.cont-2.json");
  });

  it("refuses a file that is nothing but copied context, and says why", () => {
    expect(() => atifAdapter.convert(continuation(copiedSteps))).toThrow(/copied context/);
  });
});

describe("what goes into the hashed cost event", () => {
  const metrics = (m: Record<string, unknown>): string[] => [
    JSON.stringify({
      schema_version: "ATIF-v1.8",
      agent: { name: "anon", version: "1" },
      steps: [
        { step_id: 1, timestamp: "2026-01-01T00:00:00.000Z", source: "agent", message: "x", metrics: m },
      ],
    }),
  ];
  const native = (lines: string[]): Record<string, unknown> =>
    (
      atifAdapter.convert(lines).drafts.find((d) => d.type === "cost")!.payload as {
        native: Record<string, unknown>;
      }
    ).native;

  it("never stores cost_usd, and counts the ones the document holds (SPEC §5.9)", () => {
    // A dollar figure is a display-time computation from a pricing table;
    // hashed into an event it is a stale snapshot nobody can verify, so the
    // SPEC keeps it out of the log. Every shape leaves native without it;
    // a figure the document did hold is counted so the import report names
    // the drop, and a null (pydantic's None) is nothing to count.
    const skipped = (lines: string[]): Record<string, number> => atifAdapter.convert(lines).skipped;
    for (const m of [
      metrics({ prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.021 }),
      metrics({ prompt_tokens: 10, completion_tokens: 5, cost_usd: null }),
      metrics({ prompt_tokens: 10, completion_tokens: 5, cost_usd: "0.02" }),
      metrics({ prompt_tokens: 10, completion_tokens: 5 }),
    ]) {
      expect(native(m)).not.toHaveProperty("costUsd");
    }
    expect(skipped(metrics({ prompt_tokens: 10, cost_usd: 0.021 }))["cost-usd-not-stored (SPEC §5.9)"]).toBe(
      1,
    );
    expect(skipped(metrics({ prompt_tokens: 10, cost_usd: "0.02" }))["cost-usd-not-stored (SPEC §5.9)"]).toBe(
      1,
    );
    expect(skipped(metrics({ prompt_tokens: 10, cost_usd: null }))).not.toHaveProperty(
      "cost-usd-not-stored (SPEC §5.9)",
    );
    expect(skipped(metrics({ prompt_tokens: 10 }))).not.toHaveProperty("cost-usd-not-stored (SPEC §5.9)");
  });
});

describe("agit import on an ATIF trajectory", () => {
  it("imports, verifies, and names what it skipped", () => {
    const dir = mktemp();
    const r = agit(["import", ATIF, "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("atif@");
    expect(r.out).toContain("system-step");
    expect(r.out).toContain("subagent-trajectory");
    expect(agit(["verify", "atif", "--dir", dir]).code).toBe(0);
  });

  it("is deterministic", () => {
    const a = mktemp();
    const b = mktemp();
    expect(agit(["import", ATIF, "--dir", a]).code).toBe(0);
    expect(agit(["import", ATIF, "--dir", b]).code).toBe(0);
    expect(readFileSync(join(a, ".agit", "sessions", "atif-fixture-0001", "events.jsonl"), "utf8")).toBe(
      readFileSync(join(b, ".agit", "sessions", "atif-fixture-0001", "events.jsonl"), "utf8"),
    );
  });

  it("imports an anonymous trajectory whatever the agent is called", () => {
    // session_id became optional in ATIF v1.7. An agent called "Terminus 2"
    // used to make writeSession refuse the import over the derived id.
    const dir = mktemp();
    const traj = join(dir, "t.json");
    writeFileSync(
      traj,
      JSON.stringify({
        schema_version: "ATIF-v1.8",
        agent: { name: "Terminus 2", version: "1" },
        steps: [{ step_id: 1, timestamp: "2026-01-01T00:00:00.000Z", source: "user", message: "hello" }],
      }),
      "utf8",
    );
    const r = agit(["import", traj, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("imported atif-Terminus-2-");
  });

  it("leaves the read verbs working, and blame with nothing to say", () => {
    const dir = mktemp();
    expect(agit(["import", ATIF, "--dir", dir]).code).toBe(0);
    expect(agit(["show", "atif", "--dir", dir]).code).toBe(0);
    expect(agit(["grep", "retry", "--dir", dir]).code).toBe(0);
    expect(agit(["stats", "--by", "runtime", "--dir", dir]).out).toContain("harbor-terminus");
    // No file events means no attribution, and blame says so rather than
    // producing an empty answer that looks like "nothing was written".
    const blamed = agit(["blame", "src/retry.ts", "--dir", dir]);
    expect(blamed.code).not.toBe(0);
  });
});

describe("export --atif then import: what survives the round trip", () => {
  it("keeps the conversation, the tool calls and the token totals", () => {
    const a = mktemp();
    const b = mktemp();
    expect(agit(["import", DEMO, "--dir", a]).code).toBe(0);
    const traj = join(a, "traj.json");
    const exported = agit(["export", "demo", "--atif", "--dir", a]);
    expect(exported.code).toBe(0);
    writeFileSync(traj, exported.out, "utf8");

    expect(agit(["import", traj, "--dir", b]).code).toBe(0);
    const before = counts(eventsIn(a, "demo-ratelimit-0001"));
    const after = counts(eventsIn(b, "demo-ratelimit-0001"));

    for (const type of ["message.user", "message.assistant", "tool.call", "tool.result"]) {
      expect(after[type], type).toBe(before[type]);
    }
    // Tokens are exact across the trip even though the events carrying them
    // were folded.
    const sum = (dir: string, id: string): number =>
      eventsIn(dir, id)
        .filter((e) => e.type === "cost")
        .reduce((n, e) => n + ((e.payload as { usage: { inputTokens: number } }).usage.inputTokens ?? 0), 0);
    expect(sum(b, "demo-ratelimit-0001")).toBe(sum(a, "demo-ratelimit-0001"));
  });

  it("accounts for every difference in the import report", () => {
    // The property worth having: nothing is lost quietly. Each event the
    // round trip drops is named and counted.
    const a = mktemp();
    const b = mktemp();
    expect(agit(["import", DEMO, "--dir", a]).code).toBe(0);
    const traj = join(a, "traj.json");
    writeFileSync(traj, agit(["export", "demo", "--atif", "--dir", a]).out, "utf8");
    const report = agit(["import", traj, "--dir", b]);

    const before = counts(eventsIn(a, "demo-ratelimit-0001"));
    const after = counts(eventsIn(b, "demo-ratelimit-0001"));
    const meta = JSON.parse(
      readFileSync(join(b, ".agit", "sessions", "demo-ratelimit-0001", "meta.json"), "utf8"),
    ) as SessionMeta;

    const lostFiles = (before["file.diff"] ?? 0) - (after["file.diff"] ?? 0);
    const lostCost = (before.cost ?? 0) - (after.cost ?? 0);
    expect(lostFiles).toBeGreaterThan(0);
    expect(meta.skipped["file-edit-without-content"]).toBe(lostFiles);
    expect(meta.skipped["cost-events-folded-into-one"] ?? 0).toBe(lostCost);
    expect(report.out).toContain("file-edit-without-content");
  });

  it("still verifies after the trip", () => {
    const a = mktemp();
    const b = mktemp();
    expect(agit(["import", DEMO, "--dir", a]).code).toBe(0);
    const traj = join(a, "traj.json");
    writeFileSync(traj, agit(["export", "demo", "--atif", "--dir", a]).out, "utf8");
    expect(agit(["import", traj, "--dir", b]).code).toBe(0);
    expect(agit(["verify", "demo", "--dir", b]).code).toBe(0);
  });
});
