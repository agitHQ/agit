/**
 * `agit diff` — what two sessions actually did differently (issue #33).
 *
 * Fork exists so two approaches can start from one point; this is the view
 * of the result. Both halves are folds over data agit already has, so there
 * is no new event type and nothing leaves the machine:
 *
 *  - files: each side's tree reconstructed by the same verified replay fork
 *    and merge use, then compared by content hash
 *  - work: events, tool calls, and tokens per side
 *
 * File comparison inherits replay's blind spot: a file only ever touched by
 * a shell command is in neither tree, so "same" here means "the log shows no
 * difference", not "the directories are identical". Callers print that.
 */

import { createHash } from "node:crypto";
import type { AgitEvent, Json } from "./format/events.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconstructTree, treeRelativePathOrNull } from "./fork.js";
import { listTreeFiles } from "./merge.js";
import { usageTotals } from "./state.js";

export type FileVerdict =
  | "converged" // both touched it and landed on identical content
  | "diverged" // both touched it and disagree
  | "only-a" // only side A has it
  | "only-b"; // only side B has it

export interface FileComparison {
  path: string;
  verdict: FileVerdict;
  hashA: string | null;
  hashB: string | null;
}

export interface SideStats {
  label: string;
  events: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  files: number;
  /** Reconstructions the log could not verify, so the comparison is partial. */
  unreconstructible: number;
}

export interface SessionDiff {
  a: SideStats;
  b: SideStats;
  files: FileComparison[];
  /** Where both sides agree they began, when one is a fork of the other. */
  from: { seq: number; hash: string } | null;
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Tree of a session up to `at`, keyed by path relative to its own cwd. */
function treeOf(events: AgitEvent[], at: number): { files: Map<string, string>; skipped: number } {
  const start = events[0]?.payload as { cwd?: Json } | undefined;
  const cwd = typeof start?.cwd === "string" ? start.cwd : null;
  const { files, skipped } = reconstructTree(events, at);
  const map = new Map<string, string>();
  let unusable = 0;
  for (const f of files) {
    // Relative keys so two sessions with different absolute roots still line
    // up — a fork's tree and its parent's rarely share a directory. A path
    // that sanitizes to nothing cannot be keyed; it is counted with the
    // files the tree could not reconstruct rather than failing the diff.
    const rel = treeRelativePathOrNull(f.path, cwd);
    if (rel === null) unusable++;
    else map.set(rel, f.content);
  }
  return { files: map, skipped: skipped.length + unusable };
}

/** Work on one side; with `since`, only what happened after the shared point. */
function statsOf(
  events: AgitEvent[],
  at: number,
  label: string,
  files: number,
  skipped: number,
  since: number | null = null,
): SideStats {
  const upto = events.filter((e) => e.seq <= at && (since === null || e.seq > since));
  const u = usageTotals(events, at);
  const before = since === null ? null : usageTotals(events, since);
  return {
    label,
    events: upto.length,
    toolCalls: upto.filter((e) => e.type === "tool.call").length,
    inputTokens: u.inputTokens - (before?.inputTokens ?? 0),
    outputTokens: u.outputTokens - (before?.outputTokens ?? 0),
    files,
    unreconstructible: skipped,
  };
}

/** A fork's working tree as it stands on disk, keyed like a session tree. */
export function treeOnDisk(treeRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of listTreeFiles(treeRoot)) {
    map.set(rel, readFileSync(join(treeRoot, rel), "utf8"));
  }
  return map;
}

/**
 * Compare two sides. `from` records the point they share — the fork point,
 * when one branched from the other — so the header says what the comparison
 * is relative to. Side B may be another session or a directory on disk.
 */
export function diffSessions(args: {
  a: { events: AgitEvent[]; label: string; at?: number };
  b: { events?: AgitEvent[]; label: string; at?: number; tree?: Map<string, string> };
  from?: { seq: number; hash: string } | null;
}): SessionDiff {
  const atA = args.a.at ?? args.a.events.length - 1;
  const atB = args.b.at ?? (args.b.events ? args.b.events.length - 1 : 0);
  const treeA = treeOf(args.a.events, atA);
  // Side B is either another session, or a directory on disk (a fork the
  // human has been working in), in which case there are no events to count.
  const treeB = args.b.tree ? { files: args.b.tree, skipped: 0 } : treeOf(args.b.events ?? [], atB);

  const paths = [...new Set([...treeA.files.keys(), ...treeB.files.keys()])].sort();
  const files: FileComparison[] = paths.map((path) => {
    const ca = treeA.files.get(path);
    const cb = treeB.files.get(path);
    const hashA = ca === undefined ? null : sha(ca);
    const hashB = cb === undefined ? null : sha(cb);
    const verdict: FileVerdict =
      hashA === null ? "only-b" : hashB === null ? "only-a" : hashA === hashB ? "converged" : "diverged";
    return { path, verdict, hashA, hashB };
  });

  return {
    a: statsOf(args.a.events, atA, args.a.label, treeA.files.size, treeA.skipped, args.from?.seq ?? null),
    b: args.b.events
      ? statsOf(args.b.events, atB, args.b.label, treeB.files.size, treeB.skipped, args.from?.seq ?? null)
      : {
          label: args.b.label,
          events: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          files: treeB.files.size,
          unreconstructible: 0,
        },
    files,
    from: args.from ?? null,
  };
}

/** Human-readable rendering; the CLI prints exactly this. */
export function renderDiff(d: SessionDiff): string[] {
  const out: string[] = [];
  out.push(
    d.from
      ? `${d.a.label} vs ${d.b.label} — from event ${d.from.seq} (${d.from.hash.slice(0, 12)})`
      : `${d.a.label} vs ${d.b.label}`,
  );

  out.push("");
  out.push("  files");
  if (d.files.length === 0) {
    out.push("    (no reconstructible file edits on either side)");
  } else {
    const label: Record<FileVerdict, string> = {
      converged: "both, same result",
      diverged: "both, differs   ",
      "only-a": `only ${d.a.label}`,
      "only-b": `only ${d.b.label}`,
    };
    for (const f of d.files) {
      const detail =
        f.verdict === "diverged"
          ? `  ${d.a.label} ${f.hashA!.slice(0, 8)} / ${d.b.label} ${f.hashB!.slice(0, 8)}`
          : "";
      out.push(`    ${label[f.verdict].padEnd(20)} ${f.path}${detail}`);
    }
  }

  out.push("");
  out.push("  work");
  for (const s of [d.a, d.b]) {
    if (s.events === 0 && s.toolCalls === 0 && s.inputTokens === 0 && s.outputTokens === 0) {
      // A directory side has files but no session of its own to count.
      out.push(
        `    ${s.label.padEnd(20)} ${String(s.files).padStart(5)} files on disk (no session imported)`,
      );
      continue;
    }
    out.push(
      `    ${s.label.padEnd(20)} ${String(s.events).padStart(5)} events  ` +
        `${String(s.toolCalls).padStart(4)} tool calls  ` +
        `in ${s.inputTokens.toLocaleString("en-US")} out ${s.outputTokens.toLocaleString("en-US")}`,
    );
  }

  const skipped = d.a.unreconstructible + d.b.unreconstructible;
  out.push("");
  out.push(
    "  files compared by reconstructed content; a file only ever touched by a" +
      "\n  shell command is in neither tree, so same means the logs show no" +
      "\n  difference, not that the directories match (SPEC section 5.7).",
  );
  if (skipped > 0) {
    out.push(`  ${skipped} file(s) could not be reconstructed and are absent from this comparison.`);
  }
  return out;
}
