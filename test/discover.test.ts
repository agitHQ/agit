import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSessionLogs, parseSince } from "../src/discover.js";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "agit-home-"));
}

/** Create a file, optionally back-dating its mtime. */
function put(p: string, ageMs = 0): string {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{"stub":true}\n', "utf8");
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
  }
  return p;
}

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("discoverSessionLogs", () => {
  it("finds each runtime's logs where that runtime writes them", () => {
    const home = fakeHome();
    const claude = put(join(home, ".claude", "projects", "C--proj", "abc.jsonl"));
    const codex = put(
      join(home, ".codex", "sessions", "2026", "09", "08", "rollout-2026-09-08T10-00-00-x.jsonl"),
    );
    const claw = put(join(home, ".openclaw", "agents", "main", "sessions", "s1.jsonl"));
    // Noise that must not be picked up.
    put(join(home, ".claude", "projects", "C--proj", "notes.txt"));
    put(join(home, ".codex", "sessions", "2026", "09", "08", "not-a-rollout.jsonl"));
    put(join(home, ".openclaw", "agents", "main", "sessions", "sessions.json"));

    const { logs, roots } = discoverSessionLogs(home, {});
    expect(logs.map((l) => [l.runtime, l.path])).toEqual(
      expect.arrayContaining([
        ["claude-code", claude],
        ["codex", codex],
        ["openclaw", claw],
      ]),
    );
    expect(logs).toHaveLength(3);
    expect(roots.map((r) => [r.runtime, r.exists, r.found])).toEqual([
      ["claude-code", true, 1],
      ["codex", true, 1],
      ["openclaw", true, 1],
      ["gemini-cli", false, 0],
      ["opencode", false, 0],
      ["kimi-code", false, 0],
      ["cline-sdk", false, 0],
      ["cline-classic", false, 0],
      ["cline-classic", false, 0],
      ["cline-classic", false, 0],
      ["roo-code", false, 0],
      ["roo-code", false, 0],
    ]);
  });

  it("skips OpenClaw checkpoints, trajectories and archives, which share a session's id", () => {
    const home = fakeHome();
    const dir = join(home, ".openclaw", "agents", "main", "sessions");
    const real = put(join(dir, "s1.jsonl"));
    put(join(dir, `s1.checkpoint.${UUID}.jsonl`));
    put(join(dir, "s1.trajectory.jsonl"));
    put(join(dir, "s1.jsonl.deleted.2026-09-09T00-00-00-000Z"));
    put(join(dir, "s1.jsonl.reset.2026-09-09T00-00-00-000Z.gz"));
    const { logs } = discoverSessionLogs(home, {});
    expect(logs.map((l) => l.path)).toEqual([real]);
  });

  it("honours OPENCLAW_STATE_DIR, including the ~/ form", () => {
    const home = fakeHome();
    const custom = put(join(home, "elsewhere", "agents", "a", "sessions", "z.jsonl"));
    put(join(home, ".openclaw", "agents", "a", "sessions", "default.jsonl"));

    const abs = discoverSessionLogs(home, { OPENCLAW_STATE_DIR: join(home, "elsewhere") });
    expect(abs.logs.map((l) => l.path)).toEqual([custom]);

    const tilde = discoverSessionLogs(home, { OPENCLAW_STATE_DIR: "~/elsewhere" });
    expect(tilde.logs.map((l) => l.path)).toEqual([custom]);
  });

  it("reports roots that do not exist instead of failing", () => {
    const home = fakeHome();
    const { logs, roots } = discoverSessionLogs(home, {});
    expect(logs).toEqual([]);
    expect(roots.every((r) => !r.exists && r.found === 0)).toBe(true);
    expect(roots.map((r) => r.runtime)).toEqual([
      "claude-code",
      "codex",
      "openclaw",
      "gemini-cli",
      "opencode",
      "kimi-code",
      "cline-sdk",
      "cline-classic",
      "cline-classic",
      "cline-classic",
      "roo-code",
      "roo-code",
    ]);
  });

  it("orders oldest first, so import output is stable", () => {
    const home = fakeHome();
    const newer = put(join(home, ".claude", "projects", "p", "new.jsonl"));
    const older = put(join(home, ".claude", "projects", "p", "old.jsonl"), 3 * 86_400_000);
    const { logs } = discoverSessionLogs(home, {});
    expect(logs.map((l) => l.path)).toEqual([older, newer]);
  });
});

describe("parseSince", () => {
  it("accepts days, hours and minutes and rejects everything else", () => {
    expect(parseSince("7d")).toBe(7 * 86_400_000);
    expect(parseSince("24h")).toBe(24 * 3_600_000);
    expect(parseSince("30m")).toBe(30 * 60_000);
    expect(parseSince(" 2d ")).toBe(2 * 86_400_000);
    for (const bad of ["", "7", "d7", "1w", "2 days", "-1d"]) expect(parseSince(bad), bad).toBeNull();
  });
});
