/**
 * A file whose last line has no newline after it.
 *
 * The adapters synthesize a whole-file unified diff whenever the runtime gave
 * them no usable hunks. That diff used to describe a trailing newline the file
 * did not have, which made the recorded diff unable to reproduce the recorded
 * `afterHash`. The consequences were both silent and wrong:
 *
 *   - `agit fork` listed the file as "reconstruction did not match afterHash"
 *     and wrote nothing, so the forked tree was missing it.
 *   - `agit blame` reported the mismatch as a divergence, which the CLI states
 *     as "proof the file changed outside structured edits" — an accusation of
 *     tampering against a file the agent had just written in one clean step.
 *
 * `diff` has said this in one line since forever, and `applyUnifiedDiff`
 * already read it; only the writers were silent, and blame's applier threw the
 * line away. These tests fail on the code that did.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BaseTree } from "../src/base.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import { blameFile } from "../src/blame.js";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent, DraftEvent, Json } from "../src/format/events.js";
import { applyUnifiedDiff } from "../src/patch.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

interface FileDiff {
  path: string;
  kind: string;
  diff: string;
  beforeHash: string | null;
  afterHash: string;
}

function fileDiffs(drafts: DraftEvent[]): FileDiff[] {
  return drafts
    .filter((d) => d.type === "file.diff")
    .map((d) => {
      const p = d.payload as { [k: string]: Json };
      return {
        path: String(p.path),
        kind: String(p.kind),
        diff: String(p.diff),
        beforeHash: typeof p.beforeHash === "string" ? p.beforeHash : null,
        afterHash: String(p.afterHash),
      };
    });
}

/**
 * What `fork` and `blame` both do: replay the recorded diff and check the
 * result against the hash the event recorded. `before` is what the file held
 * going in, which the caller knows because it wrote the fixture.
 */
function replays(d: FileDiff, before: string | null, expected: string): void {
  const rebuilt = applyUnifiedDiff(d.kind === "create" ? null : before, d.diff);
  expect(rebuilt).toBe(expected);
  expect(sha256(rebuilt)).toBe(d.afterHash);
}

function jsonl(records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

// --- the applier ------------------------------------------------------------

describe("applyUnifiedDiff: the no-newline marker", () => {
  it("creates a file with no trailing newline when the diff says so", () => {
    const diff = "--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n\\ No newline at end of file\n";
    expect(applyUnifiedDiff(null, diff)).toBe("alpha\nbeta");
  });

  it("keeps the trailing newline off a modified file", () => {
    const diff =
      "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n";
    expect(applyUnifiedDiff("a", diff)).toBe("b");
  });

  it("adds a trailing newline the base did not have when only the old side is marked", () => {
    // The marker names the OLD file's ending; the new side carrying none is
    // the diff saying, just as plainly, that the result does end with one.
    const diff = "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n";
    expect(applyUnifiedDiff("a", diff)).toBe("b\n");
  });

  it("still follows the base's ending for a diff that carries no marker at all", () => {
    // Logs imported before the adapters wrote the marker have to keep
    // reconstructing exactly as they did, so a marker-free diff is left to the
    // old rule rather than reinterpreted.
    expect(applyUnifiedDiff("a", "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n")).toBe("b");
    expect(applyUnifiedDiff("a\n", "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n")).toBe("b\n");
  });
});

// --- the adapters -----------------------------------------------------------

describe("claude-code: a file written without a trailing newline", () => {
  const CONTENT = "alpha\nbeta";
  const EDITED = "alpha\nbetaX";

  const LOG = jsonl([
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "write a.txt" },
      uuid: "u1",
      timestamp: "2026-09-06T09:00:00.000Z",
      cwd: "/app",
      sessionId: "nonl-0001",
      version: "2.1.260",
    },
    {
      parentUuid: "u1",
      isSidechain: false,
      type: "assistant",
      message: {
        id: "msg_A",
        model: "claude-opus-5",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "Write",
            input: { file_path: "/app/a.txt", content: CONTENT },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      uuid: "a1",
      timestamp: "2026-09-06T09:00:01.000Z",
      cwd: "/app",
      sessionId: "nonl-0001",
      version: "2.1.260",
      requestId: "req_A",
    },
    {
      parentUuid: "a1",
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
      toolUseResult: { type: "create", filePath: "/app/a.txt", content: CONTENT, structuredPatch: [] },
      uuid: "u2",
      timestamp: "2026-09-06T09:00:02.000Z",
      cwd: "/app",
      sessionId: "nonl-0001",
      version: "2.1.260",
    },
    {
      parentUuid: "u2",
      isSidechain: false,
      type: "assistant",
      message: {
        id: "msg_B",
        model: "claude-opus-5",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu2",
            name: "Edit",
            input: { file_path: "/app/a.txt", old_string: "beta", new_string: "betaX" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      uuid: "a2",
      timestamp: "2026-09-06T09:00:03.000Z",
      cwd: "/app",
      sessionId: "nonl-0001",
      version: "2.1.260",
      requestId: "req_B",
    },
    {
      parentUuid: "a2",
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "ok" }] },
      toolUseResult: {
        filePath: "/app/a.txt",
        oldString: "beta",
        newString: "betaX",
        originalFile: CONTENT,
      },
      uuid: "u3",
      timestamp: "2026-09-06T09:00:04.000Z",
      cwd: "/app",
      sessionId: "nonl-0001",
      version: "2.1.260",
    },
  ]);

  const diffs = fileDiffs(claudeCodeAdapter.convert(LOG).drafts);

  it("records the create so it replays to the exact bytes", () => {
    expect(diffs[0]!.kind).toBe("create");
    replays(diffs[0]!, null, CONTENT);
  });

  it("records the edit so it replays to the exact bytes", () => {
    expect(diffs[1]!.kind).toBe("modify");
    replays(diffs[1]!, CONTENT, EDITED);
  });

  it("names the ending in the diff rather than leaving it to be guessed", () => {
    expect(diffs[0]!.diff).toContain("\\ No newline at end of file");
  });

  it("forks the file instead of skipping it as unreconstructible", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-nonl-"));
    const log = join(dir, "session.jsonl");
    writeFileSync(log, LOG.join("\n") + "\n", "utf8");

    const store = mkdtempSync(join(tmpdir(), "agit-nonl-store-"));
    const run = (args: string[]): string => {
      const r = spawnSync(process.execPath, [CLI, ...args, "--dir", store], {
        encoding: "utf8",
        timeout: 60_000,
      });
      return (r.stdout ?? "") + (r.stderr ?? "");
    };
    expect(run(["import", log])).toContain("imported nonl-0001");

    // Event 5 is the create, the one step this file has. Forking there is the
    // whole bug in one command: the tree came back empty and the file was
    // listed as "reconstruction did not match afterHash".
    const atCreate = join(dir, "fork-create");
    const created = run(["fork", "nonl-0001", "--at", "5", "--out", atCreate]);
    expect(created).not.toContain("not reconstructible");
    expect(readFileSync(join(atCreate, "tree", "a.txt"), "utf8")).toBe(CONTENT);

    const atEnd = join(dir, "fork-end");
    expect(run(["fork", "nonl-0001", "--at", "9", "--out", atEnd])).not.toContain("not reconstructible");
    expect(readFileSync(join(atEnd, "tree", "a.txt"), "utf8")).toBe(EDITED);
  });

  it("blames it without calling the file diverged", () => {
    const converted = claudeCodeAdapter.convert(LOG);
    const events: AgitEvent[] = buildChain(converted.sessionId, converted.drafts);
    const res = blameFile([{ id: converted.sessionId, events }], "/app/a.txt");
    expect(res.verified).toBe(true);
    expect(res.divergedAtSeq).toBeUndefined();
    expect(res.lines.map((l) => l.text)).toEqual(["alpha", "betaX"]);
    expect(res.lines.every((l) => l.session === converted.sessionId)).toBe(true);
  });
});

describe("codex: a file added without a trailing newline", () => {
  const CONTENT = "x = 1";

  const LOG = jsonl([
    {
      timestamp: "2026-09-08T10:00:01.000Z",
      type: "session_meta",
      payload: {
        id: "0199nonl-0000-7aaa-8bbb-ccccdddd0001",
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
      payload: { type: "user_message", message: "add x.py" },
    },
    {
      timestamp: "2026-09-08T10:00:04.000Z",
      type: "response_item",
      payload: { type: "function_call", id: "fc1", name: "apply_patch", arguments: "{}", call_id: "call_1" },
    },
    {
      timestamp: "2026-09-08T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: "Success. Updated the following files:\nA x.py",
      },
    },
    {
      timestamp: "2026-09-08T10:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "call_1",
        turn_id: "turn-1",
        stdout: "Success.",
        stderr: "",
        success: true,
        changes: { "C:\\work\\app\\x.py": { type: "add", content: CONTENT } },
        status: "completed",
      },
    },
  ]);

  it("records it so it replays to the exact bytes", () => {
    const diffs = fileDiffs(codexAdapter.convert(LOG).drafts);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.kind).toBe("create");
    replays(diffs[0]!, null, CONTENT);
  });
});

describe("openclaw: an update that keeps a base file's missing final newline", () => {
  const BEFORE = "x = 1";
  const AFTER = "x = 2";

  // The V4A add format always writes a trailing newline, so the reachable
  // case here is a file that predates the session and is supplied with
  // --base (#85): apply_patch preserves the ending it found.
  const base: BaseTree = { kind: "dir", ref: "t", files: new Map([["existing.py", BEFORE]]) };

  const LOG = jsonl([
    {
      type: "session",
      version: 4,
      id: "0199openclaw-nonl-7bbb-8ccc-ddddeeee0002",
      timestamp: "2026-09-08T11:00:01.000Z",
      cwd: "/workspace/demo",
    },
    {
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: "2026-09-08T11:00:02.000Z",
      message: { role: "user", content: [{ type: "text", text: "bump it" }] },
    },
    {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      timestamp: "2026-09-08T11:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "functions.apply_patch:1",
            name: "apply_patch",
            arguments: {
              input: "*** Begin Patch\n*** Update File: existing.py\n@@\n-x = 1\n+x = 2\n*** End Patch",
            },
          },
        ],
        model: "gpt-5.5",
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "msg-3",
      parentId: "msg-2",
      timestamp: "2026-09-08T11:00:04.000Z",
      message: {
        role: "toolResult",
        toolCallId: "functions.apply_patch:1",
        toolName: "apply_patch",
        content: [{ type: "text", text: "Success. Updated the following files:\nM existing.py" }],
        isError: false,
        details: { summary: { added: [], modified: ["existing.py"], deleted: [] } },
      },
    },
  ]);

  it("records it so it replays to the exact bytes", () => {
    const diffs = fileDiffs(openclawAdapter.convert(LOG, { base }).drafts);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.kind).toBe("modify");
    expect(diffs[0]!.beforeHash).toBe(sha256(BEFORE));
    replays(diffs[0]!, BEFORE, AFTER);
  });
});
