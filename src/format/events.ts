/** Core event types for the agit v2 format. See SPEC.md. */

/** Schema version this build writes. Readers accept every version in SUPPORTED_SCHEMA_VERSIONS. */
export const SCHEMA_VERSION = 2;

/**
 * Every version a reader must accept. A v1 log is a v2 log that cannot
 * contain `file.delete` — that is the whole difference — so logs written by
 * earlier builds (stores, `pr` bundles, share downloads) keep verifying and
 * keep working, unchanged and unrewritten.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export const EVENT_TYPES = [
  "session.start",
  "session.end",
  "message.user",
  "message.assistant",
  "tool.call",
  "tool.result",
  "file.diff",
  "file.delete",
  "cost",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** JSON value as it appears in payloads. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface AgitEvent {
  v: number;
  seq: number;
  /** ISO-8601 UTC with milliseconds. */
  ts: string;
  session: string;
  type: EventType;
  payload: { [key: string]: Json };
  /** Hash of the previous event; null iff seq === 0. */
  prev: string | null;
  /** SHA-256 hex of the canonical form of this event minus `hash`. */
  hash: string;
}

/** An event before it has been placed in the chain. */
export type DraftEvent = Omit<AgitEvent, "v" | "seq" | "session" | "prev" | "hash">;

export interface SessionMeta {
  agitSchema: number;
  sessionId: string;
  adapter: { name: string; version: string };
  importedAt: string;
  source: { path: string; sha256: string; bytes: number; records: number };
  skipped: Record<string, number>;
  redactions: Record<string, number>;
  /**
   * A base tree supplied at import (#85), so `show` can say where an update's
   * verification came from. Absent means no base was given.
   */
  base?: { kind: "git" | "dir"; ref: string; cwd: string | null; files: number };
  /**
   * What redaction did at import (#70). Optional: logs imported before this
   * existed simply do not carry it, and absence means "the built-in patterns
   * ran", which is what those imports did.
   */
  redaction?: { enabled: boolean; customPatterns: number; allowRules: number };
  /**
   * Ed25519 signatures over this head (#68), never in the chain: signing is
   * something done to a finished head, so a chain covering it would have to
   * cover a thing that did not exist when it was built. Kept here, a session
   * can be signed after the fact, and by more than one person, without a
   * single event being rewritten. See SPEC §12 for the signed payload.
   */
  signatures?: AgitSignatureRecord[];
  eventCount: number;
  headHash: string;
}

/** One signature over a head. Shape documented in SPEC §12 so others can verify it. */
export interface AgitSignatureRecord {
  alg: "ed25519";
  key: string;
  keyFingerprint: string;
  sig: string;
  at: string;
  payloadVersion: number;
}

export function isEventType(t: string): t is EventType {
  return (EVENT_TYPES as readonly string[]).includes(t);
}

/** The types a given schema version allows: v1 has everything but `file.delete`. */
export function isEventTypeForVersion(t: string, v: number): boolean {
  if (!isEventType(t)) return false;
  return v >= 2 || t !== "file.delete";
}
