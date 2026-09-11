import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { builtinConfig, parseRedactionConfig } from "../src/redact.js";
import { SessionFollower } from "../src/share.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** An internal token format no built-in pattern can know about. */
const TOKEN = "acme_" + "A".repeat(24);
const CONFIG = JSON.stringify({
  patterns: [{ label: "acme-token", regex: "acme_[A-Za-z0-9]{20,}" }],
});

let store: string;
let log: string;
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "agit-share-redact-"));
  log = join(store, "live.jsonl");
  writeFileSync(
    log,
    JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "redact-demo-0001",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "2.1.0",
      cwd: "/w",
      message: { role: "user", content: `deploy with ${TOKEN}` },
    }) + "\n",
    "utf8",
  );
  mkdirSync(join(store, ".agit"), { recursive: true });
  writeFileSync(join(store, ".agit", "redact.json"), CONFIG, "utf8");
});

const published = (f: SessionFollower): string => JSON.stringify(f.poll());

describe("a live share redacts by the project's rules (#70)", () => {
  it("applies a custom pattern the built-ins cannot know", () => {
    // The bug: a live share re-converts from the native log rather than
    // reading the store, so it redacted with the built-ins alone and never
    // saw .agit/redact.json. import redacted the token; share published it.
    const f = new SessionFollower(log, claudeCodeAdapter, parseRedactionConfig(CONFIG));
    const out = published(f);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[REDACTED:acme-token]");
    expect(f.redactions["acme-token"]).toBe(1);
  });

  it("shows what the built-ins alone would have published", () => {
    // Pinning the old behaviour, so the difference the config makes is visible
    // rather than asserted.
    const f = new SessionFollower(log, claudeCodeAdapter, builtinConfig());
    expect(published(f)).toContain(TOKEN);
    expect(f.redactions).toEqual({});
  });

  it("still applies the built-ins when there is no project config", () => {
    const secret = "sk-ant-" + "b".repeat(24);
    const other = join(store, "builtin.jsonl");
    writeFileSync(
      other,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "builtin-demo-0001",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/w",
        message: { role: "user", content: `key ${secret}` },
      }) + "\n",
      "utf8",
    );
    const f = new SessionFollower(other, claudeCodeAdapter);
    const out = published(f);
    expect(out).not.toContain(secret);
    expect(f.redactions["anthropic-key"]).toBe(1);
  });

  it("honours an allowlist, so a documented example key survives a share", () => {
    const cfg = parseRedactionConfig(
      JSON.stringify({ allow: [TOKEN], patterns: JSON.parse(CONFIG).patterns }),
    );
    const f = new SessionFollower(log, claudeCodeAdapter, cfg);
    expect(published(f)).toContain(TOKEN);
    expect(f.redactions).toEqual({});
  });

  it("import and a live share agree on the same log", () => {
    // The two paths reading the same file and the same config must not
    // disagree about what counts as a credential.
    expect(agit(["import", log, "--dir", store]).code).toBe(0);
    const stored = agit(["export", "redact", "--dir", store]);
    expect(stored.out).not.toContain(TOKEN);
    expect(stored.out).toContain("REDACTED:acme-token");

    const f = new SessionFollower(log, claudeCodeAdapter, parseRedactionConfig(CONFIG));
    expect(published(f)).not.toContain(TOKEN);
  });
});

describe("the unredacted-publish warning", () => {
  it("is printed once, not twice", () => {
    // Two identical gate calls sat on the static share path.
    const s2 = mkdtempSync(join(tmpdir(), "agit-share-warn-"));
    expect(
      agit(["import", join(ROOT, "fixtures", "claude-code", "demo.jsonl"), "--no-redact", "--dir", s2]).code,
    ).toBe(0);
    const r = agit([
      "share",
      "demo",
      "--allow-unredacted",
      "--static",
      "--relay",
      "http://127.0.0.1:1",
      "--dir",
      s2,
    ]);
    const warnings = r.out.split("\n").filter((l) => l.includes("was imported with --no-redact"));
    expect(warnings).toHaveLength(1);
  });
});
