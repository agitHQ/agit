import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `agit stats` (issue #67, scoped down): usage across every imported
 * session, grouped by model (default) or runtime. `--since` and `--price`
 * from the same issue are separate, larger pieces of work and not part of
 * this first cut — this is a fold over data `usageTotals`/`usageByModel`
 * already compute per session, merged across the whole store.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

interface StatsRow {
  key: string;
  sessions: number;
  apiMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}
interface StatsJson {
  by: string;
  sessionsRead: number;
  sessionsSkipped: number;
  rows: StatsRow[];
}

let store: string;

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-stats-"));
  expect(agit(["import", SIMPLE, "--dir", store]).code).toBe(0);
  expect(agit(["import", DEMO, "--dir", store]).code).toBe(0);
  expect(agit(["import", CODEX, "--dir", store]).code).toBe(0);
});

describe("agit stats", () => {
  it("an empty store says so plainly, not an error", () => {
    const empty = mkdtempSync(join(tmpdir(), "agit-stats-empty-"));
    const r = agit(["stats", "--dir", empty]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no sessions imported yet");
  });

  it("an empty store, --json: an empty array", () => {
    const empty = mkdtempSync(join(tmpdir(), "agit-stats-empty-"));
    const r = agit(["stats", "--json", "--dir", empty]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("groups by model by default, and the totals add up across every row", () => {
    const r = agit(["stats", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as StatsJson;
    expect(doc.by).toBe("model");
    expect(doc.sessionsRead).toBe(3);
    expect(doc.sessionsSkipped).toBe(0);
    expect(doc.rows.length).toBeGreaterThan(0);

    const claude = doc.rows.find((r2) => r2.key === "claude-opus-5")!;
    expect(claude).toBeDefined();
    expect(claude.sessions).toBe(2); // simple + demo both used it
    expect(claude.apiMessages).toBeGreaterThan(0);

    const sumInput = doc.rows.reduce((n, r2) => n + r2.inputTokens, 0);
    const sumOutput = doc.rows.reduce((n, r2) => n + r2.outputTokens, 0);
    expect(sumInput).toBeGreaterThan(0);
    expect(sumOutput).toBeGreaterThan(0);
  });

  it("--by runtime groups by session.start's runtime instead", () => {
    const r = agit(["stats", "--by", "runtime", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as StatsJson;
    expect(doc.by).toBe("runtime");
    const claudeCode = doc.rows.find((r2) => r2.key === "claude-code")!;
    const codex = doc.rows.find((r2) => r2.key === "codex")!;
    expect(claudeCode.sessions).toBe(2);
    expect(codex.sessions).toBe(1);
  });

  it("a model or runtime with no cost events still gets a row, not silence", () => {
    // The codex fixture has file edits attributed to a model but no
    // token_count/cost records — usageByModel already surfaces that as a
    // zero-message row rather than omitting it; stats must not filter it out.
    const r = agit(["stats", "--by", "runtime", "--json", "--dir", store]);
    const doc = JSON.parse(r.out) as StatsJson;
    const codex = doc.rows.find((r2) => r2.key === "codex")!;
    expect(codex).toBeDefined();
    expect(codex.apiMessages).toBe(0);
  });

  it("rejects an unknown --by value instead of silently defaulting", () => {
    const r = agit(["stats", "--by", "nonsense", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--by takes "model" or "runtime"/);
  });

  it("human output prints a table and a totals line", () => {
    const r = agit(["stats", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("agit stats — 3 sessions, by model");
    expect(r.out).toContain("MODEL");
    expect(r.out).toContain("totals:");
  });

  it("one corrupt session is skipped and counted, not fatal to the rest", () => {
    const dirty = mkdtempSync(join(tmpdir(), "agit-stats-corrupt-"));
    expect(agit(["import", SIMPLE, "--dir", dirty]).code).toBe(0);
    expect(agit(["import", DEMO, "--dir", dirty]).code).toBe(0);
    // Corrupt one session's log directly.
    execFileSync(process.execPath, [
      "-e",
      `require("fs").writeFileSync(process.argv[1], "")`,
      join(dirty, ".agit", "sessions", "fixture-simple-0001", "events.jsonl"),
    ]);
    const r = agit(["stats", "--json", "--dir", dirty]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as StatsJson;
    expect(doc.sessionsRead).toBe(1);
    expect(doc.sessionsSkipped).toBe(1);
  });
});
