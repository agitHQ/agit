import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIXTURE_DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const FIXTURE_SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function setupStore(): { dir: string; id1: string; id2: string } {
  const dir = mkdtempSync(join(tmpdir(), "agit-test-json-"));
  expect(agit(["import", FIXTURE_DEMO, "--dir", dir]).code).toBe(0);
  expect(agit(["import", FIXTURE_SIMPLE, "--dir", dir]).code).toBe(0);
  return { dir, id1: "demo", id2: "fixture" };
}

describe("--json flag on read verbs", () => {
  it("agit ls --json outputs a valid JSON array of session objects", () => {
    const { dir } = setupStore();
    const res = agit(["ls", "--json", "--dir", dir]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.out) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    for (const item of parsed) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.started).toBe("string");
      expect(typeof item.events).toBe("string");
      expect(typeof item.files).toBe("string");
      expect(typeof item.runtime).toBe("string");
    }
  });

  it("agit ls --json outputs [] when store is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-test-empty-"));
    const res = agit(["ls", "--json", "--dir", dir]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual([]);
  });

  it("agit show <id> --json outputs session summary with array model usage", () => {
    const { dir, id1 } = setupStore();
    const res = agit(["show", id1, "--json", "--dir", dir]);
    expect(res.code).toBe(0);
    const summary = JSON.parse(res.out) as Record<string, unknown>;
    expect(summary.id).toBeDefined();
    expect(typeof summary.events).toBe("number");
    const usage = summary.usage as Record<string, unknown>;
    expect(usage).toBeDefined();
    expect(Array.isArray(usage.models)).toBe(true);
    expect(Array.isArray(summary.files)).toBe(true);
  });

  it("agit show <id> --by-model --json outputs ModelUsage[] with array files", () => {
    const { dir, id1 } = setupStore();
    const res = agit(["show", id1, "--by-model", "--json", "--dir", dir]);
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.out) as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      const first = rows[0]!;
      expect(typeof first.model).toBe("string");
      expect(typeof first.inputTokens).toBe("number");
      expect(Array.isArray(first.files)).toBe(true);
    }
  });

  it("agit verify <id> --json outputs VerifyResult object", () => {
    const { dir, id1 } = setupStore();
    const res = agit(["verify", id1, "--json", "--dir", dir]);
    expect(res.code).toBe(0);
    const v = JSON.parse(res.out) as Record<string, unknown>;
    expect(v.ok).toBe(true);
    expect(typeof v.events).toBe("number");
  });

  it("agit verify <id> --json outputs ok: false and exits with 1 on tampered log", () => {
    const { dir, id1 } = setupStore();
    // Tamper log
    const metaPath = join(dir, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl");
    writeFileSync(metaPath, readFileSync(metaPath, "utf8").replace("rate limiting", "RATE LIMITING"), "utf8");
    const res = agit(["verify", id1, "--json", "--dir", dir]);
    expect(res.code).toBe(1);
    const v = JSON.parse(res.out) as Record<string, unknown>;
    expect(v.ok).toBe(false);
    expect(typeof v.events).toBe("number");
    expect(v.firstBroken).toBeDefined();
  });

  it("agit grep <pattern> --json outputs exactly one JSON object per line", () => {
    const { dir } = setupStore();
    const res = agit(["grep", "rate", "--json", "--dir", dir]);
    expect(res.code).toBe(0);
    const lines = res.out.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const hit = JSON.parse(line) as Record<string, unknown>;
      expect(typeof hit.session).toBe("string");
      expect(typeof hit.seq).toBe("number");
      expect(typeof hit.type).toBe("string");
      expect(typeof hit.line).toBe("string");
    }
  });

  it("agit grep <pattern> --json returns exit code 1 when no matches", () => {
    const { dir } = setupStore();
    const res = agit(["grep", "nonexistentpattern9999", "--json", "--dir", dir]);
    expect(res.code).toBe(1);
  });

  it("agit diff <a> <b> --json outputs SessionDiff object", () => {
    const { dir, id1, id2 } = setupStore();
    const res = agit(["diff", id1, id2, "--json", "--dir", dir]);
    expect(res.code).toBe(0);
    const diff = JSON.parse(res.out) as Record<string, unknown>;
    expect(diff.a).toBeDefined();
    expect(diff.b).toBeDefined();
    expect(Array.isArray(diff.files)).toBe(true);
  });
});
