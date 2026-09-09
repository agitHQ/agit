/**
 * `agit grep` — search across every imported session (issue #32).
 *
 * Once someone has fifty sessions, "which session touched auth.py" and
 * "where did I already solve this" are the obvious questions, and the only
 * answer used to be `agit export | rg`, one session at a time.
 *
 * Matching runs against the same one-line rendering `replay --timeline`
 * prints, so what you search is what you saw. A linear scan over the stored
 * JSONL is fast enough for thousands of sessions; an index is an
 * optimisation for a problem nobody has yet.
 */

import type { AgitEvent, EventType, Json } from "./format/events.js";
import { eventLine } from "./state.js";

export interface GrepHit {
  session: string;
  seq: number;
  ts: string;
  type: EventType;
  line: string;
}

export interface GrepOptions {
  /** Restrict to one event type, e.g. tool.call. */
  type?: string;
  /** Match only file.diff paths — "which session touched auth.py". */
  path?: boolean;
  /** Default is case-insensitive, like a first search usually wants. */
  caseSensitive?: boolean;
  /** Treat the pattern as a regular expression rather than a literal. */
  regex?: boolean;
}

export class GrepPatternError extends Error {}

/** Build the matcher once; a bad regex is the user's error, reported as such. */
export function buildMatcher(pattern: string, opts: GrepOptions = {}): (s: string) => boolean {
  if (!opts.regex) {
    const needle = opts.caseSensitive ? pattern : pattern.toLowerCase();
    return (s) => (opts.caseSensitive ? s : s.toLowerCase()).includes(needle);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.caseSensitive ? "" : "i");
  } catch (err) {
    throw new GrepPatternError(
      `not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (s) => re.test(s);
}

/**
 * Search one session's events. `session` is only used to label hits, so this
 * stays a pure function over data the caller already read.
 */
export function grepEvents(
  session: string,
  events: AgitEvent[],
  matches: (s: string) => boolean,
  opts: GrepOptions = {},
): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const e of events) {
    if (opts.type !== undefined && e.type !== opts.type) continue;

    if (opts.path) {
      // Path mode asks a narrower question than the rendered line answers:
      // which sessions touched this file, not which lines mention it.
      if (e.type !== "file.diff") continue;
      const p = (e.payload as { path?: Json }).path;
      if (typeof p !== "string" || !matches(p)) continue;
    } else if (!matches(eventLine(e))) {
      continue;
    }

    hits.push({ session, seq: e.seq, ts: e.ts, type: e.type, line: eventLine(e) });
  }
  return hits;
}

/** One flat, greppable row per hit — deliberately not grouped by session. */
export function renderHit(hit: GrepHit, idWidth: number): string {
  return `${hit.session.slice(0, idWidth).padEnd(idWidth)}  ${String(hit.seq).padStart(5)}  ${hit.line}`;
}
