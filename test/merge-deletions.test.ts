import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain, sha256Hex } from "../src/format/hash.js";
import type { AgitEvent, DraftEvent } from "../src/format/events.js";
import { writeFork } from "../src/fork.js";
import { mergeFork } from "../src/merge.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const lines = readFileSync(join(ROOT, "fixtures", "claude-code", "demo.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const converted = claudeCodeAdapter.convert(lines);
const counts: RedactionCounts = {};
for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
const DRAFTS: DraftEvent[] = converted.drafts;
const DEMO: AgitEvent[] = buildChain(converted.sessionId, DRAFTS);
const HEAD = DEMO.length - 1;

const LOGIN = "C:\\app\\src\\login.ts";
const REL = "src/login.ts";

/** A fork/target pair: the target starts as an exact copy of the fork-point tree. */
function setup(): { forkDir: string; intoDir: string; loginAtFork: string } {
  const scratch = mkdtempSync(join(tmpdir(), "agit-del-"));
  const forkDir = join(scratch, "fork");
  writeFork(DEMO, HEAD, "demo-ratelimit-0001", forkDir);
  const intoDir = join(scratch, "target");
  for (const rel of ["src/ratelimit.ts", REL]) {
    const dest = join(intoDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(forkDir, "tree", rel), "utf8"), "utf8");
  }
  return { forkDir, intoDir, loginAtFork: readFileSync(join(forkDir, "tree", REL), "utf8") };
}

/**
 * The fork's own session: the parent's events, then whatever the forked
 * session went on to do. Everything appended lands past the fork point.
 */
function forkSession(...after: DraftEvent[]): AgitEvent[] {
  return buildChain("forked-session-0001", [...DRAFTS, ...after]);
}

const ts = "2026-09-06T10:00:00.000Z";
const deleteDraft = (path: string, beforeHash: string): DraftEvent => ({
  ts,
  type: "file.delete",
  payload: { path, beforeHash, toolUseId: "t-del", source: "Bash" },
});

describe("merge honours deletions from the fork's session (#88)", () => {
  it("deletes a file the fork removed when the target has not moved on", () => {
    const { forkDir, intoDir, loginAtFork } = setup();
    // The fork tree records what the log could rebuild; a deleted file is
    // simply absent from it, which is why the session is needed to tell
    // "deleted" from "untouched".
    const { results, deleted } = mergeFork({
      forkDir,
      intoDir,
      sourceEvents: DEMO,
      forkEvents: forkSession(deleteDraft(LOGIN, sha256Hex(loginAtFork))),
    });
    expect(deleted).toBe(1);
    expect(results.find((r) => r.rel === REL)?.outcome).toBe("deleted");
    expect(existsSync(join(intoDir, REL))).toBe(false);
  });

  it("keeps a file the target changed since the fork point, and calls it a conflict", () => {
    const { forkDir, intoDir, loginAtFork } = setup();
    const target = join(intoDir, REL);
    writeFileSync(target, loginAtFork + "\n// work done in the target since the fork\n", "utf8");

    const { results, conflicts, deleted } = mergeFork({
      forkDir,
      intoDir,
      sourceEvents: DEMO,
      forkEvents: forkSession(deleteDraft(LOGIN, sha256Hex(loginAtFork))),
    });
    expect(deleted).toBe(0);
    expect(conflicts).toBe(1);
    expect(results.find((r) => r.rel === REL)?.outcome).toBe("kept-ours-deleted");
    // The work is still there: a deletion never silently discards it.
    expect(readFileSync(target, "utf8")).toContain("work done in the target");
  });

  it("refuses a deletion whose beforeHash is not what the fork point held", () => {
    const { forkDir, intoDir } = setup();
    const { results, conflicts, deleted } = mergeFork({
      forkDir,
      intoDir,
      sourceEvents: DEMO,
      forkEvents: forkSession(deleteDraft(LOGIN, sha256Hex("something else entirely"))),
    });
    expect(deleted).toBe(0);
    expect(conflicts).toBe(1);
    expect(results.find((r) => r.rel === REL)?.outcome).toBe("kept-ours-deleted");
    expect(existsSync(join(intoDir, REL))).toBe(true);
  });

  it("does not delete a path the fork put back", () => {
    const { forkDir, intoDir, loginAtFork } = setup();
    // delete then re-create: the fork tree holds it again, so it is an edit.
    const recreate: DraftEvent = {
      ts,
      type: "file.diff",
      payload: {
        path: LOGIN,
        kind: "create",
        diff: "",
        beforeHash: null,
        afterHash: sha256Hex("rewritten\n"),
        toolUseId: "t-new",
        source: "Write",
      },
    };
    const { results, deleted } = mergeFork({
      forkDir,
      intoDir,
      sourceEvents: DEMO,
      forkEvents: forkSession(deleteDraft(LOGIN, sha256Hex(loginAtFork)), recreate),
    });
    expect(deleted).toBe(0);
    expect(results.find((r) => r.rel === REL)?.outcome).not.toBe("deleted");
    expect(existsSync(join(intoDir, REL))).toBe(true);
  });

  it("ignores deletions recorded before the fork point", () => {
    const { forkDir, intoDir, loginAtFork } = setup();
    // Same delete, but inside the shared history rather than after it: the
    // parent already knows about it, so it is not the fork's decision.
    const before = buildChain("forked-session-0001", [deleteDraft(LOGIN, sha256Hex(loginAtFork)), ...DRAFTS]);
    const { deleted } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO, forkEvents: before });
    expect(deleted).toBe(0);
    expect(existsSync(join(intoDir, REL))).toBe(true);
  });

  it("changes nothing without a fork session: absence still means untouched", () => {
    const { forkDir, intoDir } = setup();
    const { results, deleted } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO });
    expect(deleted).toBe(0);
    expect(results.every((r) => r.outcome !== "deleted")).toBe(true);
    expect(existsSync(join(intoDir, REL))).toBe(true);
  });

  it("records the deletion in merge.json", () => {
    const { forkDir, intoDir, loginAtFork } = setup();
    mergeFork({
      forkDir,
      intoDir,
      sourceEvents: DEMO,
      forkEvents: forkSession(deleteDraft(LOGIN, sha256Hex(loginAtFork))),
    });
    const record = JSON.parse(readFileSync(join(forkDir, "merge.json"), "utf8")) as {
      deleted: number;
      results: { rel: string; outcome: string }[];
    };
    expect(record.deleted).toBe(1);
    expect(record.results).toContainEqual({ rel: REL, outcome: "deleted" });
  });
});
