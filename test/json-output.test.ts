import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `--json` on every read verb (issue #73): `ls`, `show`, `show --by-model`,
 * `verify`, `grep`, `diff` should each emit the structures the code already
 * builds instead of only human-formatted text. Driven through the built CLI
 * (like adopt.test.ts) rather than the internal command functions, so this
 * tests exactly what a script piping `agit ... --json | jq` would see.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");

function agit(args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
}

let store: string;

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-json-"));
  expect(agit(["import", SIMPLE, "--dir", store]).code).toBe(0);
  expect(agit(["import", DEMO, "--dir", store]).code).toBe(0);
});

describe("--json on read verbs", () => {
  it("ls --json: an array of session rows, full ids and numeric fields", () => {
    const r = agit(["ls", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { id: string; readable: boolean; events: number; runtime: string }[];
    expect(rows).toHaveLength(2);
    const simple = rows.find((row) => row.id === "fixture-simple-0001")!;
    expect(simple.readable).toBe(true);
    expect(simple.runtime).toBe("claude-code");
    expect(simple.events).toBe(18);
  });

  it("ls --json: an empty store is an empty array, not an error or human text", () => {
    const empty = mkdtempSync(join(tmpdir(), "agit-json-empty-"));
    const r = agit(["ls", "--json", "--dir", empty]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("show --json: the same summary show already prints, as one document", () => {
    const r = agit(["show", "fixture-simple-0001", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as {
      id: string;
      runtime: string;
      events: number;
      usage: { models: string[]; apiMessages: number };
      files: { path: string; kind: string }[];
    };
    expect(doc.id).toBe("fixture-simple-0001");
    expect(doc.runtime).toBe("claude-code");
    expect(doc.events).toBe(18);
    expect(doc.usage.models).toEqual(["claude-opus-5"]);
    expect(doc.usage.apiMessages).toBeGreaterThan(0);
    expect(doc.files.map((f) => f.path)).toContain("C:\\proj\\hello.ts");
  });

  it("show --by-model --json: ModelUsage[] with files as an array, not a Set", () => {
    const r = agit(["show", "fixture-simple-0001", "--by-model", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { model: string; apiMessages: number; files: string[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("claude-opus-5");
    expect(Array.isArray(rows[0]!.files)).toBe(true);
  });

  it("verify --json: a VerifyResult document, exit 0 on an intact chain", () => {
    const r = agit(["verify", "fixture-simple-0001", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, events: 18, hasMeta: true });
  });

  it("verify --json: still exits 1 and still reports the break, just as JSON", () => {
    const scratch = mkdtempSync(join(tmpdir(), "agit-json-verify-"));
    const bad = join(scratch, "bad.jsonl");
    // A single event whose hash cannot possibly match its own content —
    // enough to break the chain at seq 0 without needing a real hash first.
    const brokenEvent =
      '{"v":2,"seq":0,"ts":"2026-01-01T00:00:00.000Z","session":"s","type":"session.start","payload":{},"prev":null,"hash":"not-a-real-hash"}';
    writeFileSync(bad, brokenEvent + "\n", "utf8");
    const r = agit(["verify", bad, "--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out) as { ok: boolean; firstBroken?: { seq: number; reason: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.firstBroken?.seq).toBe(0);
    expect(parsed.firstBroken?.reason).toMatch(/hash/);
  });

  it("grep --json: one JSON object per hit, NDJSON, matching the rendered line", () => {
    const r = agit(["grep", "hello.ts", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const hitLines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { session: string; seq: number; type: string; line: string });
    expect(hitLines.length).toBeGreaterThan(0);
    for (const hit of hitLines) {
      expect(hit.session).toBe("fixture-simple-0001");
      expect(hit.line).toContain("hello.ts");
    }
  });

  it("grep --json: no matches is empty NDJSON output and exit 1, not human text", () => {
    const r = agit(["grep", "nothing-matches-this-xyz", "--json", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out.trim()).toBe("");
  });

  it("diff --json: a SessionDiff document with per-file verdicts", () => {
    const r = agit(["diff", "fixture-simple-0001", "demo-ratelimit-0001", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as {
      a: { label: string; events: number };
      b: { label: string; events: number };
      files: { path: string; verdict: string }[];
    };
    expect(doc.a.label).toBe("fixture-");
    expect(doc.b.label).toBe("demo-rat");
    expect(doc.files.some((f) => f.path === "hello.ts" && f.verdict === "only-a")).toBe(true);
  });
});

describe("--json carries what the human output states in prose", () => {
  it("show --json distinguishes 'never scanned' from 'scanned, found nothing'", () => {
    // --no-redact (#79) leaves `redactions` empty, so {} alone is ambiguous —
    // and it is exactly the field a script would gate publishing on.
    const skipped = mkdtempSync(join(tmpdir(), "agit-json-skip-"));
    agit(["import", SIMPLE, "--no-redact", "--dir", skipped]);
    const a = JSON.parse(agit(["show", "fixture-simple-0001", "--json", "--dir", skipped]).out) as {
      redactions: Record<string, number>;
      redactionSkipped: boolean;
    };
    expect(a.redactions).toEqual({});
    expect(a.redactionSkipped).toBe(true);

    const scanned = mkdtempSync(join(tmpdir(), "agit-json-scan-"));
    agit(["import", SIMPLE, "--dir", scanned]);
    const b = JSON.parse(agit(["show", "fixture-simple-0001", "--json", "--dir", scanned]).out) as {
      redactionSkipped: boolean;
    };
    expect(b.redactionSkipped).toBe(false);
  });

  it("ls --json says whether the log is readable, and why not when it isn't", () => {
    const store = mkdtempSync(join(tmpdir(), "agit-json-unreadable-"));
    agit(["import", SIMPLE, "--dir", store]);
    writeFileSync(
      join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl"),
      "{not json\n",
      "utf8",
    );
    const rows = JSON.parse(agit(["ls", "--json", "--dir", store]).out) as {
      id: string;
      readable: boolean;
      reason?: string;
    }[];
    expect(rows[0]!.readable).toBe(false);
    // A bare boolean cannot tell an empty log from unparseable JSON from a
    // log written by a newer agit; the reason can.
    expect(rows[0]!.reason).toBeTruthy();
  });

  it("ls --json does not claim the chain is intact — that is agit verify's job", () => {
    const store = mkdtempSync(join(tmpdir(), "agit-json-tampered-"));
    agit(["import", SIMPLE, "--dir", store]);
    const log = join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl");
    writeFileSync(log, readFileSync(log, "utf8").replace("hello", "HELLO"), "utf8");
    // The log still parses, so ls reports it readable. `readable` is named for
    // exactly that, and verify is the verb that speaks to the chain.
    const rows = JSON.parse(agit(["ls", "--json", "--dir", store]).out) as { readable: boolean }[];
    expect(rows[0]!.readable).toBe(true);
    const v = agit(["verify", "fixture-simple-0001", "--json", "--dir", store]);
    expect(v.code).toBe(1);
    expect(JSON.parse(v.out).ok).toBe(false);
  });
});
