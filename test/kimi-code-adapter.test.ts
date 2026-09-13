/**
 * The Kimi Code adapter over a wire.jsonl built the way WireFile writes
 * one: metadata line, then timestamped envelopes — streamed text and think
 * pieces, a tool call whose arguments arrive in parts, the step's
 * StatusUpdate, results, a steer, a retry, a notification. The assertions
 * are what folding that stream the way Kimi's own replay does yields.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { kimiCodeAdapter } from "../src/adapters/kimi-code.js";
import { discoverSessionLogs } from "../src/discover.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SID = "01JRZ3K2Y7Q8W6X5V4T3S2R1P0";
const WIRE = join(ROOT, "fixtures", "kimi-code", SID, "wire.jsonl");

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-kimi-"));
const linesOf = (p: string): string[] =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
const payloads = (drafts: { type: string; payload: Json }[], type: string): Record<string, Json>[] =>
  drafts.filter((d) => d.type === type).map((d) => d.payload as Record<string, Json>);

function agit(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, ...env },
      }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("the Kimi Code adapter", () => {
  it("recognizes a wire log by its metadata line and takes the session id from the directory", () => {
    const lines = linesOf(WIRE);
    expect(kimiCodeAdapter.detect(lines)).toBe(true);
    expect(kimiCodeAdapter.detect(linesOf(join(ROOT, "fixtures", "gemini-cli", "session.jsonl")))).toBe(
      false,
    );
    expect(kimiCodeAdapter.detect(linesOf(join(ROOT, "fixtures", "claude-code", "simple.jsonl")))).toBe(
      false,
    );
    const r = kimiCodeAdapter.convert(lines, { path: WIRE });
    expect(r.sessionId).toBe(SID);
    expect(r.records).toBe(32);
    // Without a path there is no directory to read: a derived id, and the report says so.
    const bare = kimiCodeAdapter.convert(lines);
    expect(bare.sessionId).toMatch(/^kimi-[0-9a-f]{12}$/);
    expect(bare.skipped["session-id-derived-without-path"]).toBe(1);
  });

  it("folds streamed pieces, argument parts and the step's usage into the events they make", () => {
    const r = kimiCodeAdapter.convert(linesOf(WIRE), { path: WIRE });
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "cost",
      "message.user",
      "tool.call",
      "cost",
      "tool.result",
      "message.user",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "cost",
      "session.end",
    ]);
    const start = r.drafts[0]!.payload as Record<string, Json>;
    expect(start).toMatchObject({
      runtime: "kimi-code",
      runtimeVersion: null,
      cwd: null,
      nativeSessionId: SID,
    });
    expect((start.native as Record<string, Json>).protocolVersion).toBe("1.10");

    // Two ThinkParts and two TextParts became one block each.
    const [a1, a2] = payloads(r.drafts, "message.assistant");
    expect(a1!.blocks).toEqual([
      { type: "thinking", text: "I should read the Makefile first." },
      { type: "text", text: "Let me look at the Makefile." },
    ]);
    expect(a1!.model).toBeNull();
    expect((a1!.native as Record<string, Json>).messageId).toBe("cmpl_a1");
    expect(a2!.blocks).toEqual([{ type: "text", text: "It builds every Go package with `go build ./...`." }]);

    // The ToolCallPart's arguments_part completed the call's JSON.
    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => [c.toolUseId, c.name, c.input])).toEqual([
      ["call_read_1", "ReadFile", { path: "Makefile" }],
      [
        "call_edit_1",
        "StrReplaceFile",
        { path: "Makefile", old_str: "all: build", new_str: "all: build test\ntest:\n\tgo test ./..." },
      ],
      ["call_sh_1", "Shell", { command: "make test" }],
    ]);
    const results = payloads(r.drafts, "tool.result");
    expect(results.map((x) => [x.toolUseId, x.isError, x.output])).toEqual([
      ["call_read_1", false, "all: build\nbuild:\n\tgo build ./...\n"],
      ["call_edit_1", false, "Edited Makefile"],
      ["call_sh_1", true, "go: no test files"],
    ]);
    expect((results[2]!.native as Record<string, Json>).message).toBe("exit status 1");

    // One cost per step, from token_usage, dated by the StatusUpdate that carried it.
    const costs = payloads(r.drafts, "cost");
    expect(costs.map((c) => c.usage)).toEqual([
      { inputTokens: 1500, outputTokens: 42, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 },
      { inputTokens: 1600, outputTokens: 18, cacheReadInputTokens: 1500, cacheCreationInputTokens: 0 },
      { inputTokens: 1700, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      { inputTokens: 1800, outputTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      { inputTokens: 1900, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    ]);
    expect(r.drafts[4]!.ts).toBe("2026-04-01T08:00:01.200Z");

    // Users: a string, a part list (its image counted), and a steer mid-turn.
    expect(payloads(r.drafts, "message.user").map((p) => p.text)).toEqual([
      "What does the Makefile build?",
      "Add a test target.",
      "and run it",
    ]);
    const ts = r.drafts.map((d) => d.ts);
    expect([...ts].sort()).toEqual(ts);
  });

  it("counts what it does not map, by name, and hashes nothing from a diff display block", () => {
    const r = kimiCodeAdapter.convert(linesOf(WIRE), { path: WIRE });
    expect(r.skipped).toEqual({
      "display-block:brief": 1,
      "display-block:diff": 1,
      "content-part:image_url": 1,
      "step:retried": 1,
      "message-type:Notification": 1,
    });
    expect(r.drafts.some((d) => d.type === "file.diff")).toBe(false);
  });

  it("drops everything before a /clear turn, as replay.py does, and is deterministic", () => {
    const lines = linesOf(WIRE);
    const clear = JSON.stringify({
      timestamp: 1775030405.0,
      message: { type: "TurnBegin", payload: { user_input: "/clear" } },
    });
    const cleared = [...lines.slice(0, 14), clear, ...lines.slice(14)];
    const r = kimiCodeAdapter.convert(cleared, { path: WIRE });
    expect(r.skipped["cleared-record"]).toBe(14);
    expect(payloads(r.drafts, "message.user").map((p) => p.text)).toEqual([
      "Add a test target.",
      "and run it",
    ]);
    const a = kimiCodeAdapter.convert(lines, { path: WIRE });
    const b = kimiCodeAdapter.convert(lines, { path: WIRE });
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
  });
});

describe("agit import on a Kimi Code session", () => {
  it("imports from the session directory, verifies, and is found where Kimi keeps sessions", () => {
    const dir = mktemp();
    const r = agit(["import", WIRE, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`imported ${SID}`);
    expect(agit(["verify", SID, "--dir", dir]).code).toBe(0);
    expect(agit(["replay", SID, "--timeline", "--dir", dir]).out).toContain("StrReplaceFile path=Makefile");
    expect(agit(["export", SID, "--atif", "--dir", dir]).code).toBe(0);

    const home = mktemp();
    const sessions = join(home, ".kimi", "sessions", "d41d8cd98f00b204e9800998ecf8427e");
    mkdirSync(join(sessions, SID, "subagents", "agent-1"), { recursive: true });
    writeFileSync(join(sessions, SID, "wire.jsonl"), readFileSync(WIRE));
    writeFileSync(join(sessions, SID, "context.jsonl"), "{}\n", "utf8");
    writeFileSync(join(sessions, SID, "subagents", "agent-1", "wire.jsonl"), readFileSync(WIRE));
    const { logs, roots } = discoverSessionLogs(home, {});
    expect(logs.map((l) => l.path).sort()).toEqual(
      [join(sessions, SID, "wire.jsonl"), join(sessions, SID, "subagents", "agent-1", "wire.jsonl")].sort(),
    );
    expect(roots.find((x) => x.runtime === "kimi-code")).toMatchObject({ exists: true, found: 2 });
    // KIMI_SHARE_DIR moves the root, as the docs say.
    const elsewhere = mktemp();
    mkdirSync(join(elsewhere, "sessions", "abc", SID), { recursive: true });
    writeFileSync(join(elsewhere, "sessions", "abc", SID, "wire.jsonl"), readFileSync(WIRE));
    expect(discoverSessionLogs(home, { KIMI_SHARE_DIR: elsewhere }).logs.map((l) => l.path)).toEqual([
      join(elsewhere, "sessions", "abc", SID, "wire.jsonl"),
    ]);
  });
});
