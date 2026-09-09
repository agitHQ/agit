import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildChain, eventHash, toJsonl } from "../src/format/hash.js";
import type { DraftEvent } from "../src/format/events.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIXTURE = join(ROOT, "fixtures", "claude-code", "demo.jsonl");

/** Run the built CLI, capturing output and exit code rather than throwing. */
function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

let bundle: string;
let originStore: string;

beforeAll(() => {
  // These tests drive the real CLI, so dist must match src. Building only
  // when dist is MISSING silently tests stale code: edit src, run vitest, and
  // a broken change looks green (or a fixed one looks broken) because the
  // binary under test is the old one. CI hides this by always building first.
  execFileSync("npm", ["run", "build"], { cwd: ROOT, shell: true, stdio: "ignore" });
  const scratch = mkdtempSync(join(tmpdir(), "agit-adopt-"));
  originStore = join(scratch, "origin");
  bundle = join(scratch, "bundle");
  expect(agit(["import", FIXTURE, "--dir", originStore]).code).toBe(0);
  expect(agit(["pr", "demo", "--out", bundle, "--dir", originStore]).code).toBe(0);
});

function freshStore(): string {
  return mkdtempSync(join(tmpdir(), "agit-adopt-store-"));
}

/** A copy of the bundle a test may mutate without disturbing the others. */
function bundleCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "agit-adopt-copy-"));
  writeFileSync(join(dir, "events.jsonl"), readFileSync(join(bundle, "events.jsonl"), "utf8"), "utf8");
  writeFileSync(join(dir, "meta.json"), readFileSync(join(bundle, "meta.json"), "utf8"), "utf8");
  return dir;
}

describe("adopting an agit bundle (agit import <bundle>)", () => {
  it("adopts a pr bundle directory and reports the origin honestly", () => {
    const store = freshStore();
    const r = agit(["import", bundle, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("adopted demo-ratelimit-0001");
    expect(r.out).toContain("chain intact, matches meta.json head");
    // Redaction is the origin's, and the output must not imply otherwise.
    expect(r.out).toContain("applied at the origin; agit did not re-scan");
    expect(existsSync(join(store, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"))).toBe(true);
  });

  it("creates a portable handoff bundle through the pr CLI", () => {
    const store = freshStore();
    const out = join(mkdtempSync(join(tmpdir(), "agit-pr-e2e-")), "bundle");

    const imported = agit(["import", FIXTURE, "--dir", store]);
    expect(imported.code).toBe(0);

    const pr = agit(["pr", "demo", "--out", out, "--dir", store]);

    expect(pr.code).toBe(0);
    expect(pr.out).toContain("handoff bundle for demo-ratelimit-0001 at event 30");
    expect(pr.out).toContain("events.jsonl");
    expect(pr.out).toContain("tree/");
    expect(pr.out).toContain("SEED.md");
    expect(pr.out).toContain("fork.json");

    expect(existsSync(join(out, "events.jsonl"))).toBe(true);
    expect(existsSync(join(out, "meta.json"))).toBe(true);
    expect(existsSync(join(out, "tree"))).toBe(true);
    expect(existsSync(join(out, "SEED.md"))).toBe(true);
    expect(existsSync(join(out, "fork.json"))).toBe(true);

    const verified = agit(["verify", join(out, "events.jsonl")]);
    expect(verified.code).toBe(0);
    expect(verified.out).toContain("chain intact");
  });

  it("stores the log byte for byte, so the origin's hashes still verify", () => {
    const store = freshStore();
    agit(["import", bundle, "--dir", store]);
    const stored = readFileSync(
      join(store, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"),
      "utf8",
    );
    expect(stored).toBe(readFileSync(join(bundle, "events.jsonl"), "utf8"));
    expect(agit(["verify", "demo", "--dir", store]).out).toContain("chain intact");
  });

  it("the adopted session supports the verbs that made the bundle worth sending", () => {
    const store = freshStore();
    agit(["import", bundle, "--dir", store]);
    expect(agit(["replay", "demo", "--at", "24", "--state", "--dir", store]).out).toContain(
      "[DIVERGED at seq 24]",
    );
    const forked = agit(["fork", "demo", "--at", "24", "--out", join(store, "fk"), "--dir", store]);
    expect(forked.out).toContain("verified against its event hash");
  });

  it("accepts a bare events.jsonl too, and says truncation is uncheckable without meta", () => {
    const dir = bundleCopy();
    rmSync(join(dir, "meta.json"));
    const store = freshStore();
    const r = agit(["import", join(dir, "events.jsonl"), "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("truncation is not checkable");
    // No meta.json is invented for it.
    expect(existsSync(join(store, ".agit", "sessions", "demo-ratelimit-0001", "meta.json"))).toBe(false);
  });

  it("re-adopting the same bundle is a no-op, not a rewrite", () => {
    const store = freshStore();
    agit(["import", bundle, "--dir", store]);
    const before = readFileSync(
      join(store, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"),
      "utf8",
    );
    const again = agit(["import", bundle, "--dir", store]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already adopted");
    expect(
      readFileSync(join(store, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"), "utf8"),
    ).toBe(before);
  });

  it("never overwrites a different session that already holds the id", () => {
    const store = freshStore();
    agit(["import", bundle, "--dir", store]);
    // A bundle claiming the same id but carrying a different log.
    const dir = bundleCopy();
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trimEnd().split("\n");
    writeFileSync(join(dir, "events.jsonl"), lines.slice(0, 10).join("\n") + "\n", "utf8");
    rmSync(join(dir, "meta.json")); // meta would flag the truncation first
    const r = agit(["import", dir, "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("already exists here with different content");
  });

  it("refuses a tampered log", () => {
    const dir = bundleCopy();
    const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    writeFileSync(join(dir, "events.jsonl"), raw.replace("rate limiting", "RATE LIMITING"), "utf8");
    const r = agit(["import", dir, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to adopt");
    expect(r.out).toMatch(/hash does not recompute/);
  });

  it("refuses a truncated log when meta.json proves the truncation", () => {
    const dir = bundleCopy();
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trimEnd().split("\n");
    writeFileSync(join(dir, "events.jsonl"), lines.slice(0, -1).join("\n") + "\n", "utf8");
    const r = agit(["import", dir, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to adopt");
    expect(r.out).toMatch(/truncated or extended/);
  });

  it("refuses a log with a blank line inside it, rather than quietly normalizing it", () => {
    // Filtering blanks before verification would hide this break AND rewrite
    // a log this path promises to store byte for byte.
    const dir = bundleCopy();
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trimEnd().split("\n");
    lines.splice(5, 0, "");
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n", "utf8");
    rmSync(join(dir, "meta.json"));
    const r = agit(["import", dir, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/blank line inside log/);
  });

  it("refuses a malformed event line", () => {
    const dir = bundleCopy();
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trimEnd().split("\n");
    lines[3] = "{not json";
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n", "utf8");
    rmSync(join(dir, "meta.json"));
    const r = agit(["import", dir, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not valid JSON/);
  });

  it("refuses a log whose session id would escape the store", () => {
    const dir = bundleCopy();
    const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    // Rewriting the id breaks the hashes, so this exercises the chain check
    // first; the id guard behind it is covered directly in store.test.ts.
    writeFileSync(join(dir, "events.jsonl"), raw.split("demo-ratelimit-0001").join("../../pwned"), "utf8");
    rmSync(join(dir, "meta.json"));
    const r = agit(["import", dir, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(existsSync(join(tmpdir(), "pwned"))).toBe(false);
  });

  it("refuses a meta.json that disagrees with the log about which session it is", () => {
    const dir = bundleCopy();
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    meta.sessionId = "some-other-session";
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf8");
    const r = agit(["import", dir, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/meta\.json says session/);
  });

  it("refuses a hash-valid log containing mixed session ids", () => {
    const drafts: DraftEvent[] = [
      { ts: "2026-01-01T00:00:00.000Z", type: "session.start", payload: { runtime: "test" } },
      { ts: "2026-01-01T00:00:01.000Z", type: "message.user", payload: { text: "hello" } },
      { ts: "2026-01-01T00:00:02.000Z", type: "session.end", payload: { reason: "test" } },
    ];

    const events = buildChain("session-a", drafts);

    // Change a later event's session and recompute its hash. Since this
    // changes the hash, also rebuild the following prev/hash link.
    events[1]!.session = "session-b";
    events[1]!.hash = eventHash(events[1]!);
    events[2]!.prev = events[1]!.hash;
    events[2]!.hash = eventHash(events[2]!);

    const dir = mkdtempSync(join(tmpdir(), "agit-adopt-mixed-session-"));
    const eventsPath = join(dir, "events.jsonl");
    writeFileSync(eventsPath, toJsonl(events), "utf8");

    const r = agit(["import", eventsPath, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("mixed session ids");
  });

  it("re-adopting a bundle without a final newline is a no-op", () => {
    const dir = bundleCopy();
    const eventsPath = join(dir, "events.jsonl");

    const raw = readFileSync(eventsPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);

    const withoutFinalNewline = raw.slice(0, -1);
    writeFileSync(eventsPath, withoutFinalNewline, "utf8");

    const store = freshStore();

    const first = agit(["import", dir, "--dir", store]);
    expect(first.code).toBe(0);

    const storedPath = join(store, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl");

    expect(readFileSync(storedPath, "utf8")).toBe(withoutFinalNewline);

    const second = agit(["import", dir, "--dir", store]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("already adopted");

    expect(readFileSync(storedPath, "utf8")).toBe(withoutFinalNewline);
  });

  it("a directory without events.jsonl is reported, not guessed at", () => {
    const empty = mkdtempSync(join(tmpdir(), "agit-adopt-empty-"));
    const r = agit(["import", empty, "--dir", freshStore()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no events.jsonl");
  });

  it("still imports native logs — detection does not shadow the adapters", () => {
    const store = freshStore();
    const r = agit(["import", FIXTURE, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("adapter     claude-code");
    const codex = agit(["import", join(ROOT, "fixtures", "codex", "edits.jsonl"), "--dir", store]);
    expect(codex.out).toContain("adapter     codex");
  });

  it("adoption is deterministic: two stores from one bundle are byte-identical", () => {
    const a = freshStore();
    const b = freshStore();
    agit(["import", bundle, "--dir", a]);
    agit(["import", bundle, "--dir", b]);
    const read = (s: string): string =>
      readFileSync(join(s, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"), "utf8");
    expect(read(a)).toBe(read(b));
  });
});
