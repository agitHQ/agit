import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Looks exactly like a real key, which is the point: only the allowlist saves it. */
const EXAMPLE = "sk-ant-EXAMPLE0000000000000";
const REAL = "sk-ant-" + "z".repeat(24);

let store: string;

function log(name: string, content: string, sessionId: string): string {
  const p = join(store, name);
  writeFileSync(
    p,
    JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "2.1.0",
      cwd: "/w",
      message: { role: "user", content },
    }) + "\n",
    "utf8",
  );
  return p;
}

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "agit-allowlist-"));
  mkdirSync(join(store, ".agit"), { recursive: true });
  writeFileSync(join(store, ".agit", "redact.json"), JSON.stringify({ allow: [EXAMPLE] }), "utf8");
});

describe("the project's redaction config is the only one that runs at import", () => {
  it("an allowlisted key survives, which is the whole point of an allowlist", () => {
    // A second, config-less pass used to run the built-ins again over the
    // result, undoing the allowlist: #79 guarded the original line and #98
    // added a config-aware one above it, and the merge kept both.
    const p = log("allow.jsonl", `documented example key: ${EXAMPLE}`, "allow-demo-0001");
    const r = agit(["import", p, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing matched");

    const stored = agit(["export", "allow", "--dir", store]);
    expect(stored.out).toContain(EXAMPLE);
    expect(stored.out).not.toContain("REDACTED:anthropic-key");
  });

  it("a key that is not allowlisted is still redacted", () => {
    const p = log("real.jsonl", `key ${REAL}`, "real-demo-0001");
    const r = agit(["import", p, "--dir", store]);
    expect(r.out).toContain("anthropic-key");

    const stored = agit(["export", "real", "--dir", store]);
    expect(stored.out).not.toContain(REAL);
    expect(stored.out).toContain("REDACTED:anthropic-key");
  });

  it("counts each redaction once", () => {
    // Two passes sharing one counter is the other way this could have gone
    // wrong, so pin the count rather than just the content.
    const p = log("two.jsonl", `a ${REAL} b ${"sk-ant-" + "y".repeat(24)}`, "count-demo-0001");
    const r = agit(["import", p, "--dir", store]);
    expect(r.out).toMatch(/redacted\s+2: anthropic-key×2/);
  });

  it("--no-redact still stores the log exactly as written", () => {
    const p = log("raw.jsonl", `key ${REAL}`, "raw-demo-0001");
    const r = agit(["import", p, "--no-redact", "--dir", store]);
    expect(r.out).toContain("DISABLED (--no-redact)");
    expect(agit(["export", "raw", "--dir", store]).out).toContain(REAL);
  });

  it("a store with no config still gets the built-ins", () => {
    const bare = mkdtempSync(join(tmpdir(), "agit-allowlist-bare-"));
    const p = join(bare, "x.jsonl");
    writeFileSync(
      p,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "bare-demo-0001",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/w",
        message: { role: "user", content: `key ${REAL}` },
      }) + "\n",
      "utf8",
    );
    const r = agit(["import", p, "--dir", bare]);
    expect(r.out).toContain("anthropic-key");
    expect(agit(["export", "bare", "--dir", bare]).out).not.toContain(REAL);
  });
});
