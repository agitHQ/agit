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

export function writeSession(base: string, id: string, eventsJsonl: string, meta: SessionMeta): void {
  assertSafeSessionId(id);
  const dir = sessionDir(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), eventsJsonl, "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
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
    events.push(e);
  }
  return events;
}

export function readSessionMeta(base: string, id: string): SessionMeta | null {
  const p = join(sessionDir(base, id), "meta.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SessionMeta;
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
