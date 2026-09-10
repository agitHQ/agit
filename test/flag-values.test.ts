import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

/** Run from `cwd` so the "silently fell back to the current directory" case is visible. */
function agit(args: string[], cwd?: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000, cwd });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

let store: string;
let elsewhere: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-flags-"));
  expect(agit(["import", DEMO, "--dir", store]).code).toBe(0);
  // A second store, holding a different session, standing in for "the current
  // directory happens to have one too".
  elsewhere = mkdtempSync(join(tmpdir(), "agit-flags-cwd-"));
  expect(agit(["import", SIMPLE, "--dir", elsewhere]).code).toBe(0);
});

describe("a flag with a missing value is an error, not a silent fallback", () => {
  it("--dir with no path does not quietly operate on the current directory", () => {
    // The bug: this listed whatever store the cwd held, exit 0, with nothing
    // to say --dir had been ignored. That is what a script does when the
    // variable holding the path is empty.
    const r = agit(["ls", "--dir"], elsewhere);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--dir needs a value");
    expect(r.out).not.toContain("fixture-simple");
  });

  it("names the flag it swallowed when the next argument is another flag", () => {
    const r = agit(["grep", "ratelimit", "--tag", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--tag needs a value");
    expect(r.out).toContain("--dir");
  });

  it("covers the flags that take a value, not just --dir", () => {
    for (const flag of [
      "--sort",
      "--runtime",
      "--project",
      "--by",
      "--type",
      "--out",
      "--into",
      "--summary",
      "--base",
      "--price",
      "--session",
      "--redact-patterns",
      "--host",
      "--relay",
      "--cert",
      "--key",
      "--trusted-proxy",
      "--at",
      "--ttl",
      "--port",
      "--since",
      "--older-than",
    ]) {
      const r = agit(["ls", flag]);
      expect(r.code, `${flag} should be rejected`).toBe(2);
      expect(r.out, `${flag} should be named`).toContain(`${flag} needs a value`);
    }
  });

  it("suggests the way to pass a value that looks like a flag", () => {
    const r = agit(["ls", "--sort"]);
    expect(r.out).toContain("--sort=<value>");
  });
});

describe("--flag=value", () => {
  it("passes a value normally", () => {
    const r = agit([`--dir=${store}`, "ls"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude-code");
  });

  it("passes a value that itself starts with --", () => {
    // Nothing else can express this, which is why the strict check needs it.
    const r = agit(["tag", "demo", "--x-weird-tag", `--dir=${store}`]);
    expect(r.code).toBe(0);
    const listed = agit(["ls", "--tag=--x-weird-tag", `--dir=${store}`]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("demo");
  });

  it("keeps everything after the first = as the value", () => {
    const r = agit(["note", "demo", "--dir", store]);
    expect(r.code).toBe(0);
    const set = agit(["note", "demo", "a=b=c", "--dir", store]);
    expect(set.code).toBe(0);
    expect(agit(["note", "demo", "--dir", store]).out).toContain("a=b=c");
  });
});

describe("what must keep working", () => {
  it("a negative number is a value, not a flag", () => {
    // --at -1 is out of range, but it has to reach the range check to say so.
    const r = agit(["replay", "demo", "--at", "-1", "--state", "--dir", store]);
    expect(r.out).not.toContain("needs a value");
    expect(r.out).toContain("outside this session");
  });

  it("ordinary invocations are unaffected", () => {
    expect(agit(["ls", "--dir", store]).code).toBe(0);
    expect(agit(["show", "demo", "--dir", store]).code).toBe(0);
    expect(agit(["stats", "--by", "runtime", "--dir", store]).code).toBe(0);
    expect(agit(["grep", "ratelimit", "--type", "file.diff", "--dir", store]).code).toBe(0);
  });

  it("valueless flags still take no value", () => {
    const r = agit(["ls", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
  });
});
