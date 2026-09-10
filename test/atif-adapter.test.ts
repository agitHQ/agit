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

  it("survives fields that are the wrong type instead of the right one", () => {
    // A foreign producer will get something wrong eventually; one bad field
    // should cost that field, not the import.
    const rough = JSON.stringify({
      schema_version: "ATIF-v1.8",
      agent: {},
      steps: [
        {
          step_id: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          source: "agent",
          message: null,
          tool_calls: "not-an-array",
          observation: { results: "not-an-array" },
          metrics: "not-an-object",
        },
      ],
    });
    const r = atifAdapter.convert([rough]);
    expect(r.drafts[0]!.type).toBe("session.start");
    expect(r.drafts.some((d) => d.type === "tool.call")).toBe(false);
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
