/**
 * A database shared live: the follower reads it as SQLite would (WAL folded
 * in), streams the session named by --thread as its rows land, holds back
 * what only the session's end can settle, and ends byte-identical to an
 * import.
 */
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { type RedactionCounts, redactDeep } from "../src/redact.js";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";
import { SessionFollower } from "../src/share.js";
import { readSqliteWithWal } from "../src/sqlite.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const MAIN = join(ROOT, "fixtures", "hermes", "state.db");
const LIVE = join(ROOT, "fixtures", "hermes", "live", "state.db");
const SID3 = "d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9";
const SID1 = "a3f9c2e1b7d04c5e8f6a1b2c3d4e5f60";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-live-db-"));
const relays: RelayHandle[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) await r.close();
});

function agitAsync(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const code = (err as { code?: number } | null)?.code;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin!.end("");
  });
}

describe("a database followed live", () => {
  it("streams the session as its WAL grows, holds totals and the end back, and matches an import", () => {
    const dir = mktemp();
    const db = join(dir, "state.db");
    // Before the session exists: the checkpointed main file alone.
    copyFileSync(MAIN, db);
    const follower = new SessionFollower(db, hermesAdapter, undefined, SID3);
    expect(follower.poll()).toEqual([]); // nothing to convert yet: the session is not in the file

    // The writer commits the session's rows to the WAL (the fixture pair, copied while it was open).
    copyFileSync(LIVE, db);
    copyFileSync(`${LIVE}-wal`, `${db}-wal`);
    const first = follower.poll();
    expect(first.map((e) => e.type)).toEqual([
      "session.start",
      "message.user",
      "tool.call",
      "tool.result",
      "file.diff",
      "message.assistant",
    ]);
    expect(first[0]!.session).toBe(SID3);
    // Nothing settles while the session runs: an idle poll streams nothing.
    expect(follower.poll()).toEqual([]);
    const tail = follower.finish();
    expect(tail.map((e) => e.type)).toEqual(["cost", "session.end"]);

    // Byte-identical to an import of the same pair.
    const full = hermesAdapter.convertBytes!(readSqliteWithWal(db).bytes, { select: SID3 });
    const counts: RedactionCounts = {};
    for (const d of full.drafts) d.payload = redactDeep(d.payload, counts);
    expect(toJsonl([...first, ...tail])).toBe(toJsonl(buildChain(full.sessionId, full.drafts)));
  });

  it("treats a checkpoint as no change, and a database the session left as nothing new", () => {
    const dir = mktemp();
    const db = join(dir, "state.db");
    copyFileSync(LIVE, db);
    copyFileSync(`${LIVE}-wal`, `${db}-wal`);
    const follower = new SessionFollower(db, hermesAdapter, undefined, SID1);
    expect(follower.poll().length).toBeGreaterThan(5);
    // The same database without its sidecar: the session's rows are the same
    // — nothing streamed changes — so this is not a rewrite.
    rmSync(`${db}-wal`);
    writeFileSync(db, readFileSync(MAIN));
    expect(follower.poll()).toEqual([]);
    // A database that no longer holds the session converts to nothing: no
    // events, and no claim of a rewrite either — the same as a log emptied
    // of its records. A rewrite of a streamed row is caught by the prefix
    // digest exactly as for a log (live.test.ts).
    writeFileSync(db, readFileSync(join(ROOT, "fixtures", "opencode", "opencode.sqlite")));
    expect(follower.poll()).toEqual([]);
  });

  it("is shared from the CLI with --thread, and refused without one when the file holds several", async () => {
    const relay = await startRelay({ port: 0 });
    relays.push(relay);
    const base = `http://127.0.0.1:${relay.port}`;
    const dir = mktemp();
    const db = join(dir, "state.db");
    copyFileSync(LIVE, db);
    copyFileSync(`${LIVE}-wal`, `${db}-wal`);
    const many = await agitAsync(["share", db, "--static", "--detach", "--relay", base, "--dir", dir]);
    expect(many.code).toBe(2);
    expect(many.stderr).toContain("3 sessions");
    expect(many.stderr).toContain("--thread");
    const one = await agitAsync([
      "share",
      db,
      "--thread",
      SID3,
      "--static",
      "--detach",
      "--relay",
      base,
      "--dir",
      dir,
    ]);
    expect(one.code, one.stdout + one.stderr).toBe(0);
    const link = /http:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(one.stdout)?.[0];
    expect(link).toBeTruthy();
    const shareId = link!.split("/s/")[1]!;
    const res = await fetch(`${base}/api/shares/${shareId}/events.jsonl`);
    expect(res.ok).toBe(true);
    const events = (await res.text())
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type: string; session: string });
    expect(events.length).toBeGreaterThan(5);
    expect(events[0]).toMatchObject({ type: "session.start", session: SID3 });
    expect(events.at(-1)!.type).toBe("session.end");
  });
});
