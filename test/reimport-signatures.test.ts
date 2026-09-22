/**
 * A re-import that leaves the head where it was keeps the signatures on it.
 *
 * Signatures live in meta.json so that a session "can be signed after import
 * ... without rewriting an event" (SPEC §12). Import rewrote meta.json from
 * scratch whenever the source's bytes changed, and the source's bytes change
 * for reasons the chain never sees: a session log gains a record the adapter
 * skips, a database gains a row for some other session. The chain
 * came out byte-identical, the head did not move, and every signature on it
 * was gone, so `verify` went from "signed by" to "unsigned" with nothing in
 * the log having changed. A head that does move still drops them: they were
 * made over a head that is no longer the one stored.
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { SessionMeta } from "../src/format/events.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const OPENCODE = join(ROOT, "fixtures", "opencode", "opencode.sqlite");
const OPENCODE_LIVE = join(ROOT, "fixtures", "opencode", "opencode-live.sqlite");
const SESSION = "demo-ratelimit-0001";

/** A record the demo log's adapter counts as skipped: the source changes, the chain does not. */
const AI_TITLE = JSON.stringify({ type: "ai-title", aiTitle: "Rate limiter", sessionId: SESSION }) + "\n";

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-resign-"));

function metaOf(dir: string, id = SESSION): SessionMeta {
  return JSON.parse(readFileSync(join(dir, ".agit", "sessions", id, "meta.json"), "utf8")) as SessionMeta;
}

function eventsOf(dir: string, id = SESSION): string {
  return readFileSync(join(dir, ".agit", "sessions", id, "events.jsonl"), "utf8");
}

let alice: string;
let bob: string;
beforeAll(() => {
  const keys = mktemp();
  const key = (name: string): string => {
    const p = join(keys, name);
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    writeFileSync(p, pem as string, "utf8");
    return p;
  };
  alice = key("alice.pem");
  bob = key("bob.pem");
});

/** A store holding a copy of the demo log, imported and signed by both keys. */
function signedDemo(): { dir: string; log: string } {
  const dir = mktemp();
  const log = join(dir, "cc.jsonl");
  copyFileSync(DEMO, log);
  expect(agit(["import", log, "--dir", dir]).code).toBe(0);
  expect(agit(["sign", "demo", "--key", alice, "--dir", dir]).code).toBe(0);
  expect(agit(["sign", "demo", "--key", bob, "--dir", dir]).code).toBe(0);
  expect(metaOf(dir).signatures).toHaveLength(2);
  return { dir, log };
}

describe("re-importing a signed session", () => {
  it("keeps every signature when the source changed but the chain did not", () => {
    const { dir, log } = signedDemo();
    const events = eventsOf(dir);
    const signatures = metaOf(dir).signatures;

    appendFileSync(log, AI_TITLE, "utf8");
    const r = agit(["import", log, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("31 → 31");
    expect(eventsOf(dir)).toBe(events);

    expect(metaOf(dir).signatures).toEqual(signatures);
    const v = agit(["verify", "demo", "--dir", dir]);
    expect(v.out.match(/signed by/g), v.out).toHaveLength(2);
    expect(v.code).toBe(0);

    // meta.json is still rewritten, because it records the source hash the
    // next import is matched on. Skipping the write would have kept the
    // signatures and re-converted the file on every run after.
    expect(agit(["import", log, "--dir", dir]).out).toContain(`unchanged ${SESSION}`);
  });

  it("drops them when the log grew, since they were made over the shorter head", () => {
    const dir = mktemp();
    const log = join(dir, "cc.jsonl");
    const lines = readFileSync(DEMO, "utf8").split("\n");
    writeFileSync(log, lines.slice(0, 10).join("\n") + "\n", "utf8");
    expect(agit(["import", log, "--dir", dir]).code).toBe(0);
    expect(agit(["sign", "demo", "--key", alice, "--dir", dir]).code).toBe(0);
    const head = metaOf(dir).headHash;

    // The session was resumed and the runtime kept writing.
    copyFileSync(DEMO, log);
    const r = agit(["import", log, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`updated ${SESSION}`);
    expect(metaOf(dir).headHash).not.toBe(head);

    expect(metaOf(dir).signatures).toBeUndefined();
    // Unsigned, not a failed signature: carrying them over would make every
    // re-import of a growing log verify as NOT OK.
    const v = agit(["verify", "demo", "--dir", dir]);
    expect(v.out).toContain("unsigned");
    expect(v.out).not.toContain("DOES NOT MATCH");
    expect(v.code).toBe(0);
  });

  it("drops them when --no-redact rewrites the payloads, though the source bytes are the same", () => {
    // The demo log holds two fake keys, so turning redaction off changes what
    // is stored and moves the head. A signature over the redacted log says
    // nothing about the unredacted one.
    const { dir, log } = signedDemo();
    const head = metaOf(dir).headHash;

    const r = agit(["import", log, "--no-redact", "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(metaOf(dir).headHash).not.toBe(head);
    expect(metaOf(dir).signatures).toBeUndefined();
    expect(agit(["verify", "demo", "--dir", dir]).code).toBe(0);
  });

  it("keeps them on the sessions of a database that gained another session", () => {
    // One opencode.db holds every session, so a session added to it changes
    // the bytes every other session in it was imported from.
    // opencode-live.sqlite is opencode.sqlite with a third session in it.
    const dir = mktemp();
    const db = join(dir, "opencode.db");
    copyFileSync(OPENCODE, db);
    const A = "ses_fixtureaaaa0001";
    const B = "ses_fixturebbbb0002";
    expect(agit(["import", db, "--dir", dir]).code).toBe(0);
    expect(agit(["sign", A, "--key", alice, "--dir", dir]).code).toBe(0);
    const signatures = metaOf(dir, A).signatures;
    const events = eventsOf(dir, A);

    // OpenCode starts a new session, ses_fixturecccc0003.
    copyFileSync(OPENCODE_LIVE, db);
    const r = agit(["import", db, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/updated\s+ses_fixtureaaaa0001\s+opencode\s+15 → 15 events/);
    expect(r.out).toMatch(/updated\s+ses_fixturebbbb0002\s+opencode\s+7 → 7 events/);
    expect(r.out).toMatch(/imported\s+ses_fixturecccc0003\s+opencode\s+\d+ events/);
    expect(eventsOf(dir, A)).toBe(events);

    expect(metaOf(dir, A).signatures).toEqual(signatures);
    const v = agit(["verify", A, "--dir", dir]);
    expect(v.out).toContain("signed by");
    expect(v.code).toBe(0);
    // A session nobody signed does not come back with an empty list.
    expect("signatures" in metaOf(dir, B)).toBe(false);
  });

  it("keeps the origin's signature on an adopted bundle, which the recipient could not remake", () => {
    const origin = mktemp();
    expect(agit(["import", DEMO, "--dir", origin]).code).toBe(0);
    expect(agit(["sign", "demo", "--key", alice, "--dir", origin]).code).toBe(0);
    const bundle = join(origin, "bundle");
    expect(agit(["pr", "demo", "--out", bundle, "--dir", origin]).code).toBe(0);

    const dir = mktemp();
    cpSync(bundle, join(dir, "in"), { recursive: true });
    expect(agit(["import", join(dir, "in"), "--dir", dir]).code).toBe(0);
    const signatures = metaOf(dir).signatures;
    expect(signatures).toHaveLength(1);

    // The recipient's own copy of the same session, a skipped record longer.
    const log = join(dir, "cc.jsonl");
    copyFileSync(DEMO, log);
    appendFileSync(log, AI_TITLE, "utf8");
    const r = agit(["import", log, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("31 → 31");

    expect(metaOf(dir).signatures).toEqual(signatures);
    const v = agit(["verify", "demo", "--dir", dir]);
    expect(v.out).toContain("signed by");
    expect(v.code).toBe(0);
  });
});
