import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { canonicalJson } from "../src/format/canonical.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { verifyChain } from "../src/format/verify.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";
import { SessionFollower, StabilityError } from "../src/share.js";
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
    const full = claudeCodeAdapter.convert(lines);
    const counts: RedactionCounts = {};
    for (const d of full.drafts) d.payload = redactDeep(d.payload, counts);
    const imported = buildChain(full.sessionId, full.drafts);
    expect(toJsonl(streamed)).toBe(toJsonl(imported));
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
