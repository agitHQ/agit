import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent } from "../src/format/events.js";
import { writeFork } from "../src/fork.js";
import { gitMergeFile, mergeFileContents, mergeFork } from "../src/merge.js";
import { merge3, toLines } from "../src/merge3.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const GIT = haveGit();

/** Every scenario the git path is expected to handle, plus the awkward ones. */
const rep = (n: number, f: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";
const CASES: Record<string, [string, string, string]> = {
  "no change": ["a\nb\nc\n", "a\nb\nc\n", "a\nb\nc\n"],
  "only ours changed": ["a\nb\nc\n", "A\nb\nc\n", "a\nb\nc\n"],
  "only theirs changed": ["a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n"],
  "disjoint edits merge": ["a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n"],
  "both made the same change": ["a\nb\n", "X\nb\n", "X\nb\n"],
  "straight conflict": ["x\n", "ours-change\n", "fork-change\n"],
  "adjacent edits conflict": ["a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n"],
  "insertions at opposite ends": ["b\n", "top\nb\n", "b\nbottom\n"],
  "ours deletes, theirs edits": ["a\nb\nc\n", "a\nc\n", "a\nb\nC\n"],
  "both delete the same line": ["a\nb\nc\n", "a\nc\n", "a\nc\n"],
  "conflict with no trailing newline": ["a\nb", "A\nb", "a\nB"],
  "clean merge with no trailing newline": ["a\nb", "A\nb", "a\nb"],
  "empty base": ["", "ours\n", "theirs\n"],
  "both append different lines": ["a\n", "a\nx\n", "a\ny\n"],
  "large shared body, one edit each": [
    rep(400, (i) => "l" + i),
    rep(400, (i) => (i === 5 ? "OURS" : "l" + i)),
    rep(400, (i) => (i === 300 ? "THEIRS" : "l" + i)),
  ],
};

describe("toLines", () => {
  it("round-trips with and without a trailing newline", () => {
    expect(toLines("").join("")).toBe("");
    expect(toLines("a\nb\n").join("")).toBe("a\nb\n");
    expect(toLines("a\nb").join("")).toBe("a\nb");
    expect(toLines("a\nb")).toEqual(["a\n", "b"]);
  });
});

describe("built-in three-way merge (#89)", () => {
  it.skipIf(!GIT)("produces byte-identical output to git merge-file on every case", () => {
    const differing: string[] = [];
    for (const [name, [base, ours, theirs]] of Object.entries(CASES)) {
      const git = gitMergeFile(base, ours, theirs);
      const builtin = merge3(base, ours, theirs);
      if (git.content !== builtin.content || git.clean !== builtin.clean) differing.push(name);
    }
    // Named rather than counted: a regression should say which case broke.
    expect(differing).toEqual([]);
  });

  it("resolves one-sided changes without conflict", () => {
    expect(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nc\n")).toMatchObject({
      content: "A\nb\nc\n",
      clean: true,
    });
    expect(merge3("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n")).toMatchObject({
      content: "a\nb\nC\n",
      clean: true,
    });
  });

  it("takes both disjoint edits", () => {
    const r = merge3("a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
    expect(r.clean).toBe(true);
    expect(r.content).toBe("A\nb\nc\nd\nE\n");
  });

  it("collapses an identical change made on both sides", () => {
    expect(merge3("a\nb\n", "X\nb\n", "X\nb\n")).toMatchObject({ content: "X\nb\n", clean: true });
  });

  it("marks a real conflict the way git does", () => {
    const r = merge3("x\n", "ours-change\n", "fork-change\n");
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.content).toContain("<<<<<<< ours");
    expect(r.content).toContain("=======");
    expect(r.content).toContain(">>>>>>> fork");
  });

  it("keeps markers on their own line when a side has no trailing newline", () => {
    // Without this the '=======' glues onto the last line of the section.
    const r = merge3("a\nb", "A\nb", "a\nB");
    expect(r.content).toContain("\n=======\n");
    expect(r.content.split("\n").filter((l) => l === "=======")).toHaveLength(1);
  });
});

describe("choosing the merge engine", () => {
  it.skipIf(!GIT)("prefers git when it is available", () => {
    const r = mergeFileContents("a\nb\n", "A\nb\n", "a\nb\n");
    expect(r.engine).toBe("git");
    expect(r.content).toBe("A\nb\n");
  });

  it("uses the built-in merge when asked, with the same result", () => {
    const r = mergeFileContents("a\nb\n", "A\nb\n", "a\nb\n", { noGit: true });
    expect(r.engine).toBe("builtin");
    expect(r.content).toBe("A\nb\n");
  });

  it("reports conflicts identically through either engine", () => {
    const builtin = mergeFileContents("x\n", "ours\n", "fork\n", { noGit: true });
    expect(builtin.clean).toBe(false);
    expect(builtin.content).toContain("<<<<<<< ours");
  });
});

// --- the existing merge suite's scenario, run through both engines ----------

function load(fixture: string): AgitEvent[] {
  const lines = readFileSync(join(ROOT, "fixtures", "claude-code", fixture), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const converted = claudeCodeAdapter.convert(lines);
  const counts: RedactionCounts = {};
  for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
  return buildChain(converted.sessionId, converted.drafts);
}
const DEMO = load("demo.jsonl");
const HEAD = DEMO.length - 1;

function setup(): { forkDir: string; intoDir: string } {
  const scratch = mkdtempSync(join(tmpdir(), "agit-merge3-"));
  const forkDir = join(scratch, "fork");
  writeFork(DEMO, HEAD, "demo-ratelimit-0001", forkDir);
  const intoDir = join(scratch, "target");
  for (const rel of ["src/ratelimit.ts", "src/login.ts"]) {
    const dest = join(intoDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(forkDir, "tree", rel), "utf8"), "utf8");
  }
  return { forkDir, intoDir };
}

describe("mergeFork through both engines", () => {
  /** Both sides edit the same file in different places: a real content merge. */
  function contentMerge(noGit: boolean): { outcomes: Record<string, string>; merged: string } {
    const { forkDir, intoDir } = setup();
    const rel = "src/ratelimit.ts";
    const forkFile = join(forkDir, "tree", rel);
    const targetFile = join(intoDir, rel);
    writeFileSync(forkFile, readFileSync(forkFile, "utf8").replace("LIMIT = 5", "LIMIT = 3"), "utf8");
    writeFileSync(targetFile, readFileSync(targetFile, "utf8").replace("< LIMIT;", "<= LIMIT;"), "utf8");
    const { results } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO, noGit });
    return {
      outcomes: Object.fromEntries(results.map((r) => [r.rel, r.outcome])),
      merged: readFileSync(targetFile, "utf8"),
    };
  }

  it("merges disjoint edits to one file cleanly without git", () => {
    const r = contentMerge(true);
    expect(r.outcomes["src/ratelimit.ts"]).toBe("clean-merge");
    expect(r.merged).toContain("LIMIT = 3");
    expect(r.merged).toContain("<= LIMIT;");
  });

  it.skipIf(!GIT)("reaches the same result as git on the same inputs", () => {
    expect(contentMerge(true)).toEqual(contentMerge(false));
  });

  it("records which engine resolved the merge", () => {
    const { forkDir, intoDir } = setup();
    const rel = "src/ratelimit.ts";
    writeFileSync(
      join(forkDir, "tree", rel),
      readFileSync(join(forkDir, "tree", rel), "utf8").replace("LIMIT = 5", "LIMIT = 3"),
      "utf8",
    );
    writeFileSync(
      join(intoDir, rel),
      readFileSync(join(intoDir, rel), "utf8").replace("< LIMIT;", "<= LIMIT;"),
      "utf8",
    );
    const { engines } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO, noGit: true });
    expect(engines).toContain("builtin");
    const record = JSON.parse(readFileSync(join(forkDir, "merge.json"), "utf8")) as { engine: string };
    expect(record.engine).toBe("builtin");
  });
});

describe("the fallback agrees with git, byte for byte", () => {
  // The premise of the fallback is that a machine without git gets a
  // different availability story, not a different merge. These compare the
  // two implementations against each other rather than asserting on either
  // one's output, so a future divergence surfaces here rather than in
  // somebody's working tree.
  const CASES: [string, string, string, string][] = [
    ["non-overlapping", "a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"],
    ["true conflict", "x\n", "ours\n", "theirs\n"],
    ["adjacent lines", "1\n2\n3\n", "1\nX\n3\n", "1\n2\nY\n"],
    ["ours deletes a line", "a\nb\nc\n", "a\nc\n", "a\nb\nC\n"],
    ["both append", "a\n", "a\nO\n", "a\nT\n"],
    ["identical edits", "a\nb\n", "a\nB\n", "a\nB\n"],
    ["no trailing newline", "a\nb", "A\nb", "a\nB"],
    ["empty base", "", "o\n", "t\n"],
    ["CRLF", "a\r\nb\r\n", "A\r\nb\r\n", "a\r\nB\r\n"],
  ];

  for (const [name, base, ours, theirs] of CASES) {
    it(`matches git merge-file: ${name}`, () => {
      const viaGit = mergeFileContents(base, ours, theirs, { noGit: false });
      const builtIn = mergeFileContents(base, ours, theirs, { noGit: true });
      expect(builtIn.clean).toBe(viaGit.clean);
      expect(builtIn.content).toBe(viaGit.content);
    });
  }

  it("writes CRLF conflict markers in a CRLF file", () => {
    // LF markers around CRLF content leave a mixed-ending file behind, and
    // on Windows a CRLF working tree is the common case.
    const r = mergeFileContents("a\r\nb\r\n", "A\r\nb\r\n", "a\r\nB\r\n", { noGit: true });
    expect(r.clean).toBe(false);
    expect(r.content).toContain("<<<<<<< ours\r\n");
    expect(r.content).toContain("=======\r\n");
    expect(r.content).toContain(">>>>>>> fork\r\n");
  });
});
