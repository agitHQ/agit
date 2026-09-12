import fs from "node:fs";
import { appendFileSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { canonicalJson } from "../src/format/canonical.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { verifyChain } from "../src/format/verify.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";
import { MTIME_SETTLE_MS, SessionFollower, StabilityError } from "../src/share.js";
import type { DraftEvent } from "../src/format/events.js";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "fixtures",
  "claude-code",
  "simple.jsonl",
);
const lines = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

function liveDrafts(upto: number): DraftEvent[] {
  try {
    return claudeCodeAdapter.convert(lines.slice(0, upto), { live: true }).drafts;
  } catch {
    return []; // no conversation records yet
  }
}

/** What `agit import` stores for these lines: convert, redact, chain. */
function importOf(native: string[]): string {
  const full = claudeCodeAdapter.convert(native);
  const counts: RedactionCounts = {};
  for (const d of full.drafts) d.payload = redactDeep(d.payload, counts);
  return toJsonl(buildChain(full.sessionId, full.drafts));
}

/** The first six records with the user's request altered, same byte length. */
const tampered = lines
  .slice(0, 6)
  .map((l, i) => (i === 1 ? l.replace("greeting module", "greetinj module") : l));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("live conversion (PROTOCOL.md prefix stability)", () => {
  it("every longer read strictly extends every shorter read", () => {
    let prev: string[] = [];
    for (let k = 1; k <= lines.length; k++) {
      const now = liveDrafts(k).map((d) => canonicalJson(d));
      expect(now.length).toBeGreaterThanOrEqual(prev.length);
      expect(now.slice(0, prev.length)).toEqual(prev);
      prev = now;
    }
  });

  it("normal mode = live mode + exactly the EOF tail (cost flush, session.end)", () => {
    const live = claudeCodeAdapter.convert(lines, { live: true }).drafts;
    const full = claudeCodeAdapter.convert(lines).drafts;
    expect(full.length).toBe(live.length + 2); // pending msg_D cost + session.end
    expect(full.slice(0, live.length).map((d) => canonicalJson(d))).toEqual(
      live.map((d) => canonicalJson(d)),
    );
    expect(full[full.length - 2]!.type).toBe("cost");
    expect(full[full.length - 1]!.type).toBe("session.end");
  });
});

describe("SessionFollower", () => {
  it("follows a growing file and, once finished, matches a full import byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.slice(0, 3).join("\n") + "\n", "utf8");

    const follower = new SessionFollower(path, claudeCodeAdapter);
    const chunks = [follower.poll()];
    appendFileSync(path, lines.slice(3, 8).join("\n") + "\n", "utf8");
    chunks.push(follower.poll());
    chunks.push(follower.poll()); // no growth: must be empty
    expect(chunks[2]).toEqual([]);
    appendFileSync(path, lines.slice(8).join("\n") + "\n", "utf8");
    chunks.push(follower.poll());
    chunks.push(follower.finish());

    const streamed = chunks.flat();
    // seq contiguous from 0, chain verifies
    expect(streamed.map((e) => e.seq)).toEqual(streamed.map((_, i) => i));
    expect(verifyChain(streamed.map((e) => JSON.stringify(e))).ok).toBe(true);

    // byte-identical to a one-shot import of the same file
    expect(toJsonl(streamed)).toBe(importOf(lines));
  });

  it("strips a UTF-8 BOM, so a live share of a re-saved log is still its import", () => {
    // Every other native-log read site strips the BOM an editor re-save
    // leaves at the head of the file. The follower did not, so the BOM
    // glued itself to the first record, the adapter skipped that record as
    // unparseable, and the chain a share published was not the chain
    // `agit show` and `agit verify` describe. The fixture's first record is
    // a queue-operation line the adapter skips anyway, which hid this;
    // dropping it puts the first user turn where the BOM lands.
    const body = lines.slice(1);
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, "\uFEFF" + body.join("\n") + "\n", "utf8");

    const follower = new SessionFollower(path, claudeCodeAdapter);
    const streamed = [...follower.poll(), ...follower.finish()];
    expect(streamed.find((e) => e.type === "message.user")?.payload.text).toBe(
      "Add a greeting module and print it",
    );
    expect(toJsonl(streamed)).toBe(importOf(body));
  });

  it("a fresh follower regenerates the identical chain — the crash-resume invariant", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.join("\n") + "\n", "utf8");

    const first = new SessionFollower(path, claudeCodeAdapter).poll();
    const second = new SessionFollower(path, claudeCodeAdapter).poll();
    // Deterministic conversion means a restarted CLI derives byte-identical
    // events, so any relay head hash it must align with will match.
    expect(toJsonl(second)).toBe(toJsonl(first));
    expect(second[6]!.hash).toBe(first[6]!.hash);
  });

  it("the idle fast path does not weaken rewrite detection (same-size mutation)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.slice(0, 6).join("\n") + "\n", "utf8");

    const follower = new SessionFollower(path, claudeCodeAdapter);
    expect(follower.poll().length).toBeGreaterThan(0);
    expect(follower.poll()).toEqual([]); // idle tick: stat-gated, nothing new

    // Same-length in-place mutation: size identical, only mtime moves. The
    // stat gate must treat that as change and the digest must catch it.
    const mutated = lines
      .slice(0, 6)
      .map((l, i) => (i === 1 ? l.replace("greeting module", "greetinj module") : l));
    expect(mutated.join("\n").length).toBe(lines.slice(0, 6).join("\n").length);
    writeFileSync(path, mutated.join("\n") + "\n", "utf8");
    expect(() => follower.poll()).toThrow(StabilityError);
  });

  it("catches a same-size rewrite even when mtime is byte-identical", () => {
    // The failure this guards against, reproduced without depending on the
    // filesystem's resolution: force mtime to exactly what it was, which is
    // what a coarse-granularity filesystem does for free when two writes
    // land inside one tick. CI on Windows hit this for real.
    //
    // Both mtimes are set through utimesSync from the same Date, and the
    // test asserts they came back identical. Restoring `before.mtime` did
    // not do that: the Date carries milliseconds while the stat carries the
    // filesystem's sub-millisecond part, so the "restored" mtime differed,
    // the gate saw a change, and the test passed with the gate deleted.
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.slice(0, 6).join("\n") + "\n", "utf8");
    const tick = new Date();
    utimesSync(path, tick, tick);
    const before = statSync(path);

    const follower = new SessionFollower(path, claudeCodeAdapter);
    expect(follower.poll().length).toBeGreaterThan(0);

    writeFileSync(path, tampered.join("\n") + "\n", "utf8");
    utimesSync(path, tick, tick);
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // Size and mtime identical: the digest still has to run, or history
    // could be rewritten unnoticed.
    expect(() => follower.poll()).toThrow(StabilityError);
  });

  it("catches a rewrite inside the tick it first read in, however late the next poll", async () => {
    // The settle window alone was not enough. A poll inside the tick read
    // the file and remembered (size, mtime); a same-size rewrite later in
    // the same tick moved neither; and the first poll after the window
    // found the file settled and matching, so it never read the rewrite.
    // The poll gap is unbounded (a slow push skips ticks), so this is not a
    // race the cadence closes. A stat is remembered only once it is settled.
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.slice(0, 6).join("\n") + "\n", "utf8");
    // The tick started most of a window ago, as a coarse filesystem records
    // a write that landed late in it. A second of slack keeps the first poll
    // inside the window on a loaded CI machine.
    const tick = new Date(Date.now() - (MTIME_SETTLE_MS - 1000));
    utimesSync(path, tick, tick);

    const follower = new SessionFollower(path, claudeCodeAdapter);
    expect(follower.poll().length).toBeGreaterThan(0);
    expect(Date.now() - tick.getTime()).toBeLessThan(MTIME_SETTLE_MS); // read inside the window

    writeFileSync(path, tampered.join("\n") + "\n", "utf8");
    utimesSync(path, tick, tick);
    // ext4 keeps nanoseconds and Node reports them as a float, so the value
    // read back can sit a microsecond under the one written; what matters
    // is that both polls see the same one, which the same utimes guarantees.
    expect(statSync(path).mtimeMs).toBeCloseTo(tick.getTime(), 2);

    while (Date.now() - tick.getTime() <= MTIME_SETTLE_MS) await sleep(50);
    expect(() => follower.poll()).toThrow(StabilityError);
  });

  it("a read that fails does not count as having seen the file", () => {
    // The stat was remembered before the read. A read that then failed (a
    // scanner holding the file on Windows, a stale NFS handle) was swallowed
    // by the share loop as a retry, but the follower already believed it
    // had processed that (size, mtime): once settled, every later poll took
    // the fast path and the appended tail stayed unread until the runtime
    // wrote again or the share ended.
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.slice(0, 3).join("\n") + "\n", "utf8");

    const follower = new SessionFollower(path, claudeCodeAdapter);
    const first = follower.poll();
    expect(first.length).toBe(3);

    appendFileSync(path, lines.slice(3).join("\n") + "\n", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old); // the append has settled by the next poll

    const real = fs.readFileSync;
    let failOnce = true;
    fs.readFileSync = ((...args: Parameters<typeof real>) => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return real(...args);
    }) as typeof real;
    syncBuiltinESMExports();
    try {
      expect(() => follower.poll()).toThrow(/EBUSY/);
    } finally {
      fs.readFileSync = real;
      syncBuiltinESMExports();
    }

    // Nothing has changed on disk since the failed read, and the file is
    // settled: the only way these events arrive is if that read did not
    // count.
    const recovered = follower.poll();
    expect(recovered.length).toBeGreaterThan(0);
    expect(toJsonl([...first, ...recovered, ...follower.finish()])).toBe(importOf(lines));
  });

  it("still skips the read on a file nothing has touched recently", () => {
    // The optimization the gate exists for (#4) has to survive the fix: a
    // long quiet session costs one stat() per tick, not a re-read.
    //
    // Proven by putting content on disk that WOULD throw if it were read. A
    // poll that returns nothing did not read it.
    //
    // This is also the honest boundary of the fix above: an mtime deliberately
    // set back to an old value still takes the fast path. That is not a hole
    // worth closing, because anyone who can rewrite the file AND backdate its
    // mtime already controls the log the follower is reading. What the fix
    // addresses is the accidental case — a filesystem whose resolution is too
    // coarse to notice two writes — which needs no attacker at all.
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.slice(0, 6).join("\n") + "\n", "utf8");

    const follower = new SessionFollower(path, claudeCodeAdapter);
    expect(follower.poll().length).toBeGreaterThan(0);

    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(follower.poll()).toEqual([]); // records the aged size and mtime

    const rewritten = lines
      .slice(0, 6)
      .map((l, i) => (i === 1 ? l.replace("greeting module", "greetinj module") : l));
    writeFileSync(path, rewritten.join("\n") + "\n", "utf8");
    utimesSync(path, old, old);

    expect(follower.poll()).toEqual([]);
  });

  it("stops loudly if streamed history stops being a prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-live-"));
    const path = join(dir, "native.jsonl");
    writeFileSync(path, lines.slice(0, 6).join("\n") + "\n", "utf8");

    const follower = new SessionFollower(path, claudeCodeAdapter);
    expect(follower.poll().length).toBeGreaterThan(0);

    // Rewrite history: change the user's message text in record 2.
    const mutated = lines
      .slice(0, 6)
      .map((l, i) => (i === 1 ? l.replace("Add a greeting module", "Do something else entirely") : l));
    writeFileSync(path, mutated.join("\n") + "\n", "utf8");
    expect(() => follower.poll()).toThrow(StabilityError);
  });
});
