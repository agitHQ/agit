import { eventHash } from "./hash.js";
import { isEventType, SCHEMA_VERSION, type AgitEvent, type SessionMeta } from "./events.js";

export interface VerifyResult {
  ok: boolean;
  events: number;
  /** First broken link, when !ok. */
  firstBroken?: { seq: number; reason: string };
}

/**
 * Walk the log and check the chain (SPEC.md §4): parseability, schema
 * version, type validity, seq contiguity, prev linkage, hash recomputation.
 * When meta is given, also detect truncation via eventCount/headHash.
 */
export function verifyChain(
  lines: string[],
  meta?: Pick<SessionMeta, "eventCount" | "headHash">,
): VerifyResult {
  let prev: string | null = null;
  let count = 0;
  let lastHash: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      if (i === lines.length - 1) break; // trailing newline
      return broken(count, i, "blank line inside log");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return broken(count, i, "line is not valid JSON");
    }
    // A line may be valid JSON and still not be an event. `null` in
    // particular parses fine and then throws on every property read, so a
    // tampered log could crash the verifier instead of being reported by it —
    // the one thing this function exists to do. Scalars and arrays reach the
    // version check today and are reported as "unknown schema version
    // undefined", which describes the wrong problem.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return broken(count, i, "line is not a JSON object");
    }
    const e = parsed as AgitEvent;
    if (e.v !== SCHEMA_VERSION) return broken(count, i, `unknown schema version ${e.v}`);
    if (typeof e.type !== "string" || !isEventType(e.type))
      return broken(count, i, `unknown event type ${JSON.stringify(e.type)}`);
    if (e.seq !== count) return broken(count, i, `seq ${e.seq}, expected ${count}`);
    if (e.prev !== prev) return broken(count, i, "prev does not match previous event's hash");
    const recomputed = eventHash(e);
    if (recomputed !== e.hash) return broken(count, i, "hash does not recompute");
    prev = e.hash;
    lastHash = e.hash;
    count++;
  }

  if (meta) {
    if (count !== meta.eventCount) {
      return {
        ok: false,
        events: count,
        firstBroken: {
          seq: count,
          reason: `log has ${count} events but meta.json records ${meta.eventCount} (truncated or extended)`,
        },
      };
    }
    if (lastHash !== meta.headHash) {
      return {
        ok: false,
        events: count,
        firstBroken: { seq: count - 1, reason: "head hash does not match meta.json" },
      };
    }
  }
  return { ok: true, events: count };

  function broken(seq: number, _line: number, reason: string): VerifyResult {
    return { ok: false, events: count, firstBroken: { seq, reason } };
  }
}
