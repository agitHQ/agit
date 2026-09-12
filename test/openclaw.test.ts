import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { createHash } from "node:crypto";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { reconstructTree } from "../src/fork.js";
import { timelineLines } from "../src/state.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import type { DraftEvent, Json } from "../src/format/events.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const openclawLines = readFileSync(join(ROOT, "fixtures", "openclaw", "simple.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const payloadOf = (drafts: DraftEvent[], i: number): { [k: string]: Json } =>
  drafts[i]!.payload as { [k: string]: Json };

describe("openclaw adapter", () => {
  it("detects OpenClaw transcripts and does not claim Claude/Codex files", () => {
    expect(openclawAdapter.detect(openclawLines)).toBe(true);
    expect(openclawAdapter.detect(["not json", "{}"])).toBe(false);
    expect(claudeCodeAdapter.detect(openclawLines)).toBe(false);
    expect(codexAdapter.detect(openclawLines)).toBe(false);
  });

  it("maps the fixture to the expected event sequence", () => {
    const res = openclawAdapter.convert(openclawLines);

    expect(res.sessionId).toBe("0199openclaw-aaaa-7bbb-8ccc-ddddeeee0001");
    expect(res.records).toBe(6);
    expect(res.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "cost",
      "tool.call",
      "tool.result",
      "message.assistant",
      "cost",
      "session.end",
    ]);
  });

  it("maps session metadata", () => {
    const res = openclawAdapter.convert(openclawLines);
    const start = payloadOf(res.drafts, 0);

    expect(start.runtime).toBe("openclaw");
    expect(start.nativeSessionId).toBe("0199openclaw-aaaa-7bbb-8ccc-ddddeeee0001");
    expect(start.cwd).toBe("/workspace/demo");
    expect(start.adapter).toEqual({
      name: "openclaw",
      version: "0.2.0",
    });
  });

  it("maps assistant text and tool calls", () => {
    const res = openclawAdapter.convert(openclawLines);

    const assistant = res.drafts.filter((d) => d.type === "message.assistant");
    expect(assistant).toHaveLength(2);
    // Views read `blocks`; a payload without it renders as an empty turn.
    expect(payloadOf(res.drafts, 2).blocks).toEqual([
      { type: "text", text: "I'll check the project status." },
    ]);
    expect(payloadOf(res.drafts, 2).model).toBe("gpt-5.5");
    expect(payloadOf(res.drafts, 2).native).toEqual({ id: "msg-assistant-1", parentId: "msg-user-1" });

    const call = res.drafts.find((d) => d.type === "tool.call")!;
    expect(payloadOf(res.drafts, res.drafts.indexOf(call))).toEqual({
      toolUseId: "functions.exec:1",
      name: "exec",
      input: { command: "git status --short" },
      native: { id: "msg-assistant-2", parentId: "msg-assistant-1" },
    });
  });

  it("maps tool results and costs", () => {
    const res = openclawAdapter.convert(openclawLines);

    const result = res.drafts.find((d) => d.type === "tool.result")!;
    const resultPayload = payloadOf(res.drafts, res.drafts.indexOf(result));

    expect(resultPayload).toEqual({
      toolUseId: "functions.exec:1",
      name: "exec",
      output: " M src/adapters/openclaw.ts",
      isError: false,
      native: { id: "msg-tool-1", parentId: "msg-assistant-2" },
    });

    const costs = res.drafts.filter((d) => d.type === "cost");
    expect(costs).toHaveLength(2);

    // Same shape the other adapters emit: model, four token counts, and
    // everything runtime-specific under native. Not the dollar figure
    // OpenClaw records beside its tokens: SPEC §5.9 keeps prices out of the
    // log (a display-time computation, stale and unverifiable once hashed),
    // and the drop is counted so the import report names it.
    expect(payloadOf(res.drafts, res.drafts.indexOf(costs[0]!))).toEqual({
      model: "gpt-5.5",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 0,
      },
      native: {
        id: "msg-assistant-1",
        parentId: "msg-user-1",
        provider: "openai",
      },
    });
    expect(res.skipped["cost-usd-not-stored (SPEC §5.9)"]).toBe(2); // one per usage record in the fixture
  });

  it("emits the same payload shape as the other adapters", () => {
    // The bug this guards: an assistant payload without `blocks` imports
    // cleanly and then renders as "[empty]" in replay, show, the share page,
    // fork's SEED.md and the HTML export — the agent's words vanish.
    const claudeLines = readFileSync(join(ROOT, "fixtures", "claude-code", "simple.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const mine = openclawAdapter.convert(openclawLines).drafts;
    const theirs = claudeCodeAdapter.convert(claudeLines).drafts;

    const keysOf = (drafts: DraftEvent[], type: string): string[] => {
      const d = drafts.find((x) => x.type === type);
      return d ? Object.keys(d.payload as Record<string, unknown>).sort() : [];
    };
    for (const type of ["message.user", "message.assistant", "tool.call", "tool.result", "cost"]) {
      expect(keysOf(mine, type), `${type} payload keys`).toEqual(
        expect.arrayContaining(keysOf(theirs, type).filter((k) => k !== "structured")),
      );
    }

    // And the rendered timeline shows the text rather than an empty turn.
    const events = buildChain("oc", mine);
    const assistantLine = timelineLines(events).find((l) => l.includes("assistant"))!;
    expect(assistantLine).toContain("[text]");
    expect(assistantLine).not.toContain("[empty]");
  });

  it("does not synthesize session.end in live mode", () => {
    const res = openclawAdapter.convert(openclawLines, { live: true });

    expect(res.drafts.at(-1)?.type).toBe("cost");
    expect(res.drafts.some((d) => d.type === "session.end")).toBe(false);
  });

  it("skips unsupported transcript record types", () => {
    const lines = [
      openclawLines[0]!,
      JSON.stringify({
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-09-08T10:01:00.000Z",
        message: "summary",
      }),
      JSON.stringify({
        type: "custom",
        id: "custom-1",
        timestamp: "2026-09-08T10:01:01.000Z",
      }),
    ];

    const res = openclawAdapter.convert(lines);

    expect(res.skipped).toEqual({
      "type:compaction": 1,
      "type:custom": 1,
    });
  });

  it("skips unknown message roles instead of guessing", () => {
    const lines = [
      openclawLines[0]!,
      JSON.stringify({
        type: "message",
        id: "msg-unknown",
        timestamp: "2026-09-08T10:01:00.000Z",
        message: {
          role: "system",
          content: [{ type: "text", text: "system message" }],
        },
      }),
    ];

    const res = openclawAdapter.convert(lines);

    expect(res.skipped).toEqual({
      "message:system": 1,
    });
    expect(res.drafts.map((d) => d.type)).toEqual(["session.start", "session.end"]);
  });
});

describe("apply_patch → file events (fixtures/openclaw/edits.jsonl)", () => {
  const editLines = readFileSync(join(ROOT, "fixtures", "openclaw", "edits.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const res = openclawAdapter.convert(editLines);
  const events = buildChain(res.sessionId, res.drafts);
  const fileEvents = res.drafts.filter((d) => d.type === "file.diff" || d.type === "file.delete");
  const pay = (d: DraftEvent): { [k: string]: Json } => d.payload as { [k: string]: Json };
  const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

  it("maps add, update, EOF append, delete, rename and a multi-file patch, in patch order", () => {
    expect(fileEvents.map((d) => [d.type, pay(d).kind ?? "delete", pay(d).path])).toEqual([
      ["file.diff", "create", "/workspace/demo/hello.py"],
      ["file.diff", "modify", "/workspace/demo/hello.py"],
      ["file.diff", "create", "/workspace/demo/notes.md"],
      ["file.diff", "modify", "/workspace/demo/notes.md"],
      ["file.delete", "delete", "/workspace/demo/hello.py"],
      ["file.delete", "delete", "/workspace/demo/notes.md"],
      ["file.diff", "create", "/workspace/demo/docs/notes.md"],
      ["file.diff", "create", "/workspace/demo/z.py"],
      ["file.diff", "create", "/workspace/demo/a.py"],
    ]);
  });

  it("hashes exactly the bytes OpenClaw wrote, update rules included", () => {
    const [create, modify, , eofAppend, , , renamed] = fileEvents;
    expect(pay(create!).afterHash).toBe(sha("def hello():\n    print('hi')\n"));
    expect(pay(modify!).beforeHash).toBe(sha("def hello():\n    print('hi')\n"));
    expect(pay(modify!).afterHash).toBe(sha("def hello():\n    print('hello, world')\n"));
    expect(pay(eofAppend!).afterHash).toBe(sha("# notes\n\n- shipped\n- tested\n"));
    expect(pay(renamed!).afterHash).toBe(sha("# Notes\n\n- shipped\n- tested\n"));
    expect(pay(fileEvents[5]!).beforeHash).toBe(sha("# notes\n\n- shipped\n- tested\n"));
  });

  it("skips what it cannot vouch for, and says which", () => {
    expect(res.skipped).toMatchObject({
      "apply_patch:update(base content not in log)": 1, // existing.py predates the session
      "apply_patch:failed(nothing attributed)": 1,
      "apply_patch:no-op": 1,
      "apply_patch:unparseable input": 1,
    });
  });

  it("every file event follows the tool.result that confirmed it", () => {
    for (const [i, d] of res.drafts.entries()) {
      if (d.type !== "file.diff" && d.type !== "file.delete") continue;
      const before = res.drafts
        .slice(0, i)
        .reverse()
        .find((x) => x.type === "tool.result")!;
      expect(pay(before).toolUseId).toBe(pay(d).toolUseId);
    }
  });

  it("the reconstructed tree is what the session left behind", () => {
    const { files, skipped } = reconstructTree(events, events.length - 1);
    expect(skipped).toEqual([]);
    expect(files.map((f) => f.path).sort()).toEqual([
      "/workspace/demo/a.py",
      "/workspace/demo/docs/notes.md",
      "/workspace/demo/z.py",
    ]);
    expect(files.find((f) => f.path.endsWith("docs/notes.md"))!.content).toBe(
      "# Notes\n\n- shipped\n- tested\n",
    );
  });

  it("imports byte-identically", () => {
    const again = openclawAdapter.convert(editLines);
    expect(toJsonl(buildChain(again.sessionId, again.drafts))).toBe(toJsonl(events));
  });
});
