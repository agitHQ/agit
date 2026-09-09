import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

function agit(args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
    return { code: 0, out, err: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

/** The shapes these verbs promise; asserting against them keeps the contract honest. */
interface ShowDoc {
  session: string;
  runtime: { name: string | null; version: string | null; cwd: string | null };
  events: { total: number; byType: Record<string, number> };
  usage: { models: string[]; inputTokens: number };
  files: { path: string; kind: string }[];
  byModel?: { model: string; files: string[] }[];
  filesAttribution?: string;
}

interface VerifyDoc {
  ok: boolean;
  events: number;
  metaChecked: boolean;
  firstBroken: { seq: number; reason: string } | null;
}

interface DiffDoc {
  a: { label: string; events: number };
  b: { label: string };
  files: unknown[];
}

let store: string;

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-json-"));
  const r = agit(["import", join(ROOT, "fixtures", "claude-code", "demo.jsonl"), "--dir", store]);
  expect(r.code).toBe(0);
});

describe("--json on the read verbs", () => {
  it("ls emits one document with full ids and machine durations", () => {
    const r = agit(["ls", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { sessions: Record<string, unknown>[] };
    expect(doc.sessions).toHaveLength(1);
    const s = doc.sessions[0]!;
    // Full id, not the eight-character display prefix a script would have to undo.
    expect(s.id).toBe("demo-ratelimit-0001");
    expect(s.readable).toBe(true);
    expect(typeof s.durationMs).toBe("number");
    expect(s.runtime).toBe("claude-code");
  });

  it("ls on an empty store is still a document, not prose", () => {
    const empty = mkdtempSync(join(tmpdir(), "agit-json-empty-"));
    const r = agit(["ls", "--json", "--dir", empty]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ sessions: [] });
  });

  it("show carries the numbers the table shows", () => {
    const r = agit(["show", "demo", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as ShowDoc;
    expect(doc.session).toBe("demo-ratelimit-0001");
    expect(doc.runtime.name).toBe("claude-code");
    expect(doc.events.total).toBeGreaterThan(0);
    expect(doc.events.byType["file.diff"]).toBeGreaterThan(0);
    // usageTotals holds `models` as a Set, which JSON.stringify renders as {}.
    // It has to reach the caller as an array.
    expect(Array.isArray(doc.usage.models)).toBe(true);
    expect(doc.usage.models).toContain("claude-opus-5");
    expect(Array.isArray(doc.files)).toBe(true);
    expect(doc.files[0]!.path).toBeTruthy();
  });

  it("show --by-model splits usage and states its attribution rule", () => {
    const r = agit(["show", "demo", "--by-model", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as ShowDoc;
    expect(Array.isArray(doc.byModel)).toBe(true);
    // ModelUsage.files is a Set too.
    expect(Array.isArray(doc.byModel![0]!.files)).toBe(true);
    expect(doc.filesAttribution).toMatch(/nearest preceding event/);
  });

  it("verify reports an intact chain and keeps exit code 0", () => {
    const r = agit(["verify", "demo", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, metaChecked: true, firstBroken: null });
  });

  it("verify reports a broken chain on stdout and still exits 1", () => {
    const broken = mkdtempSync(join(tmpdir(), "agit-json-broken-"));
    const log = join(broken, "events.jsonl");
    const good = readFileSync(
      join(store, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"),
      "utf8",
    ).split("\n");
    good[2] = good[2]!.replace(/"ts":"[^"]+"/, '"ts":"2000-01-01T00:00:00.000Z"');
    writeFileSync(log, good.join("\n"), "utf8");

    const r = agit(["verify", log, "--json"]);
    expect(r.code).toBe(1); // exit codes unchanged by --json
    const doc = JSON.parse(r.out) as VerifyDoc;
    expect(doc.ok).toBe(false);
    expect(doc.firstBroken!.seq).toBe(2);
    expect(typeof doc.firstBroken!.reason).toBe("string");
  });

  it("grep emits one object per line, so hits can be streamed", () => {
    const r = agit(["grep", "ratelimit", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const hit = JSON.parse(line) as Record<string, unknown>;
      expect(hit.session).toBe("demo-ratelimit-0001");
      expect(typeof hit.seq).toBe("number");
      expect(typeof hit.line).toBe("string");
    }
  });

  it("grep with no matches still exits 1 and writes nothing to stdout", () => {
    const r = agit(["grep", "zzz-no-such-string-zzz", "--json", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out.trim()).toBe("");
  });

  it("diff emits the SessionDiff document", () => {
    const second = agit(["import", join(ROOT, "fixtures", "claude-code", "simple.jsonl"), "--dir", store]);
    expect(second.code).toBe(0);
    const r = agit(["diff", "demo", "fixture-simple", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as DiffDoc;
    expect(doc.a.label).toBeTruthy();
    expect(doc.b.label).toBeTruthy();
    expect(Array.isArray(doc.files)).toBe(true);
    expect(typeof doc.a.events).toBe("number");
  });

  it("leaves the human output alone when --json is absent", () => {
    const r = agit(["ls", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RUNTIME");
    expect(() => JSON.parse(r.out)).toThrow();
  });
});
