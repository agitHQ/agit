/**
 * The Gemini CLI adapter over a recording built the way ChatRecordingService
 * writes one: a metadata line, messages appended and re-appended as their
 * tokens and tool calls land, `$set` after each, and a `$rewindTo`. The
 * adapter folds those the way the CLI's own loader does; the assertions
 * here are what that fold yields, and what a live share may safely stream.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { clineSdkAdapter } from "../src/adapters/cline-sdk.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { geminiCliAdapter } from "../src/adapters/gemini-cli.js";
import { discoverSessionLogs } from "../src/discover.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { SessionFollower, StabilityError } from "../src/share.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const JSONL = join(ROOT, "fixtures", "gemini-cli", "session.jsonl");
const LEGACY = join(ROOT, "fixtures", "gemini-cli", "legacy.json");
const SID = "0c3d7a1e-5b2f-4c8a-9d6e-1f2a3b4c5d6e";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-gemini-"));
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

describe("the Gemini CLI adapter", () => {
  it("recognizes a recording by its metadata line, and nothing else claims it", () => {
    const lines = linesOf(JSONL);
    expect(geminiCliAdapter.detect(lines)).toBe(true);
    expect(geminiCliAdapter.detect(linesOf(LEGACY))).toBe(true);
    expect(claudeCodeAdapter.detect(lines)).toBe(false);
    expect(codexAdapter.detect(lines)).toBe(false);
    expect(clineSdkAdapter.detect(lines)).toBe(false);
    // A Cline SDK document carries sessionId too, but never projectHash.
    expect(
      geminiCliAdapter.detect(linesOf(join(ROOT, "fixtures", "cline-sdk", "simple.messages.json"))),
    ).toBe(false);
    expect(geminiCliAdapter.detect(linesOf(join(ROOT, "fixtures", "claude-code", "simple.jsonl")))).toBe(
      false,
    );
  });

  it("folds the upserts the way the CLI's loader does, and maps the result", () => {
    const r = geminiCliAdapter.convert(linesOf(JSONL));
    expect(r.sessionId).toBe(SID);
    expect(r.records).toBe(18);
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "cost",
      "tool.call",
      "tool.result",
      "message.user",
      "message.assistant",
      "cost",
      "tool.call",
      "tool.call",
      "tool.result",
      "session.end",
    ]);
    const start = r.drafts[0]!.payload as Record<string, Json>;
    expect(start).toMatchObject({
      runtime: "gemini-cli",
      runtimeVersion: null,
      cwd: null,
      nativeSessionId: SID,
    });
    expect((start.native as Record<string, Json>).kind).toBe("main");
    expect(r.drafts[0]!.ts).toBe("2026-04-02T09:15:00.000Z");

    // g1 was pushed four times; its final form has thoughts, text, tokens and a finished call.
    const [a1] = payloads(r.drafts, "message.assistant");
    expect(a1!.blocks).toEqual([
      { type: "thinking", text: "Plan\nOne shell call is enough." },
      { type: "text", text: "I'll list them." },
    ]);
    expect(a1!.model).toBe("gemini-2.5-pro");
    const [c1] = payloads(r.drafts, "cost");
    expect(c1!.usage).toEqual({
      inputTokens: 340,
      outputTokens: 21,
      cacheReadInputTokens: 120,
      cacheCreationInputTokens: 0,
    });
    expect((c1!.native as Record<string, Json>).thoughtsTokens).toBe(9);
    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => [c.toolUseId, c.name, c.input])).toEqual([
      ["call-run-shell-1", "run_shell_command", { command: "ls" }],
      ["call-rm-1", "run_shell_command", { command: "rm -rf build" }],
      ["call-read-1", "read_file", { absolute_path: "/work/notes.txt" }],
    ]);
    const results = payloads(r.drafts, "tool.result");
    expect(results.map((x) => [x.toolUseId, x.isError, x.output])).toEqual([
      ["call-run-shell-1", false, "README.md\nsrc\n"],
      ["call-read-1", true, "File not found: /work/notes.txt"],
    ]);
    // A string content, a user message.
    expect(payloads(r.drafts, "message.user").map((p) => p.text)).toEqual([
      "List the files in this directory.",
      "Now delete the build directory and read notes.txt",
    ]);
    // Timestamps are the records' own: the tool call's, not its message's.
    expect(r.drafts[4]!.ts).toBe("2026-04-02T09:15:04.000Z");
  });

  it("counts a rewind, a cancelled call, and a message type agit has no event for", () => {
    const r = geminiCliAdapter.convert(linesOf(JSONL));
    expect(r.skipped).toEqual({
      "rewind-dropped-message": 2,
      "tool-call-cancelled": 1,
      "message-type:warning": 1,
    });
    // The rewound turn is gone entirely, its image part included.
    expect(JSON.stringify(r.drafts)).not.toContain("never mind");
  });

  it("reads the legacy single-document form to the same events", () => {
    const fromLog = geminiCliAdapter.convert(linesOf(JSONL));
    const fromDoc = geminiCliAdapter.convert(linesOf(LEGACY));
    expect(fromDoc.records).toBe(1);
    expect(toJsonl(buildChain(fromDoc.sessionId, fromDoc.drafts))).toBe(
      toJsonl(buildChain(fromLog.sessionId, fromLog.drafts)),
    );
  });

  it("is deterministic and refuses a file with no timestamp", () => {
    const a = geminiCliAdapter.convert(linesOf(JSONL));
    const b = geminiCliAdapter.convert(linesOf(JSONL));
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    const bare = [
      JSON.stringify({ sessionId: "x", projectHash: "y" }),
      JSON.stringify({ id: "m", type: "user", content: "hi" }),
    ];
    expect(() => geminiCliAdapter.convert(bare)).toThrow(/no timestamp/);
  });
});

describe("a live share of a recording that re-pushes its last message", () => {
  it("holds the last message back until a newer one settles it, so the streamed prefix never changes", () => {
    const dir = mktemp();
    const path = join(dir, "session-live.jsonl");
    const all = linesOf(JSONL);
    // Metadata, u1, $set, g1 (first push: no tokens yet).
    writeFileSync(path, all.slice(0, 4).join("\n") + "\n", "utf8");
    const follower = new SessionFollower(path, geminiCliAdapter);
    const first = follower.poll();
    expect(first.map((e) => e.type)).toEqual(["session.start", "message.user"]);

    // g1 re-pushed with tokens, then with its tool call twice: still held.
    appendFileSync(path, all.slice(4, 8).join("\n") + "\n", "utf8");
    expect(follower.poll()).toEqual([]);
    // u2 lands: g1 is settled, and comes out in its final form.
    appendFileSync(path, all.slice(8, 9).join("\n") + "\n", "utf8");
    const next = follower.poll();
    expect(next.map((e) => e.type)).toEqual(["message.assistant", "cost", "tool.call", "tool.result"]);
    expect((next[2]!.payload as { toolUseId: string }).toolUseId).toBe("call-run-shell-1");

    // The rest, including the rewind of u3/g3, which never streamed.
    appendFileSync(path, all.slice(9).join("\n") + "\n", "utf8");
    const rest = follower.poll();
    expect(rest.map((e) => e.type)).toEqual([
      "message.user",
      "message.assistant",
      "cost",
      "tool.call",
      "tool.call",
      "tool.result",
    ]);
    const tail = follower.finish();
    expect(tail.map((e) => e.type)).toEqual(["session.end"]);
  });

  it("stops as a rewrite when a rewind takes back what was already streamed", () => {
    const dir = mktemp();
    const path = join(dir, "session-rewind.jsonl");
    const all = linesOf(JSONL);
    writeFileSync(path, all.slice(0, 9).join("\n") + "\n", "utf8"); // through u2, which settles g1
    const follower = new SessionFollower(path, geminiCliAdapter);
    expect(follower.poll().length).toBeGreaterThan(4); // u1 and g1 streamed
    appendFileSync(path, JSON.stringify({ $rewindTo: "u1" }) + "\n", "utf8");
    expect(() => follower.poll()).toThrow(StabilityError);
  });
});

describe("agit import on a Gemini CLI recording", () => {
  it("imports, verifies, exports, and is found where Gemini CLI keeps recordings", () => {
    const dir = mktemp();
    const r = agit(["import", JSONL, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("adapter     gemini-cli@0.2.0");
    expect(r.out).toContain("rewind-dropped-message×2");
    expect(agit(["verify", SID, "--dir", dir]).code).toBe(0);
    expect(agit(["export", SID, "--otel", "--dir", dir]).code).toBe(0);
    expect(agit(["replay", SID, "--timeline", "--dir", dir]).out).toContain("run_shell_command command=ls");

    const home = mktemp();
    const chats = join(home, ".gemini", "tmp", "a1b2c3", "chats");
    mkdirSync(join(chats, SID), { recursive: true });
    writeFileSync(join(chats, "session-2026-04-02T09-15-0c3d7a1e.jsonl"), readFileSync(JSONL));
    writeFileSync(join(chats, SID, "sub-1.jsonl"), readFileSync(JSONL)); // a subagent's recording
    writeFileSync(join(chats, "session-old.json"), readFileSync(LEGACY)); // a legacy recording
    writeFileSync(join(chats, "notes.txt"), "not a recording", "utf8");
    const { logs, roots } = discoverSessionLogs(home, {});
    expect(logs.map((l) => l.path).sort()).toEqual(
      [
        join(chats, "session-2026-04-02T09-15-0c3d7a1e.jsonl"),
        join(chats, SID, "sub-1.jsonl"),
        join(chats, "session-old.json"),
      ].sort(),
    );
    expect(roots.find((x) => x.runtime === "gemini-cli")).toMatchObject({ exists: true, found: 3 });
  });
});
