/**
 * `agit merge` and files that are not UTF-8 text.
 *
 * mergeFork used to read every fork and target file as UTF-8 and write the
 * result back the same way. A PNG the fork added, or a Latin-1 file it
 * edited, came out with each invalid byte replaced by U+FFFD, and the merge
 * still said `added` / `took-fork` / `clean: no conflicts.`
 *
 * A binary file both sides changed was worse: `git merge-file` refuses one,
 * and that took the whole merge down partway, after earlier files had been
 * written into the target, before later ones were merged and before
 * merge.json existed. The built-in engine wrote text markers into the binary
 * file instead, so the two engines disagreed on the same inputs.
 *
 * These tests fail on the code that did.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain, sha256Hex } from "../src/format/hash.js";
import type { AgitEvent, DraftEvent } from "../src/format/events.js";
import { writeFork } from "../src/fork.js";
import { mergeFileContents, mergeFork } from "../src/merge.js";
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
/** noGit values to run each engine test under: git where it exists, the built-in merge always. */
const ENGINES = haveGit() ? [false, true] : [true];
const engineName = (noGit: boolean): string => (noGit ? "built-in" : "git");

const lines = readFileSync(join(ROOT, "fixtures", "claude-code", "demo.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const converted = claudeCodeAdapter.convert(lines);
const counts: RedactionCounts = {};
for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
const DEMO: AgitEvent[] = buildChain(converted.sessionId, converted.drafts);
const HEAD = DEMO.length - 1;

const RATELIMIT = "src/ratelimit.ts";
const LOGIN = "src/login.ts";

/** A fork of the demo session plus a target dir seeded with the fork-point tree. */
function setup(): { forkDir: string; intoDir: string } {
  const scratch = mkdtempSync(join(tmpdir(), "agit-mergebytes-"));
  const forkDir = join(scratch, "fork");
  writeFork(DEMO, HEAD, "demo-ratelimit-0001", forkDir);
  const intoDir = join(scratch, "target");
  for (const rel of [RATELIMIT, LOGIN]) {
    const dest = join(intoDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(forkDir, "tree", rel)));
  }
  return { forkDir, intoDir };
}

const latin1 = (s: string): Buffer => Buffer.from(s, "latin1");
/** Hex, so a failure shows which bytes changed. */
const hexOf = (path: string): string => readFileSync(path).toString("hex");

/** A PNG signature and header: a NUL, and bytes that are never valid UTF-8. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe,
  0x80, 0x81,
]);

describe("agit merge keeps a file's exact bytes", () => {
  it("copies a file the fork added byte for byte", () => {
    const { forkDir, intoDir } = setup();
    writeFileSync(join(forkDir, "tree", "logo.png"), PNG);
    writeFileSync(join(forkDir, "tree", "menu.txt"), latin1("caf\xe9 cr\xe8me\n"));

    const { results, conflicts } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO });
    const byRel = Object.fromEntries(results.map((r) => [r.rel, r.outcome]));
    expect(conflicts).toBe(0);
    expect(byRel["logo.png"]).toBe("added");
    expect(byRel["menu.txt"]).toBe("added");
    expect(hexOf(join(intoDir, "logo.png"))).toBe(PNG.toString("hex"));
    expect(hexOf(join(intoDir, "menu.txt"))).toBe(latin1("caf\xe9 cr\xe8me\n").toString("hex"));
  });

  it("fast-forwards to the fork's bytes, not a UTF-8 decoding of them", () => {
    const { forkDir, intoDir } = setup();
    const forkFile = join(forkDir, "tree", RATELIMIT);
    const edited = latin1(readFileSync(forkFile, "latin1").replace("LIMIT = 5;", "LIMIT = 3; // caf\xe9"));
    writeFileSync(forkFile, edited);

    const { results } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO });
    expect(results.find((r) => r.rel === RATELIMIT)?.outcome).toBe("took-fork");
    expect(hexOf(join(intoDir, RATELIMIT))).toBe(edited.toString("hex"));
  });

  for (const noGit of ENGINES) {
    it(`three-way merges Latin-1 text without re-encoding either side (${engineName(noGit)})`, () => {
      const { forkDir, intoDir } = setup();
      const base = readFileSync(join(forkDir, "tree", RATELIMIT), "latin1");
      // Edits three lines apart, so the merge is clean; each side adds a byte
      // that is not valid UTF-8 on its own.
      const ours = base.replace("LIMIT = 5;", "LIMIT = 8; // caf\xe9");
      const theirs = base.replace("hits(ip, WINDOW) < LIMIT;", "hits(ip, WINDOW * 2) < LIMIT; // cr\xe8me");
      writeFileSync(join(intoDir, RATELIMIT), latin1(ours));
      writeFileSync(join(forkDir, "tree", RATELIMIT), latin1(theirs));

      const { results } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO, noGit });
      expect(results.find((r) => r.rel === RATELIMIT)?.outcome).toBe("clean-merge");
      const both = ours.replace("hits(ip, WINDOW) < LIMIT;", "hits(ip, WINDOW * 2) < LIMIT; // cr\xe8me");
      expect(hexOf(join(intoDir, RATELIMIT))).toBe(latin1(both).toString("hex"));
    });

    it(`merges UTF-8 text exactly as the string merge does (${engineName(noGit)})`, () => {
      // The byte-level path must not change a single result for ordinary
      // text: a clean merge and a conflict, both carrying multi-byte UTF-8.
      const { forkDir, intoDir } = setup();
      const baseRl = readFileSync(join(forkDir, "tree", RATELIMIT), "utf8");
      const oursRl = baseRl.replace("LIMIT = 5;", "LIMIT = 8; // café €");
      const theirsRl = baseRl.replace("hits(ip, WINDOW)", "hits(ip, WINDOW * 2) /* 𝄞 */");
      const baseLogin = readFileSync(join(forkDir, "tree", LOGIN), "utf8");
      const oursLogin = baseLogin.replace("tooMany()", "throttle() // naïve");
      const theirsLogin = baseLogin.replace("tooMany()", "reject429() // 日本");
      writeFileSync(join(intoDir, RATELIMIT), oursRl, "utf8");
      writeFileSync(join(forkDir, "tree", RATELIMIT), theirsRl, "utf8");
      writeFileSync(join(intoDir, LOGIN), oursLogin, "utf8");
      writeFileSync(join(forkDir, "tree", LOGIN), theirsLogin, "utf8");

      const { results, conflicts } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO, noGit });
      const byRel = Object.fromEntries(results.map((r) => [r.rel, r.outcome]));
      expect(byRel[RATELIMIT]).toBe("clean-merge");
      expect(byRel[LOGIN]).toBe("conflict");
      expect(conflicts).toBe(1);
      const viaStrings = (b: string, o: string, t: string): string =>
        Buffer.from(mergeFileContents(b, o, t, { noGit }).content, "utf8").toString("hex");
      expect(hexOf(join(intoDir, RATELIMIT))).toBe(viaStrings(baseRl, oursRl, theirsRl));
      expect(hexOf(join(intoDir, LOGIN))).toBe(viaStrings(baseLogin, oursLogin, theirsLogin));
      expect(readFileSync(join(intoDir, LOGIN), "utf8")).toContain("<<<<<<< ours");
    });
  }
});

describe("a binary file both sides changed", () => {
  /** A file before it and one after it in merge order, so a merge that stops partway shows. */
  function binaryConflict(noGit: boolean): {
    intoDir: string;
    forkDir: string;
    result: ReturnType<typeof mergeFork>;
  } {
    const { forkDir, intoDir } = setup();
    writeFileSync(join(forkDir, "tree", "0-notes.txt"), "from the fork\n", "utf8");
    writeFileSync(join(forkDir, "tree", "data.bin"), Buffer.from("fork\0bin"));
    writeFileSync(join(intoDir, "data.bin"), Buffer.from("ours\0bin"));
    writeFileSync(join(forkDir, "tree", "zz.txt"), "later file\n", "utf8");
    return { forkDir, intoDir, result: mergeFork({ forkDir, intoDir, sourceEvents: DEMO, noGit }) };
  }

  for (const noGit of ENGINES) {
    it(`is a conflict that keeps the target's copy, and the merge finishes (${engineName(noGit)})`, () => {
      const { forkDir, intoDir, result } = binaryConflict(noGit);
      // No markers: the target's own bytes, untouched.
      expect(hexOf(join(intoDir, "data.bin"))).toBe(Buffer.from("ours\0bin").toString("hex"));
      expect(result.conflicts).toBe(1);
      expect(result.results.find((r) => r.rel === "data.bin")).toEqual({
        rel: "data.bin",
        outcome: "conflict",
        binary: true,
      });
      // Files on both sides of it in merge order were merged.
      expect(readFileSync(join(intoDir, "0-notes.txt"), "utf8")).toBe("from the fork\n");
      expect(readFileSync(join(intoDir, "zz.txt"), "utf8")).toBe("later file\n");
      // And the merge was recorded.
      const record = JSON.parse(readFileSync(join(forkDir, "merge.json"), "utf8")) as {
        conflicts: number;
        results: unknown[];
      };
      expect(record.conflicts).toBe(1);
      expect(record.results).toEqual(result.results);
    });
  }

  it.skipIf(ENGINES.length < 2)("gets the same outcome from both engines", () => {
    expect(binaryConflict(true).result.results).toEqual(binaryConflict(false).result.results);
  });

  for (const noGit of ENGINES) {
    it(`counts a NUL on either side as binary (${engineName(noGit)})`, () => {
      // Fork went binary over a text edit in the target, and the other way round.
      for (const binarySide of ["fork", "ours"] as const) {
        const { forkDir, intoDir } = setup();
        const forkFile = join(forkDir, "tree", RATELIMIT);
        const oursFile = join(intoDir, RATELIMIT);
        const text = readFileSync(forkFile, "utf8");
        writeFileSync(forkFile, binarySide === "fork" ? PNG : text.replace("LIMIT = 5", "LIMIT = 3"));
        writeFileSync(oursFile, binarySide === "ours" ? PNG : text.replace("LIMIT = 5", "LIMIT = 8"));
        const before = hexOf(oursFile);

        const { results, conflicts } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO, noGit });
        expect(hexOf(oursFile), binarySide).toBe(before);
        expect(conflicts, binarySide).toBe(1);
        expect(
          results.find((r) => r.rel === RATELIMIT),
          binarySide,
        ).toEqual({
          rel: RATELIMIT,
          outcome: "conflict",
          binary: true,
        });
      }
    });

    it(`uses git's cut-off: a NUL past the first 8000 bytes is still text (${engineName(noGit)})`, () => {
      // git merge-file looks for a NUL in the first 8000 bytes and refuses the
      // file if it finds one. Checking fewer bytes than git would let git
      // throw mid-merge again; checking more would refuse files git merges.
      for (const [at, binary] of [
        [7999, true],
        [8000, false],
      ] as const) {
        const { forkDir, intoDir } = setup();
        const forkFile = join(forkDir, "tree", RATELIMIT);
        const oursFile = join(intoDir, RATELIMIT);
        const text = readFileSync(forkFile, "utf8");
        // Ours pads the file so a NUL lands at exactly `at`; the fork edits
        // the other end, so as text the merge is clean.
        const lead = "// pad ";
        const padded = text + lead + "x".repeat(at - text.length - lead.length) + "\0\n";
        expect(Buffer.from(padded).indexOf(0)).toBe(at);
        writeFileSync(oursFile, padded, "utf8");
        writeFileSync(forkFile, text.replace("LIMIT = 5", "LIMIT = 3"), "utf8");

        const { results } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO, noGit });
        const r = results.find((x) => x.rel === RATELIMIT);
        if (binary) {
          expect(readFileSync(oursFile, "utf8"), `NUL at ${at}`).toBe(padded);
          expect(r, `NUL at ${at}`).toEqual({ rel: RATELIMIT, outcome: "conflict", binary: true });
        } else {
          expect(readFileSync(oursFile, "utf8"), `NUL at ${at}`).toBe(
            padded.replace("LIMIT = 5", "LIMIT = 3"),
          );
          expect(r, `NUL at ${at}`).toEqual({ rel: RATELIMIT, outcome: "clean-merge" });
        }
      }
    });
  }
});

describe("a file that was binary at the fork point", () => {
  const BASE = "a\0b\n";
  const DRAFTS: DraftEvent[] = [
    {
      ts: "2026-01-01T00:00:00.000Z",
      type: "file.diff",
      payload: {
        path: "blob.bin",
        kind: "create",
        diff: "--- /dev/null\n+++ b/blob.bin\n@@ -0,0 +1,1 @@\n+a\0b\n",
        beforeHash: null,
        afterHash: sha256Hex(BASE),
        toolUseId: "blob-create",
        source: "test",
      },
    },
  ];
  const EVENTS = buildChain("merge-binary-base", DRAFTS);

  function setupBlob(): { forkDir: string; intoDir: string } {
    const scratch = mkdtempSync(join(tmpdir(), "agit-mergeblob-"));
    const forkDir = join(scratch, "fork");
    writeFork(EVENTS, 0, "merge-binary-base", forkDir);
    const intoDir = join(scratch, "target");
    mkdirSync(intoDir, { recursive: true });
    writeFileSync(join(intoDir, "blob.bin"), readFileSync(join(forkDir, "tree", "blob.bin")));
    return { forkDir, intoDir };
  }

  it("was reconstructed into the fork tree, so these tests merge against it", () => {
    const { forkDir } = setupBlob();
    expect(readFileSync(join(forkDir, "tree", "blob.bin"), "utf8")).toBe(BASE);
  });

  it("still fast-forwards when only the fork changed it", () => {
    const { forkDir, intoDir } = setupBlob();
    writeFileSync(join(forkDir, "tree", "blob.bin"), PNG);
    const { results, conflicts } = mergeFork({ forkDir, intoDir, sourceEvents: EVENTS });
    expect(conflicts).toBe(0);
    expect(results).toEqual([{ rel: "blob.bin", outcome: "took-fork" }]);
    expect(hexOf(join(intoDir, "blob.bin"))).toBe(PNG.toString("hex"));
  });

  for (const noGit of ENGINES) {
    it(`is a binary conflict even when both new versions are text (${engineName(noGit)})`, () => {
      // git merge-file refuses a binary base as firmly as a binary side.
      const { forkDir, intoDir } = setupBlob();
      writeFileSync(join(forkDir, "tree", "blob.bin"), "fork\n", "utf8");
      writeFileSync(join(intoDir, "blob.bin"), "ours\n", "utf8");
      const { results, conflicts } = mergeFork({ forkDir, intoDir, sourceEvents: EVENTS, noGit });
      expect(readFileSync(join(intoDir, "blob.bin"), "utf8")).toBe("ours\n");
      expect(conflicts).toBe(1);
      expect(results).toEqual([{ rel: "blob.bin", outcome: "conflict", binary: true }]);
    });
  }
});
