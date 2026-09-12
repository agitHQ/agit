/**
 * `agit fork <id> --at N` — branch a session at event N (roadmap milestone 3,
 * issue #2). Honestly lossy, exactly as the README promises:
 *
 * FILESYSTEM — reconstructed from the log and verified. Every file.diff up
 * to N is replayed: creates seed content, modifies apply as unified diffs,
 * and every step must reproduce the event's afterHash or the chain for that
 * file is abandoned. When a patch chain breaks (the file pre-existed the
 * session, or DIVERGED via untracked edits), recovery is attempted from the
 * matching tool.result's structured originalFile — the runtime recorded the
 * full pre-edit content, so most such files come back, still hash-verified.
 * What cannot be verified is not written; it is listed.
 *
 * CONTEXT — not transplantable into a running agent. The fork gets SEED.md,
 * a mechanical extract (no model calls, fully deterministic): provenance,
 * the task's opening message, the last exchanges before N verbatim, file
 * state, and usage. Anyone claiming more is selling something.
 *
 * Paths from session logs are untrusted input: tree paths are re-rooted
 * under out/tree, relative to the session's recorded cwd where possible,
 * and any segment that would escape the fork directory is rejected.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AgitEvent, Json } from "./format/events.js";
import { sha256Hex } from "./format/hash.js";
import { applyUnifiedDiff, PatchError } from "./patch.js";
import { eventLine, fileStateAt, usageTotals } from "./state.js";

export interface ForkFile {
  path: string;
  content: string;
  verified: true; // only hash-verified content is ever returned
  recoveredFromOriginalFile: boolean;
}

export interface ForkSkip {
  path: string;
  reason: string;
}

export interface TreeReconstruction {
  files: ForkFile[];
  skipped: ForkSkip[];
}

interface DiffPayload {
  path?: Json;
  kind?: Json;
  diff?: Json;
  beforeHash?: Json;
  afterHash?: Json;
  toolUseId?: Json;
}

/** Full originalFile content from the tool.result matching a file.diff, if the runtime recorded one. */
function originalFileFor(events: AgitEvent[], toolUseId: string, at: number): string | null {
  for (const e of events) {
    if (e.seq > at) break;
    if (e.type !== "tool.result") continue;
    const p = e.payload as { toolUseId?: Json; structured?: Json };
    if (p.toolUseId !== toolUseId) continue;
    const s = p.structured;
    if (s !== null && typeof s === "object" && !Array.isArray(s) && typeof s.originalFile === "string") {
      return s.originalFile;
    }
  }
  return null;
}

export function reconstructTree(events: AgitEvent[], at: number): TreeReconstruction {
  const content = new Map<string, string>(); // path -> verified content
  const broken = new Map<string, string>(); // path -> reason (chain abandoned)
  const recovered = new Set<string>();

  for (const e of events) {
    if (e.seq > at) break;
    if (e.type === "file.delete") {
      const p = e.payload as { path?: Json };
      if (typeof p.path === "string") {
        content.delete(p.path);
        broken.delete(p.path);
        recovered.delete(p.path);
      }
      continue;
    }

    if (e.type !== "file.diff") continue;
    const p = e.payload as DiffPayload;
    if (typeof p.path !== "string" || typeof p.afterHash !== "string" || typeof p.diff !== "string") continue;
    const path = p.path;

    let base: string | null = content.get(path) ?? null;
    const diverged = base !== null && typeof p.beforeHash === "string" && sha256Hex(base) !== p.beforeHash;
    if (diverged) base = null; // our chain no longer matches reality
    if (base === null && p.kind !== "create") {
      // Pre-existing or diverged file: recover the full pre-edit content the
      // runtime recorded, if any — and only trust it if it hashes right.
      const orig = typeof p.toolUseId === "string" ? originalFileFor(events, p.toolUseId, at) : null;
      if (orig !== null && (typeof p.beforeHash !== "string" || sha256Hex(orig) === p.beforeHash)) {
        base = orig;
        recovered.add(path);
      } else {
        content.delete(path);
        // Three different situations used to read as one. Name the real one,
        // and when the payload carries a redaction marker say so: a redacted
        // diff or originalFile can never reproduce the hash recorded before
        // redaction, and that is the cause, not a missing record.
        const why =
          orig === null
            ? "no recorded originalFile to recover from"
            : "the recorded originalFile does not hash to beforeHash";
        const redacted =
          p.diff.includes("[REDACTED:") || (orig !== null && orig.includes("[REDACTED:"))
            ? " — content was redacted on import, so its recorded hash cannot be reproduced"
            : "";
        broken.set(
          path,
          (diverged ? `diverged at seq ${e.seq}, ${why}` : `first seen as a modify at seq ${e.seq}, ${why}`) +
            redacted,
        );
        continue;
      }
    }

    let next: string;
    try {
      next = applyUnifiedDiff(p.kind === "create" ? null : base, p.diff);
    } catch (err) {
      content.delete(path);
      broken.set(
        path,
        `patch failed at seq ${e.seq}: ${err instanceof PatchError ? err.message : String(err)}`,
      );
      continue;
    }
    if (sha256Hex(next) !== p.afterHash) {
      content.delete(path);
      broken.set(
        path,
        `reconstruction did not match afterHash at seq ${e.seq}` +
          (p.diff.includes("[REDACTED:")
            ? " — content was redacted on import, so its recorded hash cannot be reproduced"
            : ""),
      );
      continue;
    }
    broken.delete(path);
    content.set(path, next);
  }

  const files = [...content.entries()].map(([path, c]) => ({
    path,
    content: c,
    verified: true as const,
    recoveredFromOriginalFile: recovered.has(path),
  }));
  const skipped = [...broken.entries()].map(([path, reason]) => ({ path, reason }));
  return { files, skipped };
}

/** Re-root an untrusted log path safely under the fork's tree directory. */
export function treeRelativePath(filePath: string, cwd: string | null): string {
  let p = filePath.replace(/\\/g, "/");
  const c = cwd ? cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/" : null;
  if (c && p.toLowerCase().startsWith(c.toLowerCase())) p = p.slice(c.length);
  const segments = p
    .split("/")
    .map((s) => s.replace(/^[A-Za-z]:$/, (m) => m[0]!)) // drive letter -> plain segment
    .filter((s) => s !== "" && s !== "." && s !== "..")
    // eslint-disable-next-line no-control-regex -- deliberately strips control chars from untrusted log paths
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, "_"));
  if (segments.length === 0) throw new Error(`unusable path in log: ${JSON.stringify(filePath)}`);
  return segments.join("/");
}

/**
 * The same, for callers that would rather count a path than fail on it: a
 * log can name "/", "." or a path of nothing but separators, and one such
 * file should cost the fork, diff or merge that one file, not the whole
 * operation.
 */
export function treeRelativePathOrNull(filePath: string, cwd: string | null): string | null {
  try {
    return treeRelativePath(filePath, cwd);
  } catch {
    return null;
  }
}

export interface ForkResult {
  outDir: string;
  written: { rel: string; source: string; recovered: boolean }[];
  skipped: ForkSkip[];
}

export function writeFork(
  events: AgitEvent[],
  at: number,
  sourceSession: string,
  outDir: string,
): ForkResult {
  const atEvent = events[at]!;
  const start = events[0]!.payload as { cwd?: Json };
  const cwd = typeof start.cwd === "string" ? start.cwd : null;
  const { files, skipped } = reconstructTree(events, at);

  const treeRoot = resolve(outDir, "tree");
  mkdirSync(treeRoot, { recursive: true });
  const written: ForkResult["written"] = [];
  for (const f of files) {
    const rel = treeRelativePathOrNull(f.path, cwd);
    if (rel === null) {
      skipped.push({ path: f.path, reason: "path sanitizes to nothing; cannot be placed in a tree" });
      continue;
    }
    const abs = resolve(treeRoot, rel);
    if (!abs.startsWith(treeRoot + sep)) throw new Error(`refusing path escape: ${f.path}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
    written.push({ rel, source: f.path, recovered: f.recoveredFromOriginalFile });
  }

  writeFileSync(join(outDir, "SEED.md"), buildSeed(events, at, sourceSession, written, skipped), "utf8");
  writeFileSync(
    join(outDir, "fork.json"),
    JSON.stringify(
      {
        agitFork: 1,
        sourceSession,
        atSeq: at,
        atHash: atEvent.hash,
        atTs: atEvent.ts,
        headSeqAtFork: events.length - 1,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { outDir, written, skipped };
}

/**
 * A free-text block for SEED.md: truncated, never reflowed.
 *
 * `excerpt` collapses every run of whitespace into a single space — it exists
 * to squeeze an event into a one-line timeline row. Running a whole user or
 * assistant message through it turned fenced code, lists, and paragraph
 * breaks into a single unreadable line, which is not the "verbatim" this
 * file's header promises and not something an agent can act on.
 */
function seedBlock(s: string, max: number): string {
  const t = s.replace(/\r\n/g, "\n").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Deterministic, model-free context seed. SPEC-honest: a summary, not a transplant. */
export function buildSeed(
  events: AgitEvent[],
  at: number,
  sourceSession: string,
  written: ForkResult["written"],
  skipped: ForkSkip[],
): string {
  const upto = events.filter((e) => e.seq <= at);
  const users = upto.filter((e) => e.type === "message.user");
  const lastEvents = upto.slice(-12);
  const u = usageTotals(events, at);
  const filesLine = [...fileStateAt(events, at).values()]
    .map(
      (f) =>
        `- ${f.kind === "create" ? "A" : "M"} ${f.path} (+${f.added} -${f.removed})` +
        (f.divergedAtSeq !== undefined ? `  [DIVERGED at seq ${f.divergedAtSeq}]` : ""),
    )
    .join("\n");

  const text = (e: AgitEvent | undefined): string => {
    if (!e) return "";
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

  return `# Fork seed — continue from a prior agent session

You are continuing work forked from agit session \`${sourceSession}\` at
event ${at} of ${events.length - 1} (${events[at]!.ts}). This file is a
mechanical summary of that session's log — not its full context. The
reconstructed working tree in ./tree reflects only structured edits the log
recorded; shell-driven changes were invisible to it.

## The task, as originally given

${seedBlock(text(users[0]), 2000) || "(no user message before the fork point)"}

## Where the session stood at the fork point

Last assistant statement:

${seedBlock(text([...upto].reverse().find((e) => e.type === "message.assistant")), 2000) || "(none)"}

Recent events:

${lastEvents.map((e) => `    ${String(e.seq).padStart(5)}  ${eventLine(e)}`).join("\n")}

## Files in ./tree (reconstructed, hash-verified)

${filesLine || "(none)"}

${written.some((w) => w.recovered) ? "Files marked recovered were rebuilt from runtime-recorded pre-edit content after their patch chain broke.\n" : ""}${
    skipped.length > 0
      ? `NOT reconstructible (fix up by hand before relying on them):\n${skipped.map((s) => `- ${s.path}: ${s.reason}`).join("\n")}\n`
      : ""
  }
## Usage up to the fork point

${u.apiMessages} API messages; tokens in=${u.inputTokens} out=${u.outputTokens}.

## Provenance

fork.json carries the source session id and the fork-point hash
(\`${events[at]!.hash.slice(0, 12)}…\`); \`agit verify\` on the source session
proves this prefix. When this fork's own session ends, import it and keep
fork.json beside it.
`;
}
