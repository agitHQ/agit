import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIX = (runtime: string, file: string): string => join(ROOT, "fixtures", runtime, file);

/** Run the built CLI with HOME pointed at a directory we control. */
function agit(args: string[], home: string): { code: number; out: string } {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      env,
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function place(home: string, rel: string, from: string): string {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  copyFileSync(from, p);
  // copyFileSync keeps the fixture's mtime; the tests reason about recency, so reset it.
  const now = Date.now() / 1000;
  utimesSync(p, now, now);
  return p;
}

function backdate(p: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(p, t, t);
}

/** A home directory laid out the way the three runtimes lay theirs out. */
function populatedHome(): { home: string; claude: string; codex: string; claw: string; store: string } {
  const home = mkdtempSync(join(tmpdir(), "agit-home-"));
  const claude = place(
    home,
    join(".claude", "projects", "C--app", "demo.jsonl"),
    FIX("claude-code", "demo.jsonl"),
  );
  const codex = place(
    home,
    join(".codex", "sessions", "2026", "09", "08", "rollout-2026-09-08T10-00-00-abc.jsonl"),
    FIX("codex", "edits.jsonl"),
  );
  const claw = place(
    home,
    join(".openclaw", "agents", "main", "sessions", "simple.jsonl"),
    FIX("openclaw", "simple.jsonl"),
  );
  // Something a runtime directory might hold that no adapter should claim.
  writeFileSync(
    join(home, ".claude", "projects", "C--app", "scratch.jsonl"),
    '{"type":"unrelated"}\n',
    "utf8",
  );
  const store = mkdtempSync(join(tmpdir(), "agit-store-"));
  return { home, claude, codex, claw, store };
}

const ids = (store: string, home: string): string => agit(["ls", "--dir", store], home).out;

describe("agit import --all", () => {
  it("imports every discovered log across runtimes and skips what no adapter recognizes", () => {
    const { home, store } = populatedHome();
    const r = agit(["import", "--all", "--dir", store], home);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/claude-code +.*\(2 logs\)/);
    expect(r.out).toMatch(/codex +.*\(1 log\)/);
    expect(r.out).toMatch(/openclaw +.*\(1 log\)/);
    expect(r.out).toContain("3 imported, 0 updated, 0 unchanged, 1 skipped, 0 failed");
    expect(r.out).toContain("no adapter recognizes this file");
    const listed = ids(store, home);
    for (const runtime of ["claude-code", "codex", "openclaw"]) expect(listed).toContain(runtime);
  });

  it("a second run finds everything unchanged and rewrites nothing", () => {
    const { home, store } = populatedHome();
    agit(["import", "--all", "--dir", store], home);
    const metaPath = join(store, ".agit", "sessions", "demo-ratelimit-0001", "meta.json");
    const before = readFileSync(metaPath, "utf8");
    const again = agit(["import", "--all", "--dir", store], home);
    expect(again.code).toBe(0);
    expect(again.out).toContain("0 imported, 0 updated, 3 unchanged, 1 skipped, 0 failed");
    expect(readFileSync(metaPath, "utf8")).toBe(before);
  });

  it("a log that grew since the last import is reported as updated, old count to new", () => {
    const { home, store, claude } = populatedHome();
    const full = readFileSync(FIX("claude-code", "demo.jsonl"), "utf8");
    const head = full.split("\n").slice(0, 8).join("\n") + "\n";
    writeFileSync(claude, head, "utf8");
    const first = agit(["import", "--all", "--dir", store], home);
    expect(first.out).toContain("3 imported");

    writeFileSync(claude, full, "utf8");
    const second = agit(["import", "--all", "--dir", store], home);
    expect(second.code).toBe(0);
    expect(second.out).toContain("0 imported, 1 updated, 2 unchanged");
    expect(second.out).toMatch(/updated +demo-ratelimit-0001 +claude-code +\d+ → 31 events/);
  });

  it("--since leaves logs older than the window alone", () => {
    const { home, store, codex } = populatedHome();
    backdate(codex, 3 * 86_400_000);
    const r = agit(["import", "--all", "--since", "1d", "--dir", store], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 imported");
    expect(ids(store, home)).not.toContain("codex");
  });

  it("--latest imports only the most recently written log, with the full report", () => {
    const { home, store, claude, codex, claw } = populatedHome();
    backdate(claude, 120_000);
    backdate(codex, 60_000);
    backdate(claw, 5_000); // the unrecognized scratch file stays newest, and must be skipped
    const r = agit(["import", "--latest", "--dir", store], home);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`latest: ${claw}`);
    expect(r.out).toContain("imported 0199openclaw-aaaa-7bbb-8ccc-ddddeeee0001");
    expect(r.out).toContain("adapter     openclaw");
    const listed = ids(store, home);
    expect(listed).toContain("openclaw");
    expect(listed).not.toContain("claude-code");
  });

  it("says where it looked when nothing is found", () => {
    const home = mkdtempSync(join(tmpdir(), "agit-home-empty-"));
    const store = mkdtempSync(join(tmpdir(), "agit-store-"));
    const r = agit(["import", "--all", "--dir", store], home);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no session logs found");
    expect(r.out).toMatch(/claude-code +.*\(not found\)/);
    expect(r.out).toMatch(/\.codex.*sessions.*\(not found\)/);
    expect(r.out).toMatch(/\.openclaw.*agents.*\(not found\)/);
  });

  it("rejects a --since it cannot read", () => {
    const { home, store } = populatedHome();
    const r = agit(["import", "--all", "--since", "soon", "--dir", store], home);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--since takes a duration like 7d, 24h or 30m");
  });

  it("plain import of an already stored file says unchanged instead of silently re-importing", () => {
    const { home, store, claude } = populatedHome();
    expect(agit(["import", claude, "--dir", store], home).out).toContain("imported demo-ratelimit-0001");
    const again = agit(["import", claude, "--dir", store], home);
    expect(again.code).toBe(0);
    expect(again.out).toContain("unchanged demo-ratelimit-0001");
  });

  it("names a missing file instead of printing a raw ENOENT", () => {
    const { home, store } = populatedHome();
    const r = agit(["import", join(home, "nope.jsonl"), "--dir", store], home);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no such file:");
    expect(r.out).not.toContain("ENOENT");
  });
});
