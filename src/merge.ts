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
 * implementation. Conflicts leave standard markers in the target file (a
 * binary file is left as the target had it, as git does) and are reported,
 * never hidden.
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
import { reconstructTree, treeRelativePathOrNull } from "./fork.js";
import { merge3 } from "./merge3.js";

export type MergeOutcome =
  | "unchanged" // fork == base: nothing to do
  | "kept-ours" // fork == base != ours: target already moved; keep it
  | "took-fork" // ours == base != fork: fast-forward to the fork's version
  | "identical" // ours == fork (both changed the same way)
  | "added" // new in the fork, absent in target: copied in
  | "clean-merge" // three-way merge succeeded
  | "conflict" // markers written (binary: target left as is), human finishes the job
  | "deleted" // the fork's session deleted it and the target had not moved on
  | "kept-ours-deleted"; // the fork deleted it, but the target changed it since

export interface MergeFileResult {
  rel: string;
  outcome: MergeOutcome;
  /** On a conflict: the file is binary, so no markers were written and the target's copy stands. */
  binary?: true;
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
  for (const f of files) {
    // A path that sanitizes to nothing was never written into the fork's
    // tree either (writeFork skipped it), so it has nothing to merge.
    const rel = treeRelativePathOrNull(f.path, cwd);
    if (rel !== null) map.set(rel, f.content);
  }
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
      const rel = treeRelativePathOrNull(p.path, cwd);
      if (rel !== null) out.set(rel, p.beforeHash);
      continue;
    }
    // A later edit or re-create of the same path retracts the deletion.
    if (e.type === "file.diff") {
      const p = e.payload as { path?: Json };
      const rel = typeof p.path === "string" ? treeRelativePathOrNull(p.path, cwd) : null;
      if (rel !== null) out.delete(rel);
    }
  }
  return out;
}

/**
 * git's own test for a binary file: a NUL byte in the first 8000 bytes.
 * `git merge-file` refuses such a file outright, so the same cut-off decides
 * for both engines.
 */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
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
  /** Force the built-in three-way merge even where git is available (#89). */
  noGit?: boolean;
}): {
  results: MergeFileResult[];
  conflicts: number;
  deleted: number;
  engines: ("git" | "builtin")[];
} {
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
  const enginesUsed = new Set<"git" | "builtin">();
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
    // Bytes, not text: the tree and the target hold whatever the agent and
    // the people around it wrote, images and Latin-1 files included, and a
    // UTF-8 round trip turns every invalid byte into U+FFFD.
    const theirs = readFileSync(join(treeRoot, rel));
    const baseText = base.get(rel);
    const baseContent = baseText === undefined ? null : Buffer.from(baseText, "utf8");
    const ours = existsSync(target) ? readFileSync(target) : null;

    let outcome: MergeOutcome;
    if (baseContent !== null && theirs.equals(baseContent)) {
      // The fork never touched this file. Whatever the target did — kept it,
      // changed it, even deleted it — stands.
      outcome = ours === null || ours.equals(baseContent) ? "unchanged" : "kept-ours";
    } else if (ours === null) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, theirs);
      outcome = "added";
    } else if (ours.equals(theirs)) {
      outcome = "identical";
    } else if (baseContent !== null && ours.equals(baseContent)) {
      writeFileSync(target, theirs);
      outcome = "took-fork";
    } else if (
      looksBinary(ours) ||
      looksBinary(theirs) ||
      (baseContent !== null && looksBinary(baseContent))
    ) {
      // Neither engine can merge this: git refuses it, which used to abort
      // the whole merge partway, and the built-in merge would write text
      // markers into it. Do what git does with a binary conflict: leave the
      // target's copy alone and report it.
      results.push({ rel, outcome: "conflict", binary: true });
      conflicts++;
      continue;
    } else {
      // latin1 maps each byte to one character and back, so either engine
      // merges the files' exact bytes whatever their encoding. Both split
      // lines on "\n", which never occurs inside a multi-byte UTF-8
      // sequence, so UTF-8 text merges exactly as it would decoded.
      const merged = mergeFileContents(
        (baseContent ?? Buffer.alloc(0)).toString("latin1"),
        ours.toString("latin1"),
        theirs.toString("latin1"),
        { noGit: opts.noGit, encoding: "latin1" },
      );
      enginesUsed.add(merged.engine);
      writeFileSync(target, merged.content, "latin1");
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
        // Which implementation resolved the content merges, so a merge that
        // ran without git is identifiable after the fact.
        engine: enginesUsed.size === 0 ? null : [...enginesUsed].sort().join("+"),
        results,
        conflicts,
        deleted,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { results, conflicts, deleted, engines: [...enginesUsed] };
}

/** Raised when `git merge-file` is not on PATH, so the caller can fall back rather than fail. */
export class GitNotFound extends Error {
  constructor() {
    super("git merge-file was not found on PATH");
  }
}

export interface MergeEngineResult {
  content: string;
  clean: boolean;
  /** Which implementation produced this, so the CLI can say so. */
  engine: "git" | "builtin";
}

/**
 * Three-way merge one file, preferring git.
 *
 * git is the implementation everyone's expectations are calibrated against,
 * so results stay identical to what people are used to wherever it exists.
 * The built-in diff3 is the fallback (#89): without it, a machine with no git
 * on PATH turns `agit merge` into a hard failure at the last step of a
 * handoff. `noGit` forces the fallback, which is also how its behaviour is
 * tested against git's on the same inputs.
 *
 * `encoding` is how the strings map to the bytes git sees. mergeFork passes
 * latin1 strings, one character per byte, so a file's bytes pass through
 * untouched; the built-in merge works on the strings either way.
 */
export function mergeFileContents(
  base: string,
  ours: string,
  theirs: string,
  opts: { noGit?: boolean; encoding?: BufferEncoding } = {},
): MergeEngineResult {
  if (!opts.noGit) {
    try {
      return { ...gitMergeFile(base, ours, theirs, opts.encoding), engine: "git" };
    } catch (err) {
      if (!(err instanceof GitNotFound)) throw err;
    }
  }
  const r = merge3(base, ours, theirs);
  return { content: r.content, clean: r.clean, engine: "builtin" };
}

/** Ordinary git three-way merge on one file. Markers labeled ours/base/fork. */
export function gitMergeFile(
  base: string,
  ours: string,
  theirs: string,
  encoding: BufferEncoding = "utf8",
): { content: string; clean: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "agit-merge-"));
  try {
    const b = join(dir, "base");
    const o = join(dir, "ours");
    const t = join(dir, "fork");
    writeFileSync(b, base, encoding);
    writeFileSync(o, ours, encoding);
    writeFileSync(t, theirs, encoding);
    // No -p: git merge-file writes the result into its first argument. Piping
    // it through stdout instead ran into execFileSync's 1 MB maxBuffer, so any
    // file whose merged form crossed that died with a bare `spawnSync git
    // ENOBUFS` — mid-merge, after earlier files had already been written.
    // Reading the file back has no size ceiling to pick.
    try {
      execFileSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "fork", o, b, t], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      return { content: readFileSync(o, encoding), clean: true };
    } catch (err) {
      const e = err as { status?: number | null; code?: string };
      if (e.code === "ENOENT") throw new GitNotFound();
      // git merge-file exits with the number of conflicts; the file it wrote
      // holds the merged content with markers.
      if (typeof e.status === "number" && e.status > 0 && e.status < 128) {
        return { content: readFileSync(o, encoding), clean: false };
      }
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
