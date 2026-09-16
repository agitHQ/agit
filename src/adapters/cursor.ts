/**
 * Adapter for Cursor agent transcripts (#62, #118).
 *
 * Cursor's agent writes one JSONL per session under
 *   ~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl
 * and a subagent's under
 *   ~/.cursor/projects/<slug>/agent-transcripts/<parent>/subagents/<uuid>.jsonl,
 * where <slug> is the working directory with every character outside
 * [A-Za-z0-9] replaced by "-" and the leading "-" dropped — not reversible,
 * so `cwd` stays null and the slug rides under `native`. Cursor is closed
 * source and publishes no schema; every shape below is an observed one —
 * 104 transcripts, 5,335 records, 11,162 content blocks, Cursor IDE 3.13.25
 * — published with their shape histogram and one representative record per
 * shape under MIT in Einsia/agent-git (docs/mechanism-probing/
 * cursor-kiro-formats.md and docs/mechanism-probing/samples/cursor/, at
 * commit 8e222bc0c2c9). Two top-level shapes exist and nothing else:
 *
 *   - `{ role: "user" | "assistant", message: { content: [...] } }` — the
 *     message has one key, `content`, always an array. A block is
 *     `{ type: "text", text }` for either role, or for the assistant
 *     `{ type: "tool_use", name, input }` — with no id. `input` is an
 *     object except for `ApplyPatch`, whose input is the patch text itself.
 *   - `{ type: "turn_ended", status }` — `success`, or `error` / `aborted`
 *     with an `error` string; written only from Cursor 3.13 on, so absent
 *     from older transcripts, and roughly one per human turn, not exactly.
 *
 * Four absences decide what this adapter can do: no `tool_result` (not one
 * line of tool output is persisted), no thinking, no timestamp field, and no
 * session id, cwd or model. The transcript is a projection of a state
 * database Cursor keeps encrypted; what is not in the projection was never
 * on disk for agit to read.
 *
 * A user block's text is Cursor's framing around what the person typed:
 * `<timestamp>Tuesday, Jun 2, 2026, 11:20 AM (UTC+8)</timestamp>` — a
 * localized string, the transcript's only clock — then
 * `<user_query>…</user_query>`, sometimes `<image_files>` or
 * `<external_links>` blocks beside it. The event's `text` is the inner
 * query; the tags around it are listed under `native.tags`. Four sentences
 * inside the wrapper are Cursor's own, sent when a subagent or background
 * task finishes, when a fork starts, or after an interruption (the last
 * without a wrapper); an exact match on those observed openings marks the
 * event `native.injected: true`. Nothing else is guessed: repetition is not
 * a signal (Cursor copies the parent's history into a forked subagent's
 * transcript, so real prompts repeat too).
 *
 * Mapping: a user text block → `message.user`, dated by its `<timestamp>`;
 * an assistant record's text blocks → one `message.assistant` (model null)
 * and each `tool_use` → a `tool.call` with a null `toolUseId`, dated by the
 * last user timestamp seen, since assistant records carry no time at all;
 * `turn_ended` is counted by status. The session id is the file's stem
 * (`<uuid>.jsonl`), a subagent's parent the directory above `subagents/`.
 * Without a path the id is derived from the first line and counted.
 *
 * **No `file.diff`, no `tool.result`, no `cost`.** `Write` carries the
 * bytes it wrote and `StrReplace` its two strings, but with no result
 * record nothing says the tool ran, and no prior content is recorded to
 * verify an update against; `Delete` records intent, not an outcome, so it
 * is a `tool.call`, not `file.delete`. Derived from the observed records
 * above and validated against a fixture built to them; a transcript that
 * disagrees names its unmapped records in the import report.
 */

import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "cursor";
const ADAPTER_VERSION = "0.1.0";

type Rec = { [k: string]: Json };

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function parseLine(line: string): Rec | undefined {
  try {
    return asRec(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** `{ role, message: { content: [...] } }` and nothing that another format's records carry. */
function isConversation(r: Rec): boolean {
  const role = r.role;
  if (role !== "user" && role !== "assistant") return false;
  const message = asRec(r.message);
  if (message === undefined || !Array.isArray(message.content)) return false;
  return (
    r.type === undefined && r.uuid === undefined && r.sessionId === undefined && r.parentUuid === undefined
  );
}

function isTurnEnded(r: Rec): boolean {
  return r.type === "turn_ended" && r.role === undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Cursor's clock string, `Tuesday, Jun 2, 2026, 11:20 AM (UTC+8)`, to ISO:
 * an optional weekday, an English month, day, year, a 12- or 24-hour time,
 * and the UTC offset in parentheses. Anything else is null and counted.
 */
export function parseCursorTimestamp(text: string): string | null {
  const m =
    /^(?:[A-Za-z]+,\s*)?([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*\(UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)$/.exec(
      text.trim(),
    );
  if (m === null) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  if (month === undefined) return null;
  let hour = Number(m[4]);
  const ampm = m[7]?.toUpperCase();
  if (ampm === "AM" && hour === 12) hour = 0;
  else if (ampm === "PM" && hour < 12) hour += 12;
  if (hour > 23 || Number(m[5]) > 59) return null;
  const offsetMinutes = (Number(m[9] ?? 0) * 60 + Number(m[10] ?? 0)) * (m[8] === "-" ? -1 : 1);
  const ms =
    Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5]), Number(m[6] ?? 0)) -
    offsetMinutes * 60_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The openings of the user texts Cursor writes itself (observed; exact prefixes). */
const INJECTED_OPENINGS = [
  "Perform any necessary follow-up actions in response to the subagent completion above.",
  "Briefly inform the user about the task result and perform any follow-up action",
  "You are the forked subagent; continue executing your task.",
  "Your previous response was interrupted. Continue from where you left off.",
];

interface UserText {
  text: string;
  /** The `<timestamp>` string as written, or null when the block has none. */
  timestampText: string | null;
  /** Tags beside the query: `image_files`, `external_links`, … */
  tags: string[];
  wrapped: boolean;
  injected: boolean;
}

function parseUserText(raw: string): UserText {
  const ts = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(raw);
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(raw);
  const tags: string[] = [];
  for (const tag of ["image_files", "external_links"]) if (raw.includes(`<${tag}>`)) tags.push(tag);
  const text = query !== null ? query[1]! : raw.trim();
  const firstLine = text.split("\n")[0]!.trim();
  return {
    text,
    timestampText: ts !== null ? ts[1]!.trim() : null,
    tags,
    wrapped: query !== null,
    injected: INJECTED_OPENINGS.some((opening) => firstLine.startsWith(opening)),
  };
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

interface PathIds {
  sessionId: string | null;
  parentSessionId: string | null;
  projectSlug: string | null;
}

/**
 * `<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` names the session by its
 * file; `<slug>/agent-transcripts/<parent>/subagents/<uuid>.jsonl` names
 * the parent too. The slug is taken only when the layout is Cursor's.
 */
function idsFromPath(path: string | undefined): PathIds {
  if (path === undefined) return { sessionId: null, parentSessionId: null, projectSlug: null };
  const stem = basename(path).replace(/\.jsonl$/i, "");
  const sessionId = SAFE_ID.test(stem) && stem !== "." && stem !== ".." ? stem : null;
  const d1 = dirname(path);
  const d2 = dirname(d1);
  const d3 = dirname(d2);
  const d4 = dirname(d3);
  if (basename(d1) === "subagents") {
    const parent = basename(d2);
    return {
      sessionId,
      parentSessionId: SAFE_ID.test(parent) ? parent : null,
      projectSlug: basename(d3) === "agent-transcripts" ? basename(d4) : null,
    };
  }
  return {
    sessionId,
    parentSessionId: null,
    projectSlug: basename(d2) === "agent-transcripts" ? basename(d3) : null,
  };
}

export const cursorAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  /**
   * The first records are conversation records with only `role` and
   * `message` at the top, or `turn_ended` markers. No record carries the
   * keys every other JSONL format agit reads puts on its own (`uuid`,
   * `parentUuid`, `sessionId`, `projectHash`, `protocol_version`), and at
   * least one conversation record has to be there: markers alone name
   * nothing. A record of some other shape is tolerated here and counted at
   * import, the way an unmapped record is everywhere else.
   */
  detect(lines: string[]): boolean {
    let conversation = 0;
    let seen = 0;
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (++seen > 25) break;
      const r = parseLine(line);
      if (r === undefined) return false;
      for (const key of ["uuid", "parentUuid", "sessionId", "projectHash", "protocol_version"]) {
        if (r[key] !== undefined) return false;
      }
      if (isConversation(r)) conversation++;
    }
    return conversation > 0;
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };
    const kept = lines.filter((l) => l.trim() !== "");

    const ids = idsFromPath(opts?.path);
    const sessionId =
      ids.sessionId ??
      `cursor-${createHash("sha256")
        .update(kept[0] ?? "", "utf8")
        .digest("hex")
        .slice(0, 12)}`;
    if (ids.sessionId === null) skip("session-id-derived-without-path");

    // The clock: user blocks' <timestamp> strings, in order. The first one
    // dates the session; an assistant record has no time of its own and
    // takes the last one seen.
    const parsed = kept.map(parseLine);
    let ts: string | null = null;
    for (const r of parsed) {
      if (r === undefined || !isConversation(r) || r.role !== "user") continue;
      for (const b of (asRec(r.message)!.content as Json[]).map(asRec)) {
        if (b === undefined || b.type !== "text" || typeof b.text !== "string") continue;
        const t = parseUserText(b.text).timestampText;
        const iso = t === null ? null : parseCursorTimestamp(t);
        if (iso !== null) {
          ts = iso;
          break;
        }
      }
      if (ts !== null) break;
    }
    if (ts === null) throw new Error("this transcript carries no timestamp agit can read");

    const drafts: DraftEvent[] = [];
    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime: "cursor",
        // The transcript names no Cursor version. Absent, not guessed.
        runtimeVersion: null,
        nativeSessionId: sessionId,
        // The project slug is not reversible into a working directory.
        cwd: null,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: {
          kind: ids.parentSessionId !== null ? "subagent" : "main",
          ...(ids.parentSessionId !== null ? { parentSessionId: ids.parentSessionId } : {}),
          ...(ids.projectSlug !== null ? { projectSlug: ids.projectSlug } : {}),
        },
      },
    });

    parsed.forEach((r, line) => {
      if (r === undefined) {
        skip("unparseable-line");
        return;
      }
      if (isTurnEnded(r)) {
        skip(`turn-ended:${str(r.status) ?? "(absent)"}`);
        return;
      }
      if (!isConversation(r)) {
        skip("unknown-record");
        return;
      }
      const blocks = (asRec(r.message)!.content as Json[]).map(asRec);
      if (r.role === "user") {
        for (const b of blocks) {
          if (b === undefined) {
            skip("user-block-unreadable");
            continue;
          }
          if (b.type !== "text" || typeof b.text !== "string") {
            skip(`user-block:${str(b.type) ?? "(absent)"}`);
            continue;
          }
          const u = parseUserText(b.text);
          if (u.timestampText === null) {
            skip("user-timestamp-absent");
          } else {
            const iso = parseCursorTimestamp(u.timestampText);
            if (iso === null) skip("user-timestamp-unreadable");
            else ts = iso;
          }
          drafts.push({
            ts: ts!,
            type: "message.user",
            payload: {
              text: u.text,
              native: {
                line,
                ...(u.timestampText !== null ? { timestampText: u.timestampText } : {}),
                ...(u.tags.length > 0 ? { tags: u.tags } : {}),
                ...(u.wrapped ? {} : { unwrapped: true }),
                ...(u.injected ? { injected: true } : {}),
              },
            },
          });
        }
        return;
      }
      const texts: Json[] = [];
      const calls: DraftEvent[] = [];
      blocks.forEach((b, index) => {
        if (b === undefined) {
          skip("assistant-block-unreadable");
          return;
        }
        if (b.type === "text" && typeof b.text === "string") {
          if (b.text !== "") texts.push({ type: "text", text: b.text });
          return;
        }
        if (b.type === "tool_use") {
          const input = asRec(b.input);
          calls.push({
            ts: ts!,
            type: "tool.call",
            payload: {
              // Cursor gives a call no id, and records no result to pair it with.
              toolUseId: null,
              name: str(b.name) ?? "unknown",
              // ApplyPatch's input is the patch text itself; every other tool's is an object.
              input: input ?? (typeof b.input === "string" ? { patch: b.input } : {}),
              native: {
                line,
                block: index,
                ...(input === undefined && typeof b.input === "string" ? { inputWasString: true } : {}),
              },
            },
          });
          return;
        }
        skip(`assistant-block:${str(b.type) ?? "(absent)"}`);
      });
      if (texts.length > 0) {
        drafts.push({
          ts: ts!,
          type: "message.assistant",
          payload: { model: null, blocks: texts, stopReason: null, native: { line } },
        });
      }
      drafts.push(...calls);
    });

    if (!opts?.live) {
      drafts.push({ ts: ts!, type: "session.end", payload: { reason: "transcript-end", synthesized: true } });
    }
    return { sessionId, drafts, records: kept.length, skipped };
  },
};
