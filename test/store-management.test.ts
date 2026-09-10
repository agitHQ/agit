import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { minimalPrefixes, readNotes, sessionDir } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

let store: string;
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "agit-store-mgmt-"));
  expect(agit(["import", DEMO, "--dir", store]).code).toBe(0);
  expect(agit(["import", CODEX, "--dir", store]).code).toBe(0);
});

describe("minimalPrefixes", () => {
  it("shortens to the point of ambiguity, never below the floor", () => {
    const p = minimalPrefixes(["abcdef", "abcxyz", "zzz9"]);
    expect(p.get("abcdef")).toBe("abcd");
    expect(p.get("abcxyz")).toBe("abcx");
    expect(p.get("zzz9")).toBe("zzz9");
  });

  it("grows the prefix only as far as it must", () => {
    const p = minimalPrefixes(["aaaa1111", "aaaa1112"]);
    expect(p.get("aaaa1111")).toBe("aaaa1111");
    expect(p.get("aaaa1112")).toBe("aaaa1112");
  });
});

describe("tags and notes (#71)", () => {
  it("stores tags in a sidecar, never in the chain", () => {
    expect(agit(["tag", "demo", "shipped", "--dir", store]).code).toBe(0);
    const id = "demo-ratelimit-0001";
    expect(readNotes(store, id).tags).toEqual(["shipped"]);
    // The log is untouched, so the chain still verifies byte for byte.
    expect(agit(["verify", "demo", "--dir", store]).code).toBe(0);
    const log = readFileSync(join(sessionDir(store, id), "events.jsonl"), "utf8");
    expect(log).not.toContain("shipped");
  });

  it("keeps tags a sorted set", () => {
    agit(["tag", "demo", "b", "--dir", store]);
    agit(["tag", "demo", "a", "--dir", store]);
    agit(["tag", "demo", "a", "--dir", store]);
    expect(readNotes(store, "demo-ratelimit-0001").tags).toEqual(["a", "b"]);
  });

  it("removes a tag", () => {
    agit(["tag", "demo", "keep", "--dir", store]);
    agit(["tag", "demo", "drop", "--dir", store]);
    agit(["tag", "demo", "x", "--remove", "drop", "--dir", store]);
    expect(readNotes(store, "demo-ratelimit-0001").tags).toEqual(["keep"]);
  });

  it("saves, prints and clears a note", () => {
    expect(agit(["note", "demo", "rate limiting work", "--dir", store]).code).toBe(0);
    expect(readNotes(store, "demo-ratelimit-0001").note).toBe("rate limiting work");
    expect(agit(["note", "demo", "--dir", store]).out).toContain("rate limiting work");
    agit(["note", "demo", "--clear", "--dir", store]);
    expect(readNotes(store, "demo-ratelimit-0001").note).toBeNull();
  });

  it("shows tags and the note in `show`", () => {
    agit(["tag", "demo", "shipped", "--dir", store]);
    agit(["note", "demo", "worth revisiting", "--dir", store]);
    const out = agit(["show", "demo", "--dir", store]).out;
    expect(out).toContain("tags        shipped");
    expect(out).toContain("note        worth revisiting");
  });

  it("survives a corrupt sidecar rather than taking a read verb down", () => {
    writeFileSync(join(sessionDir(store, "demo-ratelimit-0001"), "notes.json"), "{not json", "utf8");
    expect(readNotes(store, "demo-ratelimit-0001")).toEqual({ tags: [], note: null });
    expect(agit(["show", "demo", "--dir", store]).code).toBe(0);
    expect(agit(["ls", "--dir", store]).code).toBe(0);
  });
});

describe("ls filtering and sorting", () => {
  it("uses the shortest unique id prefix", () => {
    const out = agit(["ls", "--dir", store]).out;
    expect(out).toMatch(/^demo\s/m);
    expect(out).not.toContain("demo-ratelimit-0001");
  });

  it("filters by tag, runtime and project", () => {
    agit(["tag", "demo", "shipped", "--dir", store]);
    expect(agit(["ls", "--tag", "shipped", "--dir", store]).out).not.toContain("codex");
    expect(agit(["ls", "--runtime", "codex", "--dir", store]).out).not.toContain("claude-code");
    // demo.jsonl records cwd C:\app; edits.jsonl records C:\work\app.
    const byProject = agit(["ls", "--project", "app", "--dir", store]).out;
    expect(byProject).toContain("claude-code");
  });

  it("says so when nothing matches, rather than printing an empty table", () => {
    const r = agit(["ls", "--tag", "no-such-tag", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no sessions match those filters");
  });

  it("sorts by events and rejects an unknown key", () => {
    const sorted = agit(["ls", "--sort", "events", "--dir", store]).out.trim().split("\n");
    // demo has 31 events, the codex fixture 23: most first.
    expect(sorted[1]).toMatch(/^demo\s/);
    const bad = agit(["ls", "--sort", "sideways", "--dir", store]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("unknown --sort");
  });

  it("narrows grep to a tag", () => {
    agit(["tag", "demo", "shipped", "--dir", store]);
    const hits = agit(["grep", "ratelimit", "--tag", "shipped", "--dir", store]);
    expect(hits.code).toBe(0);
    const none = agit(["grep", "ratelimit", "--tag", "nope", "--dir", store]);
    expect(none.out).toContain("no sessions tagged");
  });
});

describe("rm and gc", () => {
  it("refuses to delete without confirmation when there is no terminal", () => {
    const r = agit(["rm", "demo", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing without a terminal");
    expect(existsSync(sessionDir(store, "demo-ratelimit-0001"))).toBe(true);
  });

  it("warns that forks lose their merge base before deleting", () => {
    const r = agit(["rm", "demo", "--yes", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("loses its merge base");
    expect(existsSync(sessionDir(store, "demo-ratelimit-0001"))).toBe(false);
    // The other session is untouched.
    expect(agit(["ls", "--dir", store]).out).toContain("codex");
  });

  it("gc deletes only what is older than the cutoff", () => {
    // Both fixtures are dated 2026-09; a 1-minute cutoff catches both.
    const none = agit(["gc", "--older-than", "36500d", "--yes", "--dir", store]);
    expect(none.out).toContain("nothing older than the cutoff");

    const all = agit(["gc", "--older-than", "1m", "--yes", "--dir", store]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("deleted 2 session(s)");
    expect(agit(["ls", "--dir", store]).out).toContain("no sessions imported yet");
  });

  it("gc --keep-tagged spares a tagged session", () => {
    agit(["tag", "demo", "keep", "--dir", store]);
    const r = agit(["gc", "--older-than", "1m", "--keep-tagged", "--yes", "--dir", store]);
    expect(r.code).toBe(0);
    expect(existsSync(sessionDir(store, "demo-ratelimit-0001"))).toBe(true);
    expect(r.out).toContain("deleted 1 session(s)");
  });

  it("gc needs an explicit cutoff", () => {
    const r = agit(["gc", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--older-than");
  });
});
