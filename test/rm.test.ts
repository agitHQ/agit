import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `agit rm <id>` (issue #71, store management). Deletes a session from the
 * store. No interactive prompt — `--yes` is the confirmation, so a script
 * can drive it deterministically the same way `docker rm -f`/`kubectl
 * delete` take an explicit flag rather than a y/n prompt nothing answers.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function storeWithSimple(): string {
  const dir = mkdtempSync(join(tmpdir(), "agit-rm-"));
  expect(agit(["import", SIMPLE, "--dir", dir]).code).toBe(0);
  return dir;
}

function sessionPath(store: string): string {
  return join(store, ".agit", "sessions", "fixture-simple-0001");
}

describe("agit rm", () => {
  it("refuses without confirmation, names the session, and deletes nothing", () => {
    const store = storeWithSimple();
    const r = agit(["rm", "fixture-simple-0001", "--dir", store]);
    // Tests have no terminal, so the prompt cannot be answered and rm stops.
    expect(r.code).toBe(1);
    expect(r.out).toContain("fixture-simple-0001");
    expect(r.out).toContain("--yes");
    expect(r.out).toContain("nothing deleted");
    expect(existsSync(sessionPath(store))).toBe(true);
  });

  it("says what will be lost before asking", () => {
    const store = storeWithSimple();
    const r = agit(["rm", "fixture-simple-0001", "--dir", store]);
    expect(r.out).toContain("18 events");
    // A fork keeps only the session id, so deleting the log strands it.
    expect(r.out).toContain("merge base");
  });

  it("deletes the session with --yes", () => {
    const store = storeWithSimple();
    const r = agit(["rm", "fixture-simple-0001", "--dir", store, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fixture-simple-0001");
    expect(existsSync(sessionPath(store))).toBe(false);
  });

  it("-y is the same as --yes", () => {
    const store = storeWithSimple();
    const r = agit(["rm", "fixture-simple-0001", "--dir", store, "-y"]);
    expect(r.code).toBe(0);
    expect(existsSync(sessionPath(store))).toBe(false);
  });

  it("accepts a unique id prefix, like every other verb", () => {
    const store = storeWithSimple();
    const r = agit(["rm", "fixture-", "--dir", store, "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(sessionPath(store))).toBe(false);
  });

  it("a removed session is gone from ls", () => {
    const store = storeWithSimple();
    agit(["rm", "fixture-simple-0001", "--dir", store, "--yes"]);
    const r = agit(["ls", "--dir", store]);
    expect(r.out).toContain("no sessions imported yet");
  });

  it("an unknown id is reported, not silently accepted", () => {
    const store = storeWithSimple();
    const r = agit(["rm", "does-not-exist", "--dir", store, "--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no session matches/);
    expect(existsSync(sessionPath(store))).toBe(true);
  });

  it("the confirmation message still names the session when its log is corrupt", () => {
    const store = storeWithSimple();
    // Truncate the events file to empty — readSessionEvents throws on this.
    execFileSync(process.execPath, [
      "-e",
      `require("fs").writeFileSync(process.argv[1], "")`,
      join(sessionPath(store), "events.jsonl"),
    ]);
    const r = agit(["rm", "fixture-simple-0001", "--dir", store]);
    expect(r.code).toBe(1);
    // The session rm is pointed at is often the one ls cannot summarize, so
    // the corruption must not stop rm from naming what it is about to delete.
    expect(r.out).toContain("fixture-simple-0001");
    // And --yes still removes it, since that's exactly the case rm exists for.
    const removed = agit(["rm", "fixture-simple-0001", "--dir", store, "--yes"]);
    expect(removed.code).toBe(0);
    expect(existsSync(sessionPath(store))).toBe(false);
  });
});
