/**
 * A session whose clock steps back between two edits to the same file.
 *
 * SPEC §2: "`seq` is the ordering. `ts` SHOULD be non-decreasing but readers
 * MUST NOT rely on it". Blame sorted every step by `ts` first, including two
 * steps from the same session, so a clock that stepped back (an NTP
 * correction, a resumed VM) replayed a session's later edit before its
 * earlier one. What came out depended on what the runtime recorded, and was
 * wrong either way:
 *
 *   - With the first adapter's `originalFile`, the later edit seeded from the
 *     recovered base, the earlier `create` then landed on top of it, and blame
 *     reported the file as it was before the edit, marked verified.
 *   - Without it, the later edit had nothing to apply to, and blame reported a
 *     divergence, which the CLI states as proof the file changed outside
 *     structured edits.
 *
 * `fork` walks seq and gets these right. These tests pin blame to the same
 * order: seq inside a session, time between sessions.
 */

import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { blameFile } from "../src/blame.js";
import type { AgitEvent, DraftEvent } from "../src/format/events.js";
import { buildChain, sha256Hex } from "../src/format/hash.js";

const F = "/w/f";
const T = (s: number): string => `2026-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;

const start = (ts: string): DraftEvent => ({
  ts,
  type: "session.start",
  payload: { runtime: "test", cwd: "/w" },
});

/** A structured edit to F that took `before` to `after` by way of `diff`. */
function diff(ts: string, before: string | null, after: string, body: string, toolUseId: string): DraftEvent {
  return {
    ts,
    type: "file.diff",
    payload: {
      path: F,
      kind: before === null ? "create" : "modify",
      diff: (before === null ? "--- /dev/null\n" : "--- a/f\n") + "+++ b/f\n" + body,
      beforeHash: before === null ? null : sha256Hex(before),
      afterHash: sha256Hex(after),
      toolUseId,
      source: before === null ? "Write" : "Edit",
    },
  };
}

const CREATE_ABC = (ts: string, id = "t1"): DraftEvent =>
  diff(ts, null, "a\nb\nc\n", "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n", id);

/** Who each line is credited to, as `session@seq`. */
const credits = (lines: { session: string | null; seq: number | null }[]): string[] =>
  lines.map((l) => `${l.session}@${l.seq}`);

describe("blame follows seq inside a session, whatever its clock says (SPEC §2)", () => {
  it("replays a session's edits in seq order when its clock steps back", () => {
    // The second edit is still behind the create's time: the clock has not
    // caught up yet, and seq has to carry the order for more than one step.
    const events = buildChain("s", [
      start(T(10)),
      CREATE_ABC(T(10)),
      diff(T(5), "a\nb\nc\n", "a\nB\nc\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", "t2"),
      diff(T(7), "a\nB\nc\n", "a\nB\nC\n", "@@ -1,3 +1,3 @@\n a\n B\n-c\n+C\n", "t3"),
    ]);
    const res = blameFile([{ id: "s", events }], F);
    expect(res.verified).toBe(true);
    expect(res.divergedAtSeq).toBeUndefined();
    expect(res.lines.map((l) => l.text)).toEqual(["a", "B", "C"]);
    expect(credits(res.lines)).toEqual(["s@1", "s@2", "s@3"]);
  });

  it("does not report the pre-edit content as verified when the edit carries originalFile", () => {
    // Record shapes the first adapter reads; the clock steps back a minute
    // before the Edit. The adapter records the Edit with the pre-edit file
    // alongside it, which is what let the out-of-order replay "verify" the
    // wrong content.
    const B = { sessionId: "clock-skew-0001", version: "2.1.260", cwd: "/w", gitBranch: "main" };
    const U = {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const records = [
      {
        ...B,
        parentUuid: null,
        isSidechain: false,
        type: "user",
        userType: "external",
        uuid: "u1",
        timestamp: "2026-09-06T10:00:01.000Z",
        message: { role: "user", content: "Create f, then uppercase b" },
      },
      {
        ...B,
        parentUuid: "u1",
        isSidechain: false,
        type: "assistant",
        uuid: "a1",
        requestId: "r1",
        timestamp: "2026-09-06T10:00:02.000Z",
        message: {
          id: "m1",
          model: "test-model",
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Write", input: { file_path: F, content: "a\nb\nc\n" } },
          ],
          stop_reason: "tool_use",
          usage: U,
        },
      },
      {
        ...B,
        parentUuid: "a1",
        isSidechain: false,
        type: "user",
        userType: "external",
        uuid: "u2",
        timestamp: "2026-09-06T10:00:03.000Z",
        message: {
          role: "user",
          content: [{ tool_use_id: "t1", type: "tool_result", content: "File created" }],
        },
        toolUseResult: {
          type: "create",
          filePath: F,
          content: "a\nb\nc\n",
          structuredPatch: [],
          originalFile: null,
          userModified: false,
        },
      },
      {
        ...B,
        parentUuid: "u2",
        isSidechain: false,
        type: "assistant",
        uuid: "a2",
        requestId: "r2",
        timestamp: "2026-09-06T09:59:00.000Z",
        message: {
          id: "m2",
          model: "test-model",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "Edit",
              input: { file_path: F, old_string: "b", new_string: "B", replace_all: false },
            },
          ],
          stop_reason: "tool_use",
          usage: U,
        },
      },
      {
        ...B,
        parentUuid: "a2",
        isSidechain: false,
        type: "user",
        userType: "external",
        uuid: "u3",
        timestamp: "2026-09-06T09:59:01.000Z",
        message: { role: "user", content: [{ tool_use_id: "t2", type: "tool_result", content: "updated" }] },
        toolUseResult: {
          filePath: F,
          oldString: "b",
          newString: "B",
          originalFile: "a\nb\nc\n",
          replaceAll: false,
          structuredPatch: [
            { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] },
          ],
          userModified: false,
        },
      },
    ];
    const converted = claudeCodeAdapter.convert(records.map((r) => JSON.stringify(r)));
    const events = buildChain(converted.sessionId, converted.drafts);
    const seqOf = (kind: string): number =>
      events.find(
        (e: AgitEvent) => e.type === "file.diff" && (e.payload as { kind?: unknown }).kind === kind,
      )!.seq;

    const res = blameFile([{ id: converted.sessionId, events }], F);
    expect(res.verified).toBe(true);
    expect(res.lines.map((l) => l.text)).toEqual(["a", "B", "c"]);
    expect(res.lines.map((l) => l.seq)).toEqual([seqOf("create"), seqOf("modify"), seqOf("create")]);
  });

  it("replays a delete stamped before its create after the create", () => {
    const events = buildChain("s", [
      start(T(10)),
      CREATE_ABC(T(10)),
      {
        ts: T(5),
        type: "file.delete",
        payload: { path: F, beforeHash: sha256Hex("a\nb\nc\n"), source: "Bash" },
      },
    ]);
    const res = blameFile([{ id: "s", events }], F);
    expect(res.lines).toEqual([]);
    expect(res.verified).toBe(true);
  });

  it("still interleaves sessions by time, in whatever order they are passed", () => {
    // Timestamps that never go backwards: the order is the one blame always
    // used. A, then B on top of A's result, then A again on top of B's.
    const a = buildChain("A", [
      start(T(10)),
      CREATE_ABC(T(10)),
      diff(T(30), "a\nB\nc\n", "a\nB\nC\n", "@@ -1,3 +1,3 @@\n a\n B\n-c\n+C\n", "t2"),
    ]);
    const b = buildChain("B", [
      start(T(20)),
      diff(T(20), "a\nb\nc\n", "a\nB\nc\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", "t1"),
    ]);
    for (const sessions of [
      [
        { id: "A", events: a },
        { id: "B", events: b },
      ],
      [
        { id: "B", events: b },
        { id: "A", events: a },
      ],
    ]) {
      const res = blameFile(sessions, F);
      expect(res.verified).toBe(true);
      expect(res.lines.map((l) => l.text)).toEqual(["a", "B", "C"]);
      expect(credits(res.lines)).toEqual(["A@1", "B@1", "A@2"]);
      expect(res.sessions).toEqual(["A", "B"]);
    }
  });

  it("places a stepped-back edit with its session's previous edit, not before everything", () => {
    // A's second edit is stamped before its create. It belongs right after
    // the create, so before B's edit at 20, not before everything.
    const a = buildChain("A", [
      start(T(10)),
      CREATE_ABC(T(10)),
      diff(T(5), "a\nb\nc\n", "a\nB\nc\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", "t2"),
      diff(T(30), "a\nB\nC\n", "A\nB\nC\n", "@@ -1,3 +1,3 @@\n-a\n+A\n B\n C\n", "t3"),
    ]);
    const b = buildChain("B", [
      start(T(20)),
      diff(T(20), "a\nB\nc\n", "a\nB\nC\n", "@@ -1,3 +1,3 @@\n a\n B\n-c\n+C\n", "t1"),
    ]);
    const res = blameFile(
      [
        { id: "A", events: a },
        { id: "B", events: b },
      ],
      F,
    );
    expect(res.verified).toBe(true);
    expect(res.lines.map((l) => l.text)).toEqual(["A", "B", "C"]);
    expect(credits(res.lines)).toEqual(["A@3", "A@2", "B@1"]);
  });
});
