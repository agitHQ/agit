/**
 * A file the agent created empty: `__init__.py`, `.gitkeep`, `py.typed`.
 *
 * When the runtime gives no hunks, the adapters synthesize a whole-file diff.
 * For an empty body that diff is a hunk header declaring zero old and zero new
 * lines, followed by one blank line (the join of no lines, then the newline
 * that ends it). The reader kept that blank line as empty context, which an
 * empty base cannot match, so the recorded diff could not reproduce the
 * recorded `afterHash` of sha256(""):
 *
 *   - `agit fork` listed the file as "not reconstructible" and wrote nothing.
 *     A Codex session, which records no pre-edit content, lost the file for
 *     good, even after later edits filled it in.
 *   - `agit blame` stopped at the create and called it "proof the file
 *     changed outside structured edits".
 *
 * Stores already hold that diff inside hash-chained events, so the reader is
 * what has to accept it, and the adapters keep writing it. Every test that
 * replays it fails on the code that did not accept it; the other two pin what
 * must not move: bare empty lines stay strict context everywhere else, and a
 * re-import still records the same create.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { blameFile } from "../src/blame.js";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent, Json } from "../src/format/events.js";
import { reconstructTree } from "../src/fork.js";
import { applyUnifiedDiff, PatchError } from "../src/patch.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** What all five synthesizers write for a file created with no content. */
const EMPTY_CREATE = "--- /dev/null\n+++ b/f\n@@ -0,0 +0,0 @@\n\n";

function jsonl(records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

function fileDiffEvents(events: AgitEvent[]): AgitEvent[] {
  return events.filter((e) => e.type === "file.diff");
}

function diffOf(e: AgitEvent): string {
  return String((e.payload as { [k: string]: Json }).diff);
}

// --- the applier ------------------------------------------------------------

describe("applyUnifiedDiff: a hunk that declares no lines", () => {
  it("replays the synthesized create of an empty file to an empty file", () => {
    const rebuilt = applyUnifiedDiff(null, EMPTY_CREATE);
    expect(rebuilt).toBe("");
    expect(sha256(rebuilt)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("replays an empty file rewritten as empty the same way", () => {
    // Same synthesizer, `before` of "" instead of null: an old side header.
    expect(applyUnifiedDiff("", "--- a/f\n+++ b/f\n@@ -0,0 +0,0 @@\n\n")).toBe("");
  });

  it("still reads a bare empty line as strict context in a hunk that declares lines", () => {
    // An omitted count means one line, so this hunk is one line of context.
    const oneLine = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n\n";
    expect(applyUnifiedDiff("\n", oneLine)).toBe("\n");
    expect(() => applyUnifiedDiff("x\n", oneLine)).toThrow(PatchError);
    // Zero old lines alone is not enough: this hunk declares a new line, so a
    // stray empty line in it is still context an empty base cannot supply.
    expect(() => applyUnifiedDiff(null, "--- /dev/null\n+++ b/f\n@@ -0,0 +1,1 @@\n+a\n\n")).toThrow(
      PatchError,
    );
  });
});

// --- Write-tool transcripts -------------------------------------------------

describe("Write-tool transcript: one Write creates an empty file, then one that fills it", () => {
  const PATH = "/app/pkg/__init__.py";
  const FILLED = "VERSION = 1\n";
  const base = { cwd: "/app", sessionId: "empty-0001", version: "2.1.260" };
  const usage = { input_tokens: 1, output_tokens: 1 };

  const write = (n: number, content: string, toolUseResult: object): object[] => [
    {
      parentUuid: `u${n}`,
      isSidechain: false,
      type: "assistant",
      message: {
        id: `msg_${n}`,
        model: "claude-opus-5",
        role: "assistant",
        content: [{ type: "tool_use", id: `tu${n}`, name: "Write", input: { file_path: PATH, content } }],
        stop_reason: "tool_use",
        usage,
      },
      uuid: `a${n}`,
      timestamp: `2026-09-06T09:00:0${2 * n - 1}.000Z`,
      requestId: `req_${n}`,
      ...base,
    },
    {
      parentUuid: `a${n}`,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${n}`, content: "ok" }] },
      toolUseResult,
      uuid: `u${n + 1}`,
      timestamp: `2026-09-06T09:00:0${2 * n}.000Z`,
      ...base,
    },
  ];

  const LOG = jsonl([
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "make pkg a package" },
      uuid: "u1",
      timestamp: "2026-09-06T09:00:00.000Z",
      ...base,
    },
    // structuredPatch [] on both, so the adapter's own synthesizer writes the diffs.
    ...write(1, "", { type: "create", filePath: PATH, content: "", structuredPatch: [], originalFile: null }),
    ...write(2, FILLED, {
      type: "update",
      filePath: PATH,
      content: FILLED,
      structuredPatch: [],
      originalFile: "",
    }),
  ]);

  const converted = claudeCodeAdapter.convert(LOG);
  const events = buildChain(converted.sessionId, converted.drafts);
  const [create, fill] = fileDiffEvents(events);

  it("still records the create stores already hold, so a re-import does not diverge", () => {
    expect(diffOf(create!)).toBe(`--- /dev/null\n+++ b/${PATH}\n@@ -0,0 +0,0 @@\n\n`);
  });

  it("reconstructs the empty file, then the edit on top of it, without a rescue", () => {
    const atCreate = reconstructTree(events, create!.seq);
    expect(atCreate.skipped).toEqual([]);
    expect(atCreate.files.map((f) => [f.path, f.content])).toEqual([[PATH, ""]]);

    // The second Write records originalFile "", which used to paper over the
    // broken create at the end of the session. The chain has to hold alone.
    const atEnd = reconstructTree(events, fill!.seq);
    expect(atEnd.skipped).toEqual([]);
    expect(atEnd.files.map((f) => [f.path, f.content, f.recoveredFromOriginalFile])).toEqual([
      [PATH, FILLED, false],
    ]);
  });

  it("forks the empty file onto disk instead of skipping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-empty-"));
    const log = join(dir, "session.jsonl");
    writeFileSync(log, LOG.join("\n") + "\n", "utf8");

    const store = mkdtempSync(join(tmpdir(), "agit-empty-store-"));
    const run = (args: string[]): string => {
      const r = spawnSync(process.execPath, [CLI, ...args, "--dir", store], {
        encoding: "utf8",
        timeout: 60_000,
      });
      return (r.stdout ?? "") + (r.stderr ?? "");
    };
    expect(run(["import", log])).toContain("imported empty-0001");

    const out = join(dir, "fork");
    const forked = run(["fork", "empty-0001", "--at", String(create!.seq), "--out", out]);
    expect(forked).not.toContain("not reconstructible");
    expect(forked).toContain("1 file written");
    expect(readFileSync(join(out, "tree", "pkg", "__init__.py"), "utf8")).toBe("");
  });

  it("blames it without calling the file diverged", () => {
    const res = blameFile([{ id: converted.sessionId, events }], PATH);
    expect(res.verified).toBe(true);
    expect(res.divergedAtSeq).toBeUndefined();
    expect(res.lines.map((l) => [l.text, l.session, l.seq])).toEqual([
      ["VERSION = 1", converted.sessionId, fill!.seq],
    ]);
  });
});

// --- codex ------------------------------------------------------------------

describe("codex: a file added empty, then updated", () => {
  const PATH = "C:\\work\\app\\pkg\\__init__.py";

  const LOG = jsonl([
    {
      timestamp: "2026-09-08T10:00:01.000Z",
      type: "session_meta",
      payload: {
        id: "0199empt-0000-7aaa-8bbb-ccccdddd0001",
        timestamp: "2026-09-08T10:00:00.000Z",
        cwd: "C:\\work\\app",
        originator: "Codex CLI",
        cli_version: "0.142.0",
        source: "terminal",
      },
    },
    {
      timestamp: "2026-09-08T10:00:02.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", cwd: "C:\\work\\app", model: "gpt-5.5" },
    },
    {
      timestamp: "2026-09-08T10:00:03.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "make pkg a package with a VERSION" },
    },
    {
      timestamp: "2026-09-08T10:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "call_add",
        turn_id: "turn-1",
        stdout: "Success.",
        stderr: "",
        success: true,
        changes: { [PATH]: { type: "add", content: "" } },
        status: "completed",
      },
    },
    {
      timestamp: "2026-09-08T10:00:05.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "call_upd",
        turn_id: "turn-1",
        stdout: "Success.",
        stderr: "",
        success: true,
        changes: {
          [PATH]: {
            type: "update",
            unified_diff: "--- a/pkg/__init__.py\n+++ b/pkg/__init__.py\n@@ -0,0 +1,1 @@\n+VERSION = 1\n",
            move_path: null,
          },
        },
        status: "completed",
      },
    },
  ]);

  const converted = codexAdapter.convert(LOG);
  const events = buildChain(converted.sessionId, converted.drafts);
  const [create, update] = fileDiffEvents(events);

  it("rebuilds it, where no recorded pre-edit content could stand in for the create", () => {
    expect(diffOf(create!)).toContain("@@ -0,0 +0,0 @@\n\n");
    const { files, skipped } = reconstructTree(events, update!.seq);
    expect(skipped).toEqual([]);
    expect(files.map((f) => [f.path, f.content])).toEqual([[PATH, "VERSION = 1\n"]]);
  });

  it("blames the line to the update", () => {
    const res = blameFile([{ id: converted.sessionId, events }], PATH);
    expect(res.verified).toBe(true);
    expect(res.lines.map((l) => [l.text, l.seq])).toEqual([["VERSION = 1", update!.seq]]);
  });
});
