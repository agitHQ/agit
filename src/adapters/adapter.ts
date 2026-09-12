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
  /**
   * For a file that holds several sessions (a LangGraph checkpoint database
   * has one per thread): the native id of the one to import. Without it an
   * adapter imports the only session there is, and refuses — naming the
   * candidates — when there is more than one.
   */
  select?: string;
}

export interface Adapter {
  name: string;
  version: string;
  /** Cheap sniff: could these lines be this runtime's native log? */
  detect(lines: string[]): boolean;
  convert(lines: string[], opts?: ConvertOptions): ConvertResult;
  /**
   * The same pair for a runtime whose log is not text. A binary adapter
   * answers false to `detect` (there are no lines to recognize) and reads
   * the file's bytes here instead; the import path tries these first, since
   * a database read as UTF-8 is not a log with unusual lines but noise.
   */
  detectBytes?(bytes: Uint8Array): boolean;
  convertBytes?(bytes: Uint8Array, opts?: ConvertOptions): ConvertResult;
  /**
   * The native ids of every session a binary file holds, in a stable order,
   * each usable as `ConvertOptions.select`. The import path imports them
   * all unless told which one; `convertBytes` without `select` is only for
   * a file that holds exactly one.
   */
  sessionsIn?(bytes: Uint8Array): string[];
}
