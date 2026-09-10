import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { blameFile, sessionTrailer, whyLine } from "../src/blame.js";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent } from "../src/format/events.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function load(fixture: string): AgitEvent[] {
  const lines = readFileSync(join(ROOT, "fixtures", "claude-code", fixture), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const converted = claudeCodeAdapter.convert(lines);
  const counts: RedactionCounts = {};
  for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
  return buildChain(converted.sessionId, converted.drafts);
}
const DEMO = load("demo.jsonl");
const SESSIONS = [{ id: "demo-ratelimit-0001", events: DEMO }];
const LOGIN = "C:\\app\\src\\login.ts";
const RATELIMIT = "C:\\app\\src\\ratelimit.ts";

describe("blameFile (#65)", () => {
  it("attributes lines a session created to the event that created them", () => {
    const res = blameFile(SESSIONS, RATELIMIT);
    expect(res.lines.length).toBeGreaterThan(0);
    expect(res.lines[0]!.text).toContain("const LIMIT");
    expect(res.lines[0]!.session).toBe("demo-ratelimit-0001");
    expect(res.lines[0]!.seq).toBe(10);
    expect(res.sessions).toEqual(["demo-ratelimit-0001"]);
  });

  it("recovers a file that predates the session, and attributes nothing to those lines", () => {
    // login.ts was never created in this session; its base is recovered from
    // the runtime-recorded originalFile, hash-checked.
    const res = blameFile(SESSIONS, LOGIN);
    const untouched = res.lines.filter((l) => l.session === null);
    const edited = res.lines.filter((l) => l.session !== null);
    expect(untouched.length).toBeGreaterThan(0);
    expect(edited.length).toBeGreaterThan(0);
    expect(untouched[0]!.text).toContain("import");
    expect(edited[0]!.text).toContain("allow(req.ip)");
    expect(edited[0]!.seq).toBe(15);
  });

  it("stops at a divergence instead of guessing past it", () => {
    // The demo fixture deliberately changes ratelimit.ts outside a structured
    // edit; the later diff then does not fit what the log holds.
    const res = blameFile(SESSIONS, RATELIMIT);
    expect(res.verified).toBe(false);
    expect(res.divergedAtSeq).toBe(24);
    expect(res.divergedIn).toBe("demo-ratelimit-0001");
    // What was verified before the divergence is still attributed.
    expect(res.lines.every((l) => l.session !== null)).toBe(true);
  });

  it("returns nothing for a path no session touched", () => {
    const res = blameFile(SESSIONS, "C:\\app\\never.ts");
    expect(res.lines).toEqual([]);
    expect(res.sessions).toEqual([]);
  });
});

describe("whyLine", () => {
  it("finds the prompt that opened the turn and the assistant text before the edit", () => {
    const res = blameFile(SESSIONS, LOGIN);
    const edited = res.lines.find((l) => l.session !== null)!;
    const why = whyLine(DEMO, edited);
    expect(why.prompt).toContain("rate limiting");
    expect(why.rationale).toBeTruthy();
  });

  it("says nothing rather than guessing for an unattributed line", () => {
    const why = whyLine(DEMO, { line: 1, text: "x", session: null, seq: null, ts: null });
    expect(why.prompt).toBeNull();
    expect(why.rationale).toBeNull();
  });
});

describe("sessionTrailer", () => {
  it("is the documented shape", () => {
    expect(sessionTrailer("s1", 42, "abc")).toBe("Agit-Session: s1@42 abc");
  });
});

describe("the CLI", () => {
  let store: string;
  beforeAll(() => {
    store = mkdtempSync(join(tmpdir(), "agit-blame-"));
    expect(agit(["import", join(ROOT, "fixtures", "claude-code", "demo.jsonl"), "--dir", store]).code).toBe(
      0,
    );
  });

  it("blame resolves a bare filename against the logged absolute path", () => {
    const r = agit(["blame", "login.ts", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("C:\\app\\src\\login.ts");
    expect(r.out).toContain("(no structured edit)");
    expect(r.out).toMatch(/demo-rat @\s+15/);
  });

  it("blame explains where it stopped on a diverged file", () => {
    const r = agit(["blame", "ratelimit.ts", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("blame stops at seq 24");
    expect(r.out).toContain("SPEC §5.7");
  });

  it("blame names an unknown file rather than printing an empty result", () => {
    const r = agit(["blame", "nope.ts", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no structured edit");
  });

  it("why walks a line back to the prompt", () => {
    const r = agit(["why", "login.ts:4", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("written by");
    expect(r.out).toContain("asked for by");
    expect(r.out).toContain("rate limiting");
    // It must hand back the way to check the claim.
    expect(r.out).toContain("agit verify");
  });

  it("why refuses a line outside the file", () => {
    const r = agit(["why", "login.ts:999", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is outside it");
  });

  it("why rejects a target with no line number", () => {
    const r = agit(["why", "login.ts", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("<file>:<line>");
  });

  it("link prints the trailer for the newest session", () => {
    const r = agit(["link", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^Agit-Session: demo-ratelimit-0001@\d+ [0-9a-f]{64}$/);
  });

  it("link takes a file and names the session that last edited it", () => {
    const r = agit(["link", "login.ts", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Agit-Session: demo-ratelimit-0001@");
  });

  it("blame --json carries the structure", () => {
    const r = agit(["blame", "login.ts", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { path: string; lines: { session: string | null }[] };
    expect(doc.path).toBe("C:\\app\\src\\login.ts");
    expect(doc.lines.some((l) => l.session === null)).toBe(true);
  });
});
