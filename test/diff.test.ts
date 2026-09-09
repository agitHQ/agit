import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChain, sha256Hex } from "../src/format/hash.js";
import type { AgitEvent, DraftEvent } from "../src/format/events.js";
import { diffSessions, renderDiff, treeOnDisk } from "../src/diff.js";

const TS = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;

/** A session that creates each given file with the given content. */
function session(id: string, cwd: string, files: [string, string][], extra: DraftEvent[] = []): AgitEvent[] {
  const drafts: DraftEvent[] = [
    { ts: TS(0), type: "session.start", payload: { runtime: "test", cwd } },
    ...files.map(([path, content], i): DraftEvent => {
      const lines = content.split("\n").filter((l) => l !== "");
      return {
        ts: TS(i + 1),
        type: "file.diff",
        payload: {
          path: `${cwd}/${path}`,
          kind: "create",
          diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
          beforeHash: null,
          afterHash: sha256Hex(content),
          toolUseId: `t${i}`,
          source: "Write",
        },
      };
    }),
    ...extra,
  ];
  return buildChain(id, drafts);
}

const A = session("sess-a", "/work/a", [
  ["shared.ts", "export const shared = 1;\n"],
  ["only-a.ts", "export const a = 1;\n"],
  ["differs.ts", "export const v = 1;\n"],
]);
const B = session("sess-b", "/work/b", [
  ["shared.ts", "export const shared = 1;\n"],
  ["only-b.ts", "export const b = 1;\n"],
  ["differs.ts", "export const v = 2;\n"],
]);

describe("diffSessions", () => {
  it("classifies every file by reconstructed content, not by path alone", () => {
    const d = diffSessions({ a: { events: A, label: "A" }, b: { events: B, label: "B" } });
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f.verdict]));
    expect(byPath["shared.ts"]).toBe("converged");
    expect(byPath["differs.ts"]).toBe("diverged");
    expect(byPath["only-a.ts"]).toBe("only-a");
    expect(byPath["only-b.ts"]).toBe("only-b");
  });

  it("compares across different working directories", () => {
    // The two sessions live at /work/a and /work/b; identical content must
    // still line up, which only happens if paths are keyed relative to cwd.
    const d = diffSessions({ a: { events: A, label: "A" }, b: { events: B, label: "B" } });
    expect(d.files.some((f) => f.path.startsWith("/work"))).toBe(false);
    expect(d.files.find((f) => f.path === "shared.ts")!.verdict).toBe("converged");
  });

  it("reports both hashes for a divergence so the difference is checkable", () => {
    const d = diffSessions({ a: { events: A, label: "A" }, b: { events: B, label: "B" } });
    const differs = d.files.find((f) => f.path === "differs.ts")!;
    expect(differs.hashA).toBe(sha256Hex("export const v = 1;\n"));
    expect(differs.hashB).toBe(sha256Hex("export const v = 2;\n"));
    expect(differs.hashA).not.toBe(differs.hashB);
  });

  it("counts work per side and respects a cutoff", () => {
    const withWork = session(
      "sess-c",
      "/work/c",
      [["x.ts", "x\n"]],
      [
        { ts: TS(8), type: "tool.call", payload: { toolUseId: "t9", name: "Bash", input: {} } },
        {
          ts: TS(9),
          type: "cost",
          payload: {
            model: "m",
            usage: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          },
        },
      ],
    );
    const full = diffSessions({ a: { events: withWork, label: "C" }, b: { events: A, label: "A" } });
    expect(full.a.toolCalls).toBe(1);
    expect(full.a.outputTokens).toBe(7);

    // Cut before the cost event: its tokens must not be counted.
    const early = diffSessions({
      a: { events: withWork, label: "C", at: 2 },
      b: { events: A, label: "A" },
    });
    expect(early.a.outputTokens).toBe(0);
  });

  it("compares a directory on disk against a session", () => {
    const root = mkdtempSync(join(tmpdir(), "agit-difftree-"));
    for (const [rel, content] of [
      ["shared.ts", "export const shared = 1;\n"],
      ["differs.ts", "export const v = 99;\n"],
      ["new-in-fork.ts", "export const n = 1;\n"],
    ]) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
    const d = diffSessions({
      a: { events: A, label: "parent" },
      b: { tree: treeOnDisk(root), label: "fork" },
      from: { seq: 2, hash: "abc123def456" },
    });
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f.verdict]));
    expect(byPath["shared.ts"]).toBe("converged");
    expect(byPath["differs.ts"]).toBe("diverged");
    expect(byPath["new-in-fork.ts"]).toBe("only-b");
    expect(byPath["only-a.ts"]).toBe("only-a");
    // A directory has no session of its own, and the render says so rather
    // than reporting a misleading "0 events".
    expect(d.b.events).toBe(0);
    expect(renderDiff(d).join("\n")).toContain("files on disk (no session imported)");
  });

  it("names the shared starting point when there is one", () => {
    const d = diffSessions({
      a: { events: A, label: "parent" },
      b: { events: B, label: "fork" },
      from: { seq: 2, hash: "0123456789abcdef" },
    });
    expect(renderDiff(d)[0]).toContain("from event 2 (0123456789ab)");
    const plain = diffSessions({ a: { events: A, label: "A" }, b: { events: B, label: "B" } });
    expect(renderDiff(plain)[0]).toBe("A vs B");
  });

  it("states that a shell-only file is in neither tree", () => {
    const text = renderDiff(
      diffSessions({ a: { events: A, label: "A" }, b: { events: B, label: "B" } }),
    ).join("\n");
    expect(text).toContain("shell command is in neither tree");
    expect(text).toContain("SPEC section 5.7");
  });

  it("handles two sessions that touched nothing reconstructible", () => {
    const empty = buildChain("e", [{ ts: TS(0), type: "session.start", payload: { runtime: "test" } }]);
    const d = diffSessions({ a: { events: empty, label: "A" }, b: { events: empty, label: "B" } });
    expect(d.files).toEqual([]);
    expect(renderDiff(d).join("\n")).toContain("no reconstructible file edits");
  });

  it("is deterministic: file rows are sorted by path", () => {
    const d = diffSessions({ a: { events: A, label: "A" }, b: { events: B, label: "B" } });
    const paths = d.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });
});

describe("work since the fork point (#58)", () => {
  it("counts only what happened after `from` when a fork point is given", () => {
    const withWork = session(
      "sess-w",
      "/work/w",
      [["x.ts", "x\n"]],
      [
        { ts: TS(8), type: "tool.call", payload: { toolUseId: "t9", name: "Bash", input: {} } },
        {
          ts: TS(9),
          type: "cost",
          payload: {
            model: "m",
            usage: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          },
        },
        { ts: TS(10), type: "tool.call", payload: { toolUseId: "t10", name: "Bash", input: {} } },
        {
          ts: TS(11),
          type: "cost",
          payload: {
            model: "m",
            usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          },
        },
      ],
    );
    const whole = diffSessions({ a: { events: withWork, label: "A" }, b: { events: B, label: "B" } });
    expect(whole.a.toolCalls).toBe(2);
    expect(whole.a.outputTokens).toBe(9);

    // From the first cost event onward: one tool call and one cost remain.
    const fromSeq = withWork.find((e) => e.type === "cost")!.seq;
    const since = diffSessions({
      a: { events: withWork, label: "A" },
      b: { events: B, label: "B" },
      from: { seq: fromSeq, hash: withWork[fromSeq]!.hash },
    });
    expect(since.a.toolCalls).toBe(1);
    expect(since.a.outputTokens).toBe(2);
    expect(since.a.events).toBe(withWork.length - fromSeq - 1);
  });
});
