import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent, DraftEvent } from "../src/format/events.js";
import { computeStats, parsePriceTable, PriceTableError, type StatsRow } from "../src/stats.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

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

const cost = (ts: string, model: string, inTok: number, outTok: number): DraftEvent => ({
  ts,
  type: "cost",
  payload: {
    model,
    usage: {
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    native: { messageId: "m", requestId: null },
  },
});

function session(id: string, runtime: string, cwd: string, drafts: DraftEvent[]): AgitEvent[] {
  return buildChain(id, [
    { ts: drafts[0]?.ts ?? "2026-01-01T00:00:00.000Z", type: "session.start", payload: { runtime, cwd } },
    ...drafts,
  ]);
}

const A = session("a", "claude-code", "/work/alpha", [
  cost("2026-01-01T10:00:00.000Z", "opus", 100, 10),
  cost("2026-01-02T10:00:00.000Z", "opus", 200, 20),
]);
const B = session("b", "codex", "/work/beta", [cost("2026-01-02T11:00:00.000Z", "gpt", 50, 5)]);
/** A runtime that records no cost events at all — Codex's real situation today. */
const C = session("c", "codex", "/work/beta", [
  {
    ts: "2026-01-03T10:00:00.000Z",
    type: "file.diff",
    payload: {
      path: "/work/beta/x.ts",
      kind: "create",
      diff: "",
      beforeHash: null,
      afterHash: "h",
      toolUseId: "t",
      source: "apply_patch",
    },
  },
]);
const ALL = [
  { id: "a", events: A },
  { id: "b", events: B },
  { id: "c", events: C },
];

const row = (rows: StatsRow[], key: string): StatsRow => rows.find((r) => r.key === key)!;

describe("computeStats (#67)", () => {
  it("groups by day, oldest first", () => {
    const { rows } = computeStats(ALL, { by: "day" });
    expect(rows.map((r) => r.key)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(row(rows, "2026-01-01").inputTokens).toBe(100);
    expect(row(rows, "2026-01-02").inputTokens).toBe(250); // 200 + 50
    expect(row(rows, "2026-01-02").apiCalls).toBe(2);
  });

  it("groups by model", () => {
    const { rows } = computeStats(ALL, { by: "model" });
    expect(row(rows, "opus").inputTokens).toBe(300);
    expect(row(rows, "gpt").inputTokens).toBe(50);
  });

  it("counts the sessions that model and day grouping cannot place", () => {
    // Session c records no cost event, so there is no model and no day to key
    // it by — but the totals still count it. Report the gap.
    const byModel = computeStats(ALL, { by: "model" });
    expect(byModel.unattributedSessions).toBe(1);
    expect(byModel.totals.sessions).toBe(3);
    expect(byModel.rows.reduce((n, r) => n + r.sessions, 0)).toBe(2);

    expect(computeStats(ALL, { by: "day" }).unattributedSessions).toBe(1);
    // Runtime and project can always place a session, so nothing is left over.
    expect(computeStats(ALL, { by: "runtime" }).unattributedSessions).toBe(0);
    expect(computeStats(ALL, { by: "project" }).unattributedSessions).toBe(0);
  });

  it("groups by runtime and by project", () => {
    const byRuntime = computeStats(ALL, { by: "runtime" }).rows;
    expect(row(byRuntime, "claude-code").sessions).toBe(1);
    expect(row(byRuntime, "codex").sessions).toBe(2);

    const byProject = computeStats(ALL, { by: "project" }).rows;
    expect(byProject.map((r) => r.key).sort()).toEqual(["alpha", "beta"]);
    expect(row(byProject, "beta").sessions).toBe(2);
  });

  it("says a group recorded no cost rather than showing it as zero", () => {
    // The one session with no cost events must not read as "this was free".
    const rows = computeStats([{ id: "c", events: C }], { by: "runtime" }).rows;
    expect(row(rows, "codex").costRecorded).toBe(false);
    expect(row(rows, "codex").apiCalls).toBe(0);
    expect(row(rows, "codex").sessions).toBe(1);
    // It still contributes its files: those are recorded even when cost is not.
    expect(row(rows, "codex").files).toBe(1);
  });

  it("totals across every group", () => {
    const { totals } = computeStats(ALL, { by: "day" });
    expect(totals.apiCalls).toBe(3);
    expect(totals.inputTokens).toBe(350);
    expect(totals.sessions).toBe(3);
  });

  it("honours --since by the session's last event", () => {
    // A ends 01-02T10:00, B ends 01-02T11:00 -- a cutoff of 10:30 drops A only.
    const now = Date.parse("2026-01-02T11:30:00.000Z");
    const res = computeStats(ALL, { by: "day", sinceMs: 3600_000, now });
    expect(res.skippedBySince).toBe(1);
    expect(res.totals.apiCalls).toBe(1); // only B's cost event survives
  });
});

describe("price tables", () => {
  it("costs only what the table covers, and names what it does not", () => {
    const prices = parsePriceTable(
      JSON.stringify({ currency: "USD", per: 1_000_000, models: { opus: { input: 10, output: 100 } } }),
    );
    const { rows, totals } = computeStats(ALL, { by: "model", prices });
    // opus: 300 in * 10/1e6 + 30 out * 100/1e6
    expect(row(rows, "opus").cost).toBeCloseTo(300 * 1e-5 + 30 * 1e-4, 10);
    // gpt has no rate: reported as unpriced, never costed at zero.
    expect(row(rows, "gpt").cost).toBeUndefined();
    expect(row(rows, "gpt").unpriced).toEqual(["gpt"]);
    expect(totals.unpriced).toEqual(["gpt"]);
    // And the total declines to state a figure it knows is incomplete.
    expect(totals.cost).toBeUndefined();
  });

  it("defaults to per-million and rejects a nonsense unit", () => {
    expect(parsePriceTable('{"models":{}}').per).toBe(1_000_000);
    expect(() => parsePriceTable('{"per":0,"models":{}}')).toThrow(PriceTableError);
    expect(() => parsePriceTable("not json")).toThrow(/not valid JSON/);
    expect(() => parsePriceTable('{"currency":"USD"}')).toThrow(/"models"/);
  });
});

describe("agit stats through the CLI", () => {
  let store: string;
  beforeAll(() => {
    store = mkdtempSync(join(tmpdir(), "agit-stats-"));
    for (const f of [
      join(ROOT, "fixtures", "claude-code", "demo.jsonl"),
      join(ROOT, "fixtures", "codex", "edits.jsonl"),
    ]) {
      expect(agit(["import", f, "--dir", store]).code).toBe(0);
    }
  });

  it("prints a table with a dash for the runtime that records no cost", () => {
    const r = agit(["stats", "--by", "runtime", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RUNTIME");
    expect(r.out).toMatch(/codex\s+—/);
    expect(r.out).toContain("no cost events recorded for that group");
  });

  it("shows no money at all without a rate table", () => {
    const r = agit(["stats", "--dir", store]);
    expect(r.out).not.toContain("COST");
    expect(r.out).toContain("pass --price");
  });

  it("costs with a supplied table", () => {
    const rates = join(store, "rates.json");
    writeFileSync(
      rates,
      JSON.stringify({ currency: "USD", models: { "claude-opus-5": { input: 15, output: 75 } } }),
      "utf8",
    );
    const r = agit(["stats", "--by", "model", "--price", rates, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("COST (USD)");
  });

  it("rejects an unknown --by", () => {
    const r = agit(["stats", "--by", "wednesday", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("unknown --by");
    expect(r.out).toContain("runtime");
  });

  it("emits JSON when asked", () => {
    const r = agit(["stats", "--by", "runtime", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { by: string; rows: StatsRow[]; totals: StatsRow };
    expect(doc.by).toBe("runtime");
    expect(doc.rows.some((x) => x.costRecorded === false)).toBe(true);
    expect(doc.totals.sessions).toBe(2);
  });

  // A conflict resolution once deleted most of this header and every test
  // still passed, because they only ever asserted the first column. Assert
  // the whole row: a missing column is a silently narrower report.
  it("prints every column, in order", () => {
    const r = agit(["stats", "--by", "runtime", "--dir", store]);
    expect(r.code).toBe(0);
    const header = r.out.split("\n").find((l) => l.includes("RUNTIME"));
    expect(header?.split(/\s{2,}/).map((s) => s.trim())).toEqual([
      "RUNTIME",
      "CALLS",
      "IN",
      "OUT",
      "CACHE READ",
      "CACHE WRITE",
      "SESSIONS",
      "FILES",
    ]);
  });

  it("adds a COST column, and only that, when a rate table is supplied", () => {
    const rates = join(store, "cols.json");
    writeFileSync(rates, JSON.stringify({ currency: "EUR", models: {} }), "utf8");
    const r = agit(["stats", "--by", "runtime", "--price", rates, "--dir", store]);
    const header = r.out.split("\n").find((l) => l.includes("RUNTIME"));
    expect(header?.split(/\s{2,}/).map((s) => s.trim())).toEqual([
      "RUNTIME",
      "CALLS",
      "IN",
      "OUT",
      "CACHE READ",
      "CACHE WRITE",
      "SESSIONS",
      "FILES",
      "COST (EUR)",
    ]);
  });

  // Grouping by model keys off the cost event, so the Codex session lands in
  // no row while the total still counts it. The rows not summing to the total
  // is honest, but only if the report says why.
  it("says when sessions reach the total but no row", () => {
    const r = agit(["stats", "--by", "model", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 session(s) recorded no cost events");
    expect(r.out).toContain("in no model row");
    expect(r.out).toContain("--by runtime");
  });

  it("stays quiet about it when every session lands in a row", () => {
    const r = agit(["stats", "--by", "runtime", "--dir", store]);
    expect(r.out).not.toContain("recorded no cost events, so they appear");
  });
});
