/** The .agit/ directory: sessions/<id>/events.jsonl + meta.json (SPEC §1, §10). */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEventType, type AgitEvent, type SessionMeta } from "./format/events.js";

export function agitDir(base: string): string {
  return join(base, ".agit");
}

export function sessionDir(base: string, id: string): string {
  return join(agitDir(base), "sessions", id);
}

/**
 * SPEC.md §1: a session id MUST be safe as a directory name,
 * `[A-Za-z0-9._-]+`. That charset already excludes path separators, but "."
 * and ".." both match it while still being directory-traversal escapes (the
 * sessions dir itself, or its parent) — reject those explicitly.
 *
 * This matters because a session id is untrusted input: it comes straight
 * from the native log being imported (`rec.sessionId`), a file agit treats
 * as adversarial everywhere else. Without this check, an `agit import` of a
 * crafted log with e.g. `"sessionId": "../../../../tmp/pwned"` writes
 * events.jsonl/meta.json outside .agit/sessions entirely.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export function assertSafeSessionId(id: string): void {
  if (typeof id !== "string" || id === "" || id === "." || id === ".." || !SAFE_SESSION_ID.test(id)) {
    throw new Error(
      `refusing unsafe session id ${JSON.stringify(id)}: must match ${SAFE_SESSION_ID.source} ` +
        `and not be "." or ".." (SPEC.md §1)`,
    );
  }
}

export function writeSession(base: string, id: string, eventsJsonl: string, meta?: SessionMeta): void {
  assertSafeSessionId(id);
  // Two ids that differ only in case are one directory on NTFS and APFS, so
  // writing "DEMO-x" where "demo-x" exists lands in the existing session's
  // directory and replaces its log under the old meta.json. Refused on every
  // platform, not just those, because a store has to survive being copied to
  // one. An exact match is an update to the same session and proceeds.
  const clash = listSessionIds(base).find((x) => x.toLowerCase() === id.toLowerCase() && x !== id);
  if (clash !== undefined) {
    throw new Error(
      `refusing to write session ${id}: it differs only in case from ${clash}, which already exists ` +
        "(the two would be one directory on a case-insensitive filesystem)",
    );
  }
  const dir = sessionDir(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), eventsJsonl, "utf8");
  // meta is optional: a bundle adopted without one gets no meta.json rather
  // than a fabricated adapter and source it never had. Readers already treat
  // a missing meta.json as "truncation not checkable".
  if (meta) writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

export function listSessionIds(base: string): string[] {
  const dir = join(agitDir(base), "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "events.jsonl")))
    .map((d) => d.name)
    .sort();
}

/** Resolve a full id or a unique prefix, git-style. */
export function resolveSessionId(base: string, idOrPrefix: string): string {
  const ids = listSessionIds(base);
  if (ids.includes(idOrPrefix)) return idOrPrefix;
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no session matches "${idOrPrefix}" (agit ls to list)`);
  throw new Error(`ambiguous session id "${idOrPrefix}": matches ${matches.join(", ")}`);
}

export function readSessionLines(base: string, id: string): string[] {
  const raw = readFileSync(join(sessionDir(base, id), "events.jsonl"), "utf8");
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Parse events leniently for display verbs; verify is the strict path. */
export function readSessionEvents(base: string, id: string): AgitEvent[] {
  const events: AgitEvent[] = [];
  const all = readSessionLines(base, id);
  if (all.length === 0 || (all.length === 1 && all[0] === "")) {
    throw new Error(`session ${id} has an empty events.jsonl — the store is corrupt; re-import the session`);
  }
  const lines = all;
  for (let i = 0; i < lines.length; i++) {
    // `null` parses cleanly and then throws on the first property read, so a
    // corrupt log crashed the display verbs with a bare TypeError. Same guard
    // as verifyChain, pointing at the verb that explains the whole log.
    const parsed: unknown = JSON.parse(lines[i]!);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`line ${i + 1} is not a JSON object — run \`agit verify\` on this session`);
    }
    const e = parsed as AgitEvent;
    if (typeof e.type !== "string" || !isEventType(e.type)) {
      throw new Error(
        `event ${e.seq}: unknown type ${JSON.stringify(e.type)} — was this written by a newer agit?`,
      );
    }
    // SPEC §2 says payload is an object, and every renderer dereferences it
    // on that assumption. verifyChain does not check it, and a chain built
    // over `payload: null` verifies cleanly, so a bundle or a pulled share can
    // land one here. Rejecting it at the read is what keeps that one session
    // from taking down every verb that walks the store.
    if (e.payload === null || typeof e.payload !== "object" || Array.isArray(e.payload)) {
      throw new Error(`event ${e.seq}: payload is not an object — run \`agit verify\` on this session`);
    }
    events.push(e);
  }
  return events;
}

export function readSessionMeta(base: string, id: string): SessionMeta | null {
  const p = join(sessionDir(base, id), "meta.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SessionMeta;
}

/**
 * Replace a session's meta.json (#68: adding a signature).
 *
 * Writes the whole document rather than patching, so the file on disk is
 * always exactly what `SessionMeta` says it is. Nothing here touches
 * events.jsonl — a signature is metadata about a head, and adding one must
 * never move the head it signs.
 */
export function writeSessionMeta(base: string, id: string, meta: SessionMeta): void {
  writeFileSync(join(sessionDir(base, id), "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

/**
 * Remove a session from the store. `id` is trusted here — every caller goes
 * through `resolveSessionId` first, which only ever returns an id that is
 * already a real directory name under sessions/, so this can't be handed an
 * unsafe path the way `writeSession` can from untrusted import input.
 */
export function deleteSession(base: string, id: string): void {
  rmSync(sessionDir(base, id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Session notes: tags and a free-text note, in a sidecar beside the log.
//
// Deliberately NOT in the chain. The chain is what the runtime did; a tag is
// what you thought about it afterwards, and it changes. Putting it in the log
// would either break the hashes or require rewriting history to rename a tag.
// The sidecar is ordinary mutable JSON, ignored by verify.

export interface SessionNotes {
  tags: string[];
  note: string | null;
}

const EMPTY_NOTES: SessionNotes = { tags: [], note: null };

export function notesPath(base: string, id: string): string {
  return join(sessionDir(base, id), "notes.json");
}

export function readNotes(base: string, id: string): SessionNotes {
  const p = notesPath(base, id);
  if (!existsSync(p)) return { ...EMPTY_NOTES };
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as Partial<SessionNotes>;
    return {
      tags: Array.isArray(doc.tags) ? doc.tags.filter((t): t is string => typeof t === "string") : [],
      note: typeof doc.note === "string" ? doc.note : null,
    };
  } catch {
    // A corrupt sidecar must never take down a read verb; the log is the data.
    return { ...EMPTY_NOTES };
  }
}

export function writeNotes(base: string, id: string, notes: SessionNotes): void {
  assertSafeSessionId(id);
  writeFileSync(notesPath(base, id), JSON.stringify(notes, null, 2) + "\n", "utf8");
}

/** Tags are a set, kept sorted so the sidecar does not churn. */
export function addTag(base: string, id: string, tag: string): SessionNotes {
  const notes = readNotes(base, id);
  const next = { ...notes, tags: [...new Set([...notes.tags, tag])].sort() };
  writeNotes(base, id, next);
  return next;
}

export function removeTag(base: string, id: string, tag: string): SessionNotes {
  const notes = readNotes(base, id);
  const next = { ...notes, tags: notes.tags.filter((t) => t !== tag) };
  writeNotes(base, id, next);
  return next;
}

export function setNote(base: string, id: string, note: string | null): SessionNotes {
  const next = { ...readNotes(base, id), note };
  writeNotes(base, id, next);
  return next;
}

/** Remove a session's directory entirely. The caller is responsible for confirming. */
export function removeSession(base: string, id: string): void {
  assertSafeSessionId(id);
  const dir = sessionDir(base, id);
  if (!existsSync(dir)) throw new Error(`no such session directory: ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The shortest prefix of each id that is unique in the store, git-style.
 * Never shorter than 4, so ids stay recognisable when the store is small.
 */
export function minimalPrefixes(ids: string[], min = 4): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    let n = Math.min(min, id.length);
    while (n < id.length && ids.some((other) => other !== id && other.slice(0, n) === id.slice(0, n))) n++;
    out.set(id, id.slice(0, n));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Share state: credentials for resuming a live share after a crash. Written
// when a live share starts, deleted when it ends cleanly — so a surviving
// file means "resumable". Contains the writer token in plaintext; it lives
// under .agit/ on the sharer's own machine, same trust domain as the logs.

export interface ShareState {
  shareId: string;
  writerToken: string;
  ttlMs: number;
  viewUrl: string;
  relay: string;
  nativePath: string;
  createdAt: string;
}

export function sharesDir(base: string): string {
  return join(agitDir(base), "shares");
}

export function writeShareState(base: string, state: ShareState): void {
  mkdirSync(sharesDir(base), { recursive: true });
  writeFileSync(
    join(sharesDir(base), `${state.shareId}.json`),
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

export function deleteShareState(base: string, shareId: string): void {
  rmSync(join(sharesDir(base), `${shareId}.json`), { force: true });
}

export function resolveShareState(base: string, prefix: string): ShareState {
  const dir = sharesDir(base);
  const ids = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
    : [];
  const matches = ids.filter((id) => id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`no resumable share matches "${prefix}" (nothing in ${dir})`);
  if (matches.length > 1) throw new Error(`"${prefix}" is ambiguous: ${matches.join(", ")}`);
  return JSON.parse(readFileSync(join(dir, `${matches[0]!}.json`), "utf8")) as ShareState;
}
