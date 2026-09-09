import { describe, expect, it } from "vitest";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent, DraftEvent } from "../src/format/events.js";
import { buildMatcher, grepEvents, GrepPatternError, renderHit } from "../src/grep.js";

const TS = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;

const drafts: DraftEvent[] = [
  { ts: TS(0), type: "session.start", payload: { runtime: "claude-code", cwd: "/proj" } },
  { ts: TS(1), type: "message.user", payload: { text: "Fix the AUTH bug in auth.py" } },
  {
    ts: TS(2),
    type: "tool.call",
    payload: { toolUseId: "t1", name: "Bash", input: { command: "pytest tests/auth.py -x" } },
  },
  { ts: TS(3), type: "tool.result", payload: { toolUseId: "t1", isError: false, output: "1 failed" } },
  {
    ts: TS(4),
    type: "file.diff",
    payload: {
      path: "/proj/src/auth.py",
      kind: "modify",
      diff: "",
      beforeHash: "b",
      afterHash: "a",
      toolUseId: "t2",
      source: "Edit",
    },
  },
  {
    ts: TS(5),
    type: "file.diff",
    payload: {
      path: "/proj/src/unrelated.ts",
      kind: "create",
      diff: "",
      beforeHash: null,
      afterHash: "c",
      toolUseId: "t3",
      source: "Write",
    },
  },
];
const EVENTS: AgitEvent[] = buildChain("sess-one", drafts);

const find = (pattern: string, opts = {}): ReturnType<typeof grepEvents> =>
  grepEvents("sess-one", EVENTS, buildMatcher(pattern, opts), opts);

describe("agit grep", () => {
  it("searches the same rendering replay --timeline prints", () => {
    // "pytest" appears only in the tool call's rendered line, not in a path.
    const hits = find("pytest");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.type).toBe("tool.call");
    expect(hits[0]!.line).toContain("pytest tests/auth.py");
  });

  it("is case-insensitive by default and exact with -s", () => {
    expect(find("auth bug")).toHaveLength(1);
    expect(find("auth bug", { caseSensitive: true })).toHaveLength(0);
    expect(find("AUTH bug", { caseSensitive: true })).toHaveLength(1);
  });

  it("--type narrows to one event type", () => {
    // auth.py appears in a user message, a tool call and a file.diff.
    expect(find("auth.py").length).toBeGreaterThan(1);
    const onlyDiffs = find("auth.py", { type: "file.diff" });
    expect(onlyDiffs).toHaveLength(1);
    expect(onlyDiffs[0]!.type).toBe("file.diff");
  });

  it("--path answers 'which session touched this file' and nothing else", () => {
    // Path mode must not match the user message or the pytest command that
    // merely mention auth.py.
    const hits = find("auth.py", { path: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.seq).toBe(4);
    // And it does not match a file.diff for a different path.
    expect(find("unrelated", { path: true })).toHaveLength(1);
    expect(find("nothing-here", { path: true })).toHaveLength(0);
  });

  it("--regex matches patterns, and a bad one is the user's error", () => {
    expect(find("auth\\.(py|ts)", { regex: true }).length).toBeGreaterThan(0);
    // A searched line begins with the event type, so anchors are useful:
    // ^tool catches the call and its result, ^file.diff only the diffs.
    expect(find("^tool", { regex: true }).map((h) => h.type)).toEqual(["tool.call", "tool.result"]);
    expect(find("^file\\.diff", { regex: true })).toHaveLength(2);
    expect(() => buildMatcher("(unclosed", { regex: true })).toThrow(GrepPatternError);
  });

  it("treats the pattern literally unless --regex is given", () => {
    // A literal search for regex metacharacters must not explode or match.
    expect(() => find("auth.(py")).not.toThrow();
    expect(find("auth.(py")).toHaveLength(0);
    expect(find("tests/auth.py")).toHaveLength(1);
  });

  it("reports session, seq and the rendered line for each hit", () => {
    const hit = find("pytest")[0]!;
    expect(hit.session).toBe("sess-one");
    expect(hit.ts).toBe(TS(2));
    const row = renderHit(hit, 8);
    expect(row.startsWith("sess-one")).toBe(true);
    expect(row).toContain("pytest");
  });

  it("returns nothing rather than throwing when a session has no match", () => {
    expect(find("nonexistent-string")).toEqual([]);
  });
});
