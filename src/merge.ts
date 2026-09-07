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
 * are reported, never hidden. Deletions are out of scope: the fork tree
 * only records files the log could reconstruct, so a file absent from the
 * fork is "untouched", not "deleted".
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
import type { AgitEvent } from "./format/events.js";
import { reconstructTree, treeRelativePath } from "./fork.js";

export type MergeOutcome =
  | "unchanged" // fork == base: nothing to do
  | "kept-ours" // fork == base != ours: target already moved; keep it
  | "took-fork" // ours == base != fork: fast-forward to the fork's version
  | "identical" // ours == fork (both changed the same way)
  | "added" // new in the fork, absent in target: copied in
  | "clean-merge" // three-way merge succeeded
  | "conflict"; // markers written, human finishes the job

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

export function mergeFork(opts: {
  forkDir: string;
  intoDir: string;
  sourceEvents: AgitEvent[];
  summary?: string;
}): { results: MergeFileResult[]; conflicts: number } {
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
  for (const rel of listTreeFiles(treeRoot)) {
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
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { results, conflicts };
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
