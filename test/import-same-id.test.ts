/**
 * A native log whose session id is already in the store.
 *
 * The store's copy is replaced only by a chain that extends it: an earlier
 * copy is superseded, a different history is diverged and left alone
 * (0.16.0). Whether the session was "already stored" used to be read off its
 * meta.json, so the guard never ran for a session stored without one, which
 * is every `agit pull` and any bundle adopted as a bare events.jsonl. A
 * shorter or different log under the same id replaced it and was reported as
 * a fresh import. An adopted meta.json with no `source` got as far as the
 * guard and crashed on it. And the redaction-mode exemption, meant for
 * re-importing the same file with the flag flipped, let any file through as
 * long as the flag differed.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const ID = "fixture-simple-0001";

function agit(args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000, env });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "agit-same-id-"));
}

function storedLog(store: string): string {
  return readFileSync(join(store, ".agit", "sessions", ID, "events.jsonl"), "utf8");
}

/** The first `n` records of the fixture: an earlier copy of the same session. */
function earlierCopy(dir: string, n: number): string {
  const p = join(dir, `first-${n}.jsonl`);
  writeFileSync(p, readFileSync(SIMPLE, "utf8").split("\n").slice(0, n).join("\n") + "\n", "utf8");
  return p;
}

/** The fixture with one late message changed: same id, a history that parts ways. */
function divergedCopy(dir: string): string {
  const p = join(dir, "diverged.jsonl");
  const text = readFileSync(SIMPLE, "utf8");
  const changed = text.replace("module is in place", "module is NOT in place");
  expect(changed).not.toBe(text);
  writeFileSync(p, changed, "utf8");
  return p;
}

/**
 * A store holding the session as adoption leaves it: the agit log an import
 * of `source` produced, and a meta.json only when one is given.
 */
function adoptedStore(source: string, meta?: (m: Record<string, unknown>) => void): string {
  const origin = tmp();
  expect(agit(["import", source, "--dir", origin]).code).toBe(0);
  const bundle = join(origin, "bundle");
  mkdirSync(bundle);
  copyFileSync(join(origin, ".agit", "sessions", ID, "events.jsonl"), join(bundle, "events.jsonl"));
  if (meta) {
    const metaPath = join(origin, ".agit", "sessions", ID, "meta.json");
    const m = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta(m);
    writeFileSync(join(bundle, "meta.json"), JSON.stringify(m), "utf8");
  }
  const store = tmp();
  const r = agit(["import", bundle, "--dir", store]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain(`adopted ${ID}`);
  return store;
}

describe("a session stored without meta.json", () => {
  it("is not shrunk by an earlier copy: superseded, left byte for byte", () => {
    const store = adoptedStore(SIMPLE);
    const before = storedLog(store);
    const r = agit(["import", earlierCopy(store, 4), "--dir", store]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`superseded ${ID}`);
    expect(r.out).toContain("18 events from an adopted log with no recorded source; this file yields 6");
    expect(r.out).toContain("nothing changed");
    expect(storedLog(store)).toBe(before);
  });

  it("is not replaced by a different history: diverged, exit 1, left byte for byte", () => {
    const store = adoptedStore(SIMPLE);
    const before = storedLog(store);
    const r = agit(["import", divergedCopy(store), "--dir", store]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`diverged ${ID}`);
    expect(r.out).toContain("Not overwritten");
    expect(storedLog(store)).toBe(before);
  });

  it("is still updated by a log that extends it, counted from the stored events", () => {
    const origin = tmp();
    const store = adoptedStore(earlierCopy(origin, 4));
    const r = agit(["import", SIMPLE, "--dir", store]);
    expect(r.code, r.out).toBe(0);
    // "updated", not "imported": the id was already here.
    expect(r.out).toContain(`updated ${ID}`);
    expect(r.out).toContain("events      6 → 18");
  });

  it("takes the very log it was adopted from as an update to the same bytes", () => {
    const store = adoptedStore(SIMPLE);
    const before = storedLog(store);
    const r = agit(["import", SIMPLE, "--dir", store]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`updated ${ID}`);
    expect(r.out).toContain("events      18 → 18");
    expect(storedLog(store)).toBe(before);
  });

  it("is named the same way by import --all", () => {
    const store = adoptedStore(SIMPLE);
    const before = storedLog(store);
    const home = tmp();
    const project = join(home, ".claude", "projects", "C--app");
    mkdirSync(project, { recursive: true });
    earlierCopy(project, 4);
    divergedCopy(project);
    // Only the projects directory above is under this home: every other runtime's
    // override points somewhere empty, so nothing on the machine is scanned.
    const none = join(home, "none");
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: none,
      LOCALAPPDATA: none,
      XDG_DATA_HOME: none,
      XDG_CONFIG_HOME: none,
      CLINE_DIR: none,
      PI_CODING_AGENT_DIR: none,
      HERMES_HOME: none,
      KIMI_SHARE_DIR: none,
      OPENCLAW_STATE_DIR: none,
    };
    const r = agit(["import", "--all", "--dir", store], env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(
      /superseded fixture-simple-0001 .*first-4\.jsonl +\(store keeps 18 from an adopted log/,
    );
    expect(r.out).toMatch(/diverged +fixture-simple-0001 .*diverged\.jsonl .*not overwritten/);
    expect(r.out).toContain("0 imported, 0 updated");
    expect(r.out).toContain("1 diverged");
    expect(storedLog(store)).toBe(before);
  });
});

describe("an adopted meta.json with no source", () => {
  it("is compared like any other stored session instead of crashing the guard", () => {
    const store = adoptedStore(SIMPLE, (m) => {
      delete m.source;
    });
    const before = storedLog(store);

    const diverged = agit(["import", divergedCopy(store), "--dir", store]);
    expect(diverged.out).not.toContain("Cannot read properties");
    expect(diverged.code, diverged.out).toBe(1);
    expect(diverged.out).toContain(`diverged ${ID}`);
    expect(diverged.out).toContain("18 events from an adopted log with no recorded source");

    const earlier = agit(["import", earlierCopy(store, 4), "--dir", store]);
    expect(earlier.code, earlier.out).toBe(0);
    expect(earlier.out).toContain(`superseded ${ID}`);
    expect(storedLog(store)).toBe(before);
  });
});

describe("switching redaction on or off rewrites only the same source", () => {
  it("--no-redact does not let a different history through", () => {
    const store = tmp();
    expect(agit(["import", SIMPLE, "--dir", store]).code).toBe(0);
    const before = storedLog(store);
    const r = agit(["import", divergedCopy(store), "--no-redact", "--dir", store]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`diverged ${ID}`);
    expect(r.out).not.toContain("re-imported");
    expect(storedLog(store)).toBe(before);
  });

  it("nor does dropping the flag over a --no-redact copy", () => {
    const store = tmp();
    expect(agit(["import", SIMPLE, "--no-redact", "--dir", store]).code).toBe(0);
    const before = storedLog(store);
    const r = agit(["import", divergedCopy(store), "--dir", store]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`diverged ${ID}`);
    expect(storedLog(store)).toBe(before);
  });

  // The first 10 records already hold a key, so the stored copy and the new
  // import disagree on that event in the two modes. A log that grew is still
  // an update: it is compared as the stored copy's mode would have made it.
  it("a log that grew still undoes an accidental --no-redact, key and all", () => {
    const store = tmp();
    expect(agit(["import", earlierCopy(store, 10), "--no-redact", "--dir", store]).code).toBe(0);
    expect(storedLog(store)).toContain("sk-ant-");
    const r = agit(["import", SIMPLE, "--dir", store]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`updated ${ID}`);
    expect(r.out).toContain("events      16 → 18");
    expect(r.out).toContain("redaction was OFF (--no-redact) for the stored copy; it is now ON");
    expect(storedLog(store)).toContain("[REDACTED:anthropic-key]");
    expect(storedLog(store)).not.toContain("sk-ant-");
  });

  it("and a log that grew can still be switched to --no-redact", () => {
    const store = tmp();
    expect(agit(["import", earlierCopy(store, 10), "--dir", store]).code).toBe(0);
    expect(storedLog(store)).toContain("[REDACTED:anthropic-key]");
    const r = agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`updated ${ID}`);
    expect(r.out).toContain("events      16 → 18");
    expect(r.out).toContain("redaction was ON for the stored copy; it is now OFF");
    expect(storedLog(store)).not.toContain("[REDACTED:");
  });
});
