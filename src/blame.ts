/**
 * `agit blame` and `agit why` — from a line of code back to the session that
 * wrote it, and from there back to the prompt that asked for it (#65).
 *
 * agit can do this *verifiably*: every `file.diff` carries the path, the
 * diff, and the content hash of the result, so a line traces to a
 * hash-chained event rather than to a checkpoint blob. Replaying a file's
 * diffs while carrying per-line provenance costs nothing extra — the
 * reconstruction already had to happen for `fork`.
 *
 * It inherits the SPEC §5.7 limit and says so rather than hiding it: a line
 * changed by a shell command left no structured edit, so it has no
 * attribution, and blame reports that instead of crediting the last event
 * that happened to touch the file.
 */

import type { AgitEvent, Json } from "./format/events.js";
import { sha256Hex } from "./format/hash.js";
import { parseHunks } from "./patch.js";

export interface LineOrigin {
  /** 1-based line number in the final content. */
  line: number;
  text: string;
  /** Null when no structured edit in the store introduced this line. */
  session: string | null;
  seq: number | null;
  ts: string | null;
}

export interface BlameResult {
  path: string;
  lines: LineOrigin[];
  /** Every session that structurally edited this path, oldest first. */
  sessions: string[];
  /** True when every replayed step reproduced its event's afterHash. */
  verified: boolean;
  /**
   * Seq of the first structured edit that did not fit the content we held —
   * cryptographic proof the file changed outside structured edits (SPEC
   * §5.7). Blame is reported as of the step before it; everything after is
   * unknowable from the log, and is not guessed at.
   */
  divergedAtSeq?: number;
  /** The session that divergence was found in. */
  divergedIn?: string;
}

interface Carried {
  text: string;
  session: string | null;
  seq: number | null;
  ts: string | null;
}

/**
 * Apply one unified diff, carrying provenance.
 *
 * Same grammar and the same strictness as `applyUnifiedDiff`: context and
 * deletions must match, and anything else throws rather than fuzzy-matching.
 * Context lines keep whatever wrote them; only `+` lines take the new origin.
 */
function applyCarrying(base: Carried[], diff: string, origin: Omit<Carried, "text">): Carried[] {
  const hunks = parseHunks(diff);
  const out: Carried[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) throw new Error("hunks overlap or are out of order");
    while (cursor < start) {
      if (cursor >= base.length) throw new Error("hunk start beyond end of base");
      out.push(base[cursor++]!);
    }
    for (const l of hunk.lines) {
      const tag = l[0];
      const text = l.slice(1);
      if (tag === "\\") continue; // "\ No newline at end of file"
      if (tag === " " || tag === "-") {
        if (cursor >= base.length || base[cursor]!.text !== text) {
          throw new Error(`context mismatch at base line ${cursor + 1}`);
        }
        if (tag === " ") out.push(base[cursor]!); // provenance survives context
        cursor++;
      } else if (tag === "+") {
        out.push({ text, ...origin });
      } else if (l === "") {
        if (cursor >= base.length || base[cursor]!.text !== "") {
          throw new Error(`context mismatch at base line ${cursor + 1}`);
        }
        out.push(base[cursor]!);
        cursor++;
      } else {
        throw new Error(`unrecognized diff line: ${JSON.stringify(l)}`);
      }
    }
  }
  while (cursor < base.length) out.push(base[cursor++]!);
  return out;
}

interface DiffPayload {
  path?: Json;
  kind?: Json;
  diff?: Json;
  beforeHash?: Json;
  afterHash?: Json;
  toolUseId?: Json;
}

/**
 * The full pre-edit content the runtime recorded alongside an edit, if any.
 *
 * A file that predates the session has no `create` to seed from, but Claude
 * Code records `originalFile` on the tool result — the same recovery `fork`
 * uses, and trusted on the same terms: only when it hashes to the
 * `beforeHash` the edit claims.
 */
function originalFileFor(events: AgitEvent[], toolUseId: string): string | null {
  for (const e of events) {
    if (e.type !== "tool.result") continue;
    const p = e.payload as { toolUseId?: Json; structured?: Json };
    if (p.toolUseId !== toolUseId) continue;
    const st = p.structured;
    if (st !== null && typeof st === "object" && !Array.isArray(st) && typeof st.originalFile === "string") {
      return st.originalFile;
    }
  }
  return null;
}

/**
 * Blame one path across every session given, in timestamp order.
 *
 * Sessions are folded in sequence: a later session's edits apply on top of an
 * earlier one's result, which is what a repository's own history looks like.
 * When a session's first edit does not fit what we hold, its chain for this
 * path is abandoned and the file is re-seeded from that event — attribution
 * before it stays, attribution after it belongs to the new chain.
 */
export function blameFile(sessions: { id: string; events: AgitEvent[] }[], path: string): BlameResult {
  const steps: { id: string; e: AgitEvent; p: DiffPayload }[] = [];
  for (const { id, events } of sessions) {
    for (const e of events) {
      if (e.type !== "file.diff" && e.type !== "file.delete") continue;
      const p = e.payload as DiffPayload;
      if (p.path !== path) continue;
      steps.push({ id, e, p });
    }
  }
  steps.sort((a, b) => a.e.ts.localeCompare(b.e.ts) || a.e.seq - b.e.seq);

  let lines: Carried[] = [];
  let verified = true;
  let divergedAtSeq: number | undefined;
  let divergedIn: string | undefined;
  const touched: string[] = [];

  for (const { id, e, p } of steps) {
    if (!touched.includes(id)) touched.push(id);
    if (divergedAtSeq !== undefined) break; // nothing past it is knowable
    if (e.type === "file.delete") {
      lines = [];
      continue;
    }
    if (typeof p.diff !== "string" || typeof p.afterHash !== "string") continue;
    const origin = { session: id, seq: e.seq, ts: e.ts };

    // First sight of a file that predates the session: recover its pre-edit
    // content from what the runtime recorded, hash-checked. Those lines carry
    // no attribution — nothing in the store wrote them — which is exactly
    // what blame should say about them.
    if (lines.length === 0 && p.kind !== "create" && typeof p.toolUseId === "string") {
      const events = sessions.find((x) => x.id === id)?.events ?? [];
      const orig = originalFileFor(events, p.toolUseId);
      if (orig !== null && (typeof p.beforeHash !== "string" || sha256Hex(orig) === p.beforeHash)) {
        const parts = orig.split("\n");
        if (parts[parts.length - 1] === "") parts.pop();
        lines = parts.map((text) => ({ text, session: null, seq: null, ts: null }));
      }
    }
    let next: Carried[];
    try {
      next = applyCarrying(p.kind === "create" ? [] : lines, p.diff, origin);
    } catch {
      // The diff does not fit what we hold: something changed this file
      // outside structured edits. Stop here and keep the last state we could
      // actually vouch for, rather than guessing at the rest or throwing the
      // verified part away.
      divergedAtSeq = e.seq;
      divergedIn = id;
      verified = false;
      break;
    }
    if (sha256Hex(next.map((l) => l.text + "\n").join("")) !== p.afterHash) {
      // We applied the diff but did not land on the content the event claims.
      divergedAtSeq = e.seq;
      divergedIn = id;
      verified = false;
      break;
    }
    lines = next;
  }

  return {
    path,
    // Every line here came out of a step that reproduced its own hash, so the
    // attribution stands even when a later step diverged.
    lines: lines.map((l, i) => ({ line: i + 1, text: l.text, session: l.session, seq: l.seq, ts: l.ts })),
    sessions: touched,
    verified,
    ...(divergedAtSeq !== undefined ? { divergedAtSeq, divergedIn } : {}),
  };
}

export interface WhyResult {
  origin: LineOrigin;
  /** The user message that opened the turn the edit happened in. */
  prompt: string | null;
  /** Assistant text from the same turn, nearest the edit. */
  rationale: string | null;
}

const textOf = (e: AgitEvent): string => {
  const p = e.payload as { text?: Json; blocks?: Json };
  if (typeof p.text === "string") return p.text;
  if (Array.isArray(p.blocks)) {
    return (p.blocks as { type?: Json; text?: Json }[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
};

/**
 * The turn an edit belonged to: the last user message before it, and the
 * assistant text between that message and the edit.
 */
export function whyLine(events: AgitEvent[], origin: LineOrigin): WhyResult {
  if (origin.seq === null) return { origin, prompt: null, rationale: null };
  let prompt: string | null = null;
  let promptAt = -1;
  for (const e of events) {
    if (e.seq > origin.seq) break;
    if (e.type === "message.user") {
      prompt = textOf(e);
      promptAt = e.seq;
    }
  }
  let rationale: string | null = null;
  for (const e of events) {
    if (e.seq <= promptAt) continue;
    if (e.seq > origin.seq) break;
    if (e.type === "message.assistant") {
      const t = textOf(e);
      if (t.trim() !== "") rationale = t; // nearest preceding wins
    }
  }
  return { origin, prompt, rationale };
}

/**
 * The commit trailer that anchors a commit to the session that produced it:
 * `Agit-Session: <id>@<seq> <hash>`.
 */
export function sessionTrailer(id: string, seq: number, hash: string): string {
  return `Agit-Session: ${id}@${seq} ${hash}`;
}
