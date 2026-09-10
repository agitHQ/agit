/**
 * A base tree supplied at import (#85).
 *
 * Codex and OpenClaw record a *diff* when they update a file, not the file.
 * So agit can verify an update only for a file whose content it already holds
 * from earlier in the same session; an edit to a file that predates the
 * session is skipped and counted, never hashed on a guess.
 *
 * The runtime did not record the base, but the user usually has it: the git
 * commit the session started from, or a copy of the working tree. That is
 * real data, not a guess — and it is checked, not trusted. A supplied base
 * only ever gives an adapter a candidate for the pre-edit content; the
 * runtime's own diff still has to apply to it, and the result still has to
 * hash. A wrong base yields a skip, never a hash.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface BaseTree {
  kind: "git" | "dir";
  /** The ref or directory as the user gave it. */
  ref: string;
  /** Repo-relative, forward-slashed path -> content. */
  files: Map<string, string>;
}

export class BaseTreeError extends Error {}

/** Directories never worth reading as a base, and expensive to walk. */
const SKIP_DIRS = new Set([".git", "node_modules", ".agit"]);

function walkDir(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = join(dir, entry.name);
      try {
        // A base is only useful for text: a diff that will not apply to what
        // we read simply skips, which is the same outcome as not having it.
        files.set(relative(root, abs).split("\\").join("/"), readFileSync(abs, "utf8"));
      } catch {
        // Unreadable file: leave it out rather than fail the whole import.
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Read a git tree in two commands rather than one per file: `ls-tree` for the
 * blob ids, then a single `cat-file --batch` fed all of them on stdin.
 */
function readGitTree(ref: string, repoDir: string): Map<string, string> {
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-tree", "-r", "-z", ref], {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { code?: string; stderr?: string };
    if (e.code === "ENOENT")
      throw new BaseTreeError("git was not found on PATH, so --base <ref> cannot be read");
    throw new BaseTreeError(
      `git could not read ${JSON.stringify(ref)}: ${(e.stderr ?? "").trim() || "unknown ref"}`,
    );
  }

  // "<mode> <type> <sha>\t<path>" records, NUL-separated (-z), so paths with
  // spaces or quotes need no unquoting.
  const entries: { sha: string; path: string }[] = [];
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta[1] !== "blob" || meta[2] === undefined) continue;
    entries.push({ sha: meta[2], path: record.slice(tab + 1) });
  }
  if (entries.length === 0) return new Map();

  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoDir,
    input: entries.map((e) => e.sha).join("\n") + "\n",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as Buffer;

  // Each reply is "<sha> blob <size>\n<size bytes>\n". Sizes are in bytes, so
  // the walk is over the Buffer; only the content is decoded as text.
  const files = new Map<string, string>();
  let at = 0;
  for (const entry of entries) {
    const nl = batch.indexOf(0x0a, at);
    if (nl === -1) break;
    const header = batch.subarray(at, nl).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    const start = nl + 1;
    files.set(entry.path, batch.subarray(start, start + size).toString("utf8"));
    at = start + size + 1; // trailing newline after the object
  }
  return files;
}

/**
 * Resolve `--base`: an existing directory is read as a working tree,
 * anything else is handed to git as a ref.
 */
export function loadBaseTree(spec: string, repoDir: string): BaseTree {
  if (existsSync(spec) && statSync(spec).isDirectory()) {
    return { kind: "dir", ref: spec, files: walkDir(spec) };
  }
  return { kind: "git", ref: spec, files: readGitTree(spec, repoDir) };
}

/**
 * Seed an adapter's known-content map with a base tree, keyed the way the
 * runtime reports paths (absolute, under the session's cwd).
 *
 * Seeding does not put anything in the log: only files the runtime actually
 * edited ever produce an event. Everything else is simply available to be
 * checked against, and discarded.
 */
export function seedKnownFromBase(
  known: Map<string, string>,
  base: BaseTree | undefined,
  cwd: string | null,
): void {
  if (base === undefined || cwd === null || cwd === "") return;
  const sep = cwd.includes("\\") ? "\\" : "/";
  const root = cwd.replace(/[\\/]+$/, "");
  for (const [rel, content] of base.files) {
    if (known.has(root + sep + rel.split("/").join(sep))) continue; // the session's own content wins
    known.set(root + sep + rel.split("/").join(sep), content);
  }
}
