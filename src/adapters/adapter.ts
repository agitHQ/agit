import type { BaseTree } from "../base.js";
import type { DraftEvent } from "../format/events.js";

/** What an adapter produces from one native session log. Payloads are not yet redacted or chained — the import pipeline does both. */
export interface ConvertResult {
  sessionId: string;
  drafts: DraftEvent[];
  /** Native record count (non-empty lines). */
  records: number;
  /** Native record types (or markers like "<unparseable>") that were skipped, with counts. Skip and log, never guess. */
  skipped: Record<string, number>;
}

export interface ConvertOptions {
  /**
   * The session is still running. Suppress everything that depends on where
   * the file currently ends (the EOF cost flush and the synthesized
   * session.end), so that converting a longer version of the same log always
   * extends this result — the live stream is prefix-stable, and its hashes
   * equal the final import's prefix.
   */
  live?: boolean;
  /**
   * Content the user supplied for files that predate the session (#85), so an
   * update to one has a verifiable base. Only a candidate: the runtime's diff
   * still has to apply and the result still has to hash, so a wrong base
   * skips exactly as no base does.
   */
  base?: BaseTree;
}

export interface Adapter {
  name: string;
  version: string;
  /** Cheap sniff: could these lines be this runtime's native log? */
  detect(lines: string[]): boolean;
  convert(lines: string[], opts?: ConvertOptions): ConvertResult;
}
