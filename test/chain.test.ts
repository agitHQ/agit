import { describe, expect, it } from "vitest";
import { buildChain, eventHash, toJsonl } from "../src/format/hash.js";
import { verifyChain } from "../src/format/verify.js";
import type { DraftEvent } from "../src/format/events.js";

const drafts: DraftEvent[] = [
  { ts: "2026-01-01T00:00:00.000Z", type: "session.start", payload: { runtime: "test" } },
  { ts: "2026-01-01T00:00:01.000Z", type: "message.user", payload: { text: "hi" } },
  { ts: "2026-01-01T00:00:02.000Z", type: "message.assistant", payload: { model: "m", blocks: [] } },
  { ts: "2026-01-01T00:00:03.000Z", type: "session.end", payload: { reason: "log-end" } },
];

function lines(): string[] {
  return toJsonl(buildChain("s1", drafts)).trimEnd().split("\n");
}

describe("hash chain (SPEC §4)", () => {
  it("builds a chain that verifies", () => {
    const res = verifyChain(lines());
    expect(res).toEqual({ ok: true, events: 4 });
  });

  it("genesis has prev null, later events link", () => {
    const events = buildChain("s1", drafts);
    expect(events[0]!.prev).toBeNull();
    expect(events[1]!.prev).toBe(events[0]!.hash);
    expect(events[3]!.prev).toBe(events[2]!.hash);
  });

  it("detects a tampered payload at the right seq", () => {
    const ls = lines();
    ls[1] = ls[1]!.replace('"hi"', '"bye"');
    const res = verifyChain(ls);
    expect(res.ok).toBe(false);
    expect(res.firstBroken!.seq).toBe(1);
    expect(res.firstBroken!.reason).toMatch(/hash/);
  });

  it("detects a re-hashed tampered event via the prev link", () => {
    // Attacker edits event 1 AND recomputes its hash: event 2's prev now breaks.
    const events = buildChain("s1", drafts);
    const tampered = { ...events[1]!, payload: { text: "bye" } };
    tampered.hash = eventHash(tampered);
    const ls = [events[0]!, tampered, events[2]!, events[3]!].map((e) => JSON.stringify(e));
    const res = verifyChain(ls);
    expect(res.ok).toBe(false);
    expect(res.firstBroken!.seq).toBe(2);
    expect(res.firstBroken!.reason).toMatch(/prev/);
  });

  it("detects truncation only with meta", () => {
    const ls = lines();
    const truncated = ls.slice(0, 3);
    expect(verifyChain(truncated).ok).toBe(true); // chain alone cannot see it
    const events = buildChain("s1", drafts);
    const res = verifyChain(truncated, { eventCount: 4, headHash: events[3]!.hash });
    expect(res.ok).toBe(false);
    expect(res.firstBroken!.reason).toMatch(/truncated/);
  });

  it("reports a non-object line instead of crashing on it", () => {
    // Valid JSON is not necessarily an event. `null` is the sharp case: it
    // parses cleanly and then throws on every property read, so a tampered
    // log used to take the verifier down with it — the one thing verifyChain
    // exists to survive. Scalars and arrays reported "unknown schema version
    // undefined", which names the wrong problem.
    for (const junk of ["null", "123", '"a string"', "[]"]) {
      const ls = lines();
      ls[2] = junk;
      const res = verifyChain(ls);
      expect(res.ok).toBe(false);
      expect(res.firstBroken!.seq).toBe(2);
      expect(res.firstBroken!.reason).toMatch(/not a JSON object/);
    }
  });

  it("still reports unparseable lines as bad JSON", () => {
    const ls = lines();
    ls[2] = "{not json";
    expect(verifyChain(ls).firstBroken!.reason).toMatch(/not valid JSON/);
  });

  it("rejects unknown event types", () => {
    const ls = lines();
    ls[1] = ls[1]!.replace('"message.user"', '"message.alien"');
    const res = verifyChain(ls);
    expect(res.ok).toBe(false);
    expect(res.firstBroken!.reason).toMatch(/unknown event type/);
  });
});
