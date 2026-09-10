import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

interface ModelRow {
  model: string;
  costRecorded: boolean;
  apiMessages: number;
  inputTokens: number;
  files: string[];
  filesAreLowerBound: boolean;
}

let store: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-json-honesty-"));
  expect(agit(["import", CODEX, "--dir", store]).code).toBe(0);
  expect(agit(["import", DEMO, "--dir", store]).code).toBe(0);
});

describe("show --by-model --json does not assert what the table refuses to print", () => {
  it("marks a runtime that records no cost, instead of reporting it as free", () => {
    // The Codex fixture logs no cost events. The table says so in prose; the
    // JSON used to emit a row of zeros, which claims the opposite.
    const human = agit(["show", "0199", "--by-model", "--dir", store]);
    expect(human.out).toContain("no cost events in this session");

    const rows = JSON.parse(agit(["show", "0199", "--by-model", "--json", "--dir", store]).out) as ModelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costRecorded).toBe(false);
    expect(rows[0]!.apiMessages).toBe(0);
  });

  it("marks a runtime that does record cost", () => {
    const rows = JSON.parse(agit(["show", "demo", "--by-model", "--json", "--dir", store]).out) as ModelRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.costRecorded).toBe(true);
    expect(rows[0]!.apiMessages).toBeGreaterThan(0);
  });

  it("uses the same field name stats --json already uses for the distinction", () => {
    const stats = JSON.parse(agit(["stats", "--by", "runtime", "--json", "--dir", store]).out) as {
      rows: { key: string; costRecorded: boolean }[];
    };
    const codex = stats.rows.find((r) => r.key === "codex")!;
    expect(codex.costRecorded).toBe(false);
  });
});

describe("the JSON carries the SPEC 5.7 caveat the table prints", () => {
  it("ls says its file count is a lower bound", () => {
    const human = agit(["ls", "--dir", store]).out;
    expect(human).toContain("lower bound");
    const rows = JSON.parse(agit(["ls", "--json", "--dir", store]).out) as {
      files: number;
      filesAreLowerBound: boolean;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.filesAreLowerBound).toBe(true);
      expect(typeof r.files).toBe("number");
    }
  });

  it("show says its file list is a lower bound", () => {
    const human = agit(["show", "0199", "--dir", store]).out;
    expect(human).toMatch(/lower bound/);
    const doc = JSON.parse(agit(["show", "0199", "--json", "--dir", store]).out) as {
      files: unknown[];
      filesAreLowerBound: boolean;
    };
    expect(doc.filesAreLowerBound).toBe(true);
    expect(Array.isArray(doc.files)).toBe(true);
  });

  it("show --by-model says so per row", () => {
    const rows = JSON.parse(agit(["show", "0199", "--by-model", "--json", "--dir", store]).out) as ModelRow[];
    expect(rows[0]!.filesAreLowerBound).toBe(true);
  });

  it("stats says so on every row and the total", () => {
    const human = agit(["stats", "--dir", store]).out;
    expect(human).toContain("lower bound");
    const doc = JSON.parse(agit(["stats", "--by", "runtime", "--json", "--dir", store]).out) as {
      rows: { filesAreLowerBound: boolean }[];
      totals: { filesAreLowerBound: boolean };
    };
    expect(doc.rows.length).toBeGreaterThan(0);
    for (const r of doc.rows) expect(r.filesAreLowerBound).toBe(true);
    expect(doc.totals.filesAreLowerBound).toBe(true);
  });

  it("an unreadable session still reports readable:false without claiming a count", () => {
    // The flag rides with a count; a row with no count must not imply one.
    const rows = JSON.parse(agit(["ls", "--json", "--dir", store]).out) as {
      readable: boolean;
      files?: number;
      filesAreLowerBound?: boolean;
    }[];
    for (const r of rows) {
      if (!r.readable) expect(r.files).toBeUndefined();
    }
  });
});
