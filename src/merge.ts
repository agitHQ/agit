/**
 * `agit merge <forkDir>` — bring a fork's file changes back (milestone 3,
 * issue #3). File-level and honest, exactly as the README promises: an
 * ordinary git three-way merge per file, with the fork point as the base —
 * not a merge of two minds.
 *
 * base   = the file at the fork point, reconstructed (hash-verified) from
 *          the SOURCE session's log in the store
 * ours   = the file in the target directory today (it may have moved on)
 * theirs = the file in the fork's tree/ (as the forked session left it)
 *
 * Trivial cases resolve without git (unchanged / only-one-side-changed);
 * real three-way content merges shell out to `git merge-file`, the canonical
 * implementation. Conflicts leave standard markers in the target file and
 * are reported, never hidden.
 *
 * Absence from the fork tree still means "untouched", never "deleted" — the
 * tree only records what the log could reconstruct. A deletion is only ever
 * honoured when the fork's own session says so: pass `--session <id>` and
 * every `file.delete` after the fork point is considered, against both the
 * base it claims to remove and what the target holds today (#88).
 *
 * The merge is recorded in the fork directory itself (merge.json): when,
 * into where, per-file outcomes, and the human-written summary of what the
 * fork learned.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgitEvent, Json } from "./format/events.js";
import { sha256Hex } from "./format/hash.js";
import { reconstructTree, treeRelativePath } from "./fork.js";

export type MergeOutcome =
  | "unchanged" // fork == base: nothing to do
  | "kept-ours" // fork == base != ours: target already moved; keep it
  | "took-fork" // ours == base != fork: fast-forward to the fork's version
  | "identical" // ours == fork (both changed the same way)
  | "added" // new in the fork, absent in target: copied in
  | "clean-merge" // three-way merge succeeded
  | "conflict" // markers written, human finishes the job
  | "deleted" // the fork's session deleted it and the target had not moved on
  | "kept-ours-deleted"; // the fork deleted it, but the target changed it since

export interface MergeFileResult {
  rel: string;
  outcome: MergeOutcome;
}

export interface ForkInfo {
  sourceSession: string;
  atSeq: number;
  atHash: string;
}

export function readForkInfo(forkDir: string): ForkInfo {
  const raw = JSON.parse(readFileSync(join(forkDir, "fork.json"), "utf8")) as Record<string, unknown>;
  if (
    typeof raw.sourceSession !== "string" ||
    typeof raw.atSeq !== "number" ||
    typeof raw.atHash !== "string"
  ) {
    throw new Error("fork.json is missing sourceSession/atSeq/atHash");
  }
  return { sourceSession: raw.sourceSession, atSeq: raw.atSeq, atHash: raw.atHash };
}

/** Every file under the fork's tree/, as forward-slashed relative paths. */
export function listTreeFiles(treeRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(treeRoot, abs).replace(/\\/g, "/"));
    }
  };
  if (existsSync(treeRoot)) walk(treeRoot);
  return out.sort();
}

/** Base contents at the fork point, keyed by the same tree-relative paths fork used. */
export function baseTreeAt(sourceEvents: AgitEvent[], atSeq: number): Map<string, string> {
  const start = sourceEvents[0]!.payload as { cwd?: unknown };
  const cwd = typeof start.cwd === "string" ? start.cwd : null;
  const { files } = reconstructTree(sourceEvents, atSeq);
  const map = new Map<string, string>();
  for (const f of files) map.set(treeRelativePath(f.path, cwd), f.content);
  return map;
}

/**
 * Deletions the fork's own session recorded after the fork point.
 *
 * A `file.delete` carries the hash of the content it removed, so a deletion
 * can be checked twice before anything is removed from the target: the
 * removed content must be what the base tree actually held at the fork point,
 * and the target must still hold that same content today. Either check
 * failing means the deletion is reported, not performed.
 *
 * Renames land here as a delete plus a create, so they merge as a deletion of
 * the old path and an addition of the new one, with no special case.
 */
function deletionsAfter(forkEvents: AgitEvent[], atSeq: number, cwd: string | null): Map<string, string> {
  const out = new Map<string, string>(); // tree-relative path -> claimed beforeHash
  for (const e of forkEvents) {
    if (e.seq <= atSeq) continue;
    if (e.type === "file.delete") {
      const p = e.payload as { path?: Json; beforeHash?: Json };
      if (typeof p.path !== "string" || typeof p.beforeHash !== "string") continue;
      out.set(treeRelativePath(p.path, cwd), p.beforeHash);
      continue;
    }
    // A later edit or re-create of the same path retracts the deletion.
    if (e.type === "file.diff") {
      const p = e.payload as { path?: Json };
      if (typeof p.path === "string") out.delete(treeRelativePath(p.path, cwd));
    }
  }
  return out;
}

export function mergeFork(opts: {
  forkDir: string;
  intoDir: string;
  sourceEvents: AgitEvent[];
  summary?: string;
  /**
   * The fork's own session, once imported. Its `file.delete` events after the
   * fork point are the only thing that can make a merge remove a file (#88).
   */
  forkEvents?: AgitEvent[];
}): { results: MergeFileResult[]; conflicts: number; deleted: number } {
  const info = readForkInfo(opts.forkDir);
  if (opts.sourceEvents[info.atSeq]?.hash !== info.atHash) {
    throw new Error(
      `fork point does not match the source session in the store: ` +
        `fork.json says event ${info.atSeq} = ${info.atHash.slice(0, 12)}…, the log disagrees`,
    );
  }
  const base = baseTreeAt(opts.sourceEvents, info.atSeq);
  const treeRoot = resolve(opts.forkDir, "tree");
  const intoRoot = resolve(opts.intoDir);

  const results: MergeFileResult[] = [];
  let conflicts = 0;
  let deleted = 0;

  // Deletions first, so a path the fork removed is not also content-merged
  // from a stale tree entry.
  const cwd =
    typeof (opts.sourceEvents[0]!.payload as { cwd?: unknown }).cwd === "string"
      ? ((opts.sourceEvents[0]!.payload as { cwd?: string }).cwd as string)
      : null;
  const pendingDeletes = opts.forkEvents ? deletionsAfter(opts.forkEvents, info.atSeq, cwd) : new Map();
  // The fork tree is the state AT the fork point, so it still holds every file
  // the fork later deleted -- its presence there says nothing. A retraction is
  // a later file.diff in the fork's own session, which deletionsAfter already
  // drops. Paths removed here are skipped by the content pass below, so a
  // deleted file is not immediately re-added from the fork-point tree.
  const removed = new Set<string>();
  for (const [rel, claimedHash] of pendingDeletes) {
    const target = resolve(intoRoot, rel);
    if (!target.startsWith(intoRoot + sep)) throw new Error(`refusing path escape: ${rel}`);
    const baseContent = base.get(rel);
    // Nothing to check the deletion against: the base tree never held this
    // path, so agit cannot say the fork removed the same thing the target has.
    if (baseContent === undefined) continue;
    if (sha256Hex(baseContent) !== claimedHash) {
      // The fork removed content that is not what the fork point held, so the
      // file had already drifted. Report it; do not delete on a mismatch.
      results.push({ rel, outcome: "kept-ours-deleted" });
      removed.add(rel);
      conflicts++;
      continue;
    }
    if (!existsSync(target)) {
      results.push({ rel, outcome: "unchanged" }); // already gone in the target
      continue;
    }
    if (readFileSync(target, "utf8") !== baseContent) {
      // The target moved on since the fork point; a deletion would throw that
      // work away silently. Leave the file and say so.
      results.push({ rel, outcome: "kept-ours-deleted" });
      removed.add(rel);
      conflicts++;
      continue;
    }
    rmSync(target, { force: true });
    results.push({ rel, outcome: "deleted" });
    removed.add(rel);
    deleted++;
  }

  for (const rel of listTreeFiles(treeRoot)) {
    if (removed.has(rel)) continue; // just deleted; do not re-add it from the tree
    const target = resolve(intoRoot, rel);
    if (!target.startsWith(intoRoot + sep)) throw new Error(`refusing path escape: ${rel}`);
    const theirs = readFileSync(join(treeRoot, rel), "utf8");
    const baseContent = base.get(rel) ?? null;
    const ours = existsSync(target) ? readFileSync(target, "utf8") : null;

    let outcome: MergeOutcome;
    if (baseContent !== null && theirs === baseContent) {
      // The fork never touched this file. Whatever the target did — kept it,
      // changed it, even deleted it — stands.
      outcome = ours === null || ours === baseContent ? "unchanged" : "kept-ours";
    } else if (ours === null) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, theirs, "utf8");
      outcome = "added";
    } else if (ours === theirs) {
      outcome = "identical";
    } else if (baseContent !== null && ours === baseContent) {
      writeFileSync(target, theirs, "utf8");
      outcome = "took-fork";
    } else {
      const merged = gitMergeFile(baseContent ?? "", ours, theirs);
      writeFileSync(target, merged.content, "utf8");
      outcome = merged.clean ? "clean-merge" : "conflict";
      if (!merged.clean) conflicts++;
    }
    results.push({ rel, outcome });
  }

  writeFileSync(
    join(opts.forkDir, "merge.json"),
    JSON.stringify(
      {
        mergedAt: new Date().toISOString(),
        into: intoRoot,
        sourceSession: info.sourceSession,
        atSeq: info.atSeq,
        summary: opts.summary ?? null,
        results,
        conflicts,
        deleted,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { results, conflicts, deleted };
}

/** Ordinary git three-way merge on one file. Markers labeled ours/base/fork. */
export function gitMergeFile(
  base: string,
  ours: string,
  theirs: string,
): { content: string; clean: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "agit-merge-"));
  try {
    const b = join(dir, "base");
    const o = join(dir, "ours");
    const t = join(dir, "fork");
    writeFileSync(b, base, "utf8");
    writeFileSync(o, ours, "utf8");
    writeFileSync(t, theirs, "utf8");
    // No -p: git merge-file writes the result into its first argument. Piping
    // it through stdout instead ran into execFileSync's 1 MB maxBuffer, so any
    // file whose merged form crossed that died with a bare `spawnSync git
    // ENOBUFS` — mid-merge, after earlier files had already been written.
    // Reading the file back has no size ceiling to pick.
    try {
      execFileSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "fork", o, b, t], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      return { content: readFileSync(o, "utf8"), clean: true };
    } catch (err) {
      const e = err as { status?: number | null; code?: string };
      if (e.code === "ENOENT") {
        throw new Error("git is required for three-way merges (`git merge-file`) and was not found on PATH", {
          cause: err,
        });
      }
      // git merge-file exits with the number of conflicts; the file it wrote
      // holds the merged content with markers.
      if (typeof e.status === "number" && e.status > 0 && e.status < 128) {
        return { content: readFileSync(o, "utf8"), clean: false };
      }
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
