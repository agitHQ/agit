import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  builtinConfig,
  customPatternCount,
  disabledConfig,
  parseRedactionConfig,
  redactDeep,
  redactString,
  RedactionConfigError,
  scanValue,
  type RedactionCounts,
} from "../src/redact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");

/**
 * spawnSync rather than execFileSync: several of these assertions are about
 * warnings, which go to stderr even on a successful run, and execFileSync
 * only hands back stderr when the command failed.
 */
function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const counts = (): RedactionCounts => ({});

describe("custom patterns (#70)", () => {
  it("redacts an internal token format the built-ins cannot know", () => {
    const cfg = parseRedactionConfig(
      JSON.stringify({ patterns: [{ label: "acme", regex: "acme_[A-Za-z0-9]{10,}" }] }),
    );
    expect(customPatternCount(cfg)).toBe(1);
    const out = redactString("token is acme_ABCDEFGHIJKL here", counts(), cfg);
    expect(out).toBe("token is [REDACTED:acme] here");
  });

  it("still applies every built-in alongside the custom ones", () => {
    const cfg = parseRedactionConfig(JSON.stringify({ patterns: [{ label: "acme", regex: "acme_[0-9]+" }] }));
    const c = counts();
    redactString("sk-ant-abcdefghijklmnopqrstuv and acme_12345", c, cfg);
    expect(c["anthropic-key"]).toBe(1);
    expect(c.acme).toBe(1);
  });

  it("forces the global flag so a second copy is not left behind", () => {
    const cfg = parseRedactionConfig(
      JSON.stringify({ patterns: [{ label: "acme", regex: "acme_[0-9]+", flags: "i" }] }),
    );
    const out = redactString("acme_1 and acme_2", counts(), cfg);
    expect(out).toBe("[REDACTED:acme] and [REDACTED:acme]");
  });

  it("rejects a malformed config with a message naming the problem", () => {
    expect(() => parseRedactionConfig("nope")).toThrow(/not valid JSON/);
    expect(() => parseRedactionConfig('{"patterns":{}}')).toThrow(/"patterns" must be an array/);
    expect(() => parseRedactionConfig('{"patterns":[{"label":"x"}]}')).toThrow(/"regex"/);
    expect(() => parseRedactionConfig('{"patterns":[{"label":"x","regex":"["}]}')).toThrow(
      RedactionConfigError,
    );
    expect(() => parseRedactionConfig('{"allow":[{"nope":1}]}')).toThrow(/allow entry/);
  });
});

describe("allowlist", () => {
  it("leaves a documented example key alone, and does not count it", () => {
    const example = "sk-ant-EXAMPLE00000000000000";
    const cfg = parseRedactionConfig(JSON.stringify({ allow: [example] }));
    const c = counts();
    expect(redactString(`use ${example} in docs`, c, cfg)).toBe(`use ${example} in docs`);
    // A false positive that is "redacted 3 times" is still a false positive.
    expect(c["anthropic-key"]).toBeUndefined();
  });

  it("accepts a regex allow rule", () => {
    const cfg = parseRedactionConfig(JSON.stringify({ allow: [{ regex: "^sk-ant-example-" }] }));
    const c = counts();
    expect(redactString("sk-ant-example-aaaaaaaaaaaaaaaa", c, cfg)).toContain("sk-ant-example-");
    // A real-looking key is still redacted.
    expect(redactString("sk-ant-live0000000000000000", c, cfg)).toContain("[REDACTED:");
  });

  it("does not allowlist a different key that merely looks similar", () => {
    const cfg = parseRedactionConfig(JSON.stringify({ allow: ["sk-ant-EXAMPLE00000000000000"] }));
    expect(redactString("sk-ant-REAL00000000000000000", counts(), cfg)).toContain("[REDACTED:");
  });
});

describe("--no-redact config", () => {
  it("passes strings through untouched", () => {
    const cfg = disabledConfig();
    const c = counts();
    const secret = "sk-ant-abcdefghijklmnopqrstuv";
    expect(redactString(secret, c, cfg)).toBe(secret);
    expect(redactDeep({ a: secret }, c, cfg)).toEqual({ a: secret });
    expect(Object.keys(c)).toHaveLength(0);
  });
});

describe("scanValue", () => {
  it("reports the payload path and masks the sample", () => {
    const found = scanValue({ input: { command: "export K=sk-ant-abcdefghijklmnopqrstuv" } });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.at).toBe("input.command");
    // The report must not leak what it found.
    expect(found.some((f) => f.sample.includes("abcdefghijklmnopqrstuv"))).toBe(false);
    expect(found[0]!.sample).toMatch(/…/);
  });

  it("finds nothing in ordinary code", () => {
    expect(scanValue({ text: "const total = items.length + 1;" }, builtinConfig())).toEqual([]);
  });
});

describe("the CLI", () => {
  let store: string;
  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "agit-redact-"));
  });

  it("redact --check reports matches, masked, and re-scans clean", () => {
    const r = agit(["redact", "--check", DEMO, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("would redact");
    expect(r.out).toContain("anthropic-key");
    expect(r.out).toContain("re-scan after redaction: clean");
    // Masked: the fixture's key must not appear in the report.
    expect(r.out).not.toMatch(/sk-ant-[A-Za-z0-9_-]{16,}/);
  });

  it("reads .agit/redact.json from the store by convention", () => {
    mkdirSync(join(store, ".agit"), { recursive: true });
    writeFileSync(
      join(store, ".agit", "redact.json"),
      JSON.stringify({ patterns: [{ label: "acme", regex: "ratelimit" }] }),
      "utf8",
    );
    const r = agit(["redact", "--check", DEMO, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 custom pattern(s)");
    expect(r.out).toContain("acme");
  });

  it("names the file when the config is broken", () => {
    const bad = join(store, "bad.json");
    writeFileSync(bad, "{oops", "utf8");
    const r = agit(["import", DEMO, "--redact-patterns", bad, "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("not valid JSON");
    expect(r.out).toContain("bad.json");
  });

  it("--no-redact says so plainly rather than 'nothing matched'", () => {
    const r = agit(["import", DEMO, "--no-redact", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DISABLED (--no-redact)");
    expect(r.out).not.toContain("nothing matched");
    // The secret really is still in the stored log — that is the point.
    const log = readFileSync(join(store, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"), "utf8");
    expect(log).toMatch(/sk-ant-/);
  });

  it("refuses to publish an unredacted session, and says how to proceed", () => {
    agit(["import", DEMO, "--no-redact", "--dir", store]);
    const r = agit(["pr", "demo", "--out", join(store, "bundle"), "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--no-redact");
    expect(r.out).toContain("--allow-unredacted");
  });

  it("publishes it when the caller says so explicitly", () => {
    agit(["import", DEMO, "--no-redact", "--dir", store]);
    const r = agit(["pr", "demo", "--allow-unredacted", "--out", join(store, "bundle"), "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning");
  });

  it("a normally imported session is unaffected by the gate", () => {
    agit(["import", DEMO, "--dir", store]);
    const r = agit(["pr", "demo", "--out", join(store, "bundle2"), "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("--allow-unredacted");
  });
});
