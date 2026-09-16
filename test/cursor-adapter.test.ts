/**
 * The Cursor adapter over a transcript built to the observed record shapes
 * (fixtures/cursor/generate/transcript.py): `{role, message}` records with
 * text and id-less `tool_use` blocks, `turn_ended` markers, and Cursor's
 * `<timestamp>` / `<user_query>` framing around what the person typed. The
 * assertions are what those shapes yield, what is counted rather than
 * guessed at, and what a live share may safely stream.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { cursorAdapter, parseCursorTimestamp } from "../src/adapters/cursor.js";
import { geminiCliAdapter } from "../src/adapters/gemini-cli.js";
import { kimiCodeAdapter } from "../src/adapters/kimi-code.js";
import { discoverSessionLogs } from "../src/discover.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { SessionFollower } from "../src/share.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SLUG = "Users-alex-Projects-demo";
const SID = "3f1c9a2e-7b4d-4e8f-9a1b-2c3d4e5f6a7b";
const SUB = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SESSION_DIR = join(ROOT, "fixtures", "cursor", SLUG, "agent-transcripts", SID);
const MAIN = join(SESSION_DIR, `${SID}.jsonl`);
const SUBAGENT = join(SESSION_DIR, "subagents", `${SUB}.jsonl`);

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-cursor-"));
const linesOf = (p: string): string[] =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
const payloads = (drafts: { type: string; payload: Json }[], type: string): Record<string, Json>[] =>
  drafts.filter((d) => d.type === type).map((d) => d.payload as Record<string, Json>);

function agit(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("Cursor's clock string", () => {
  it("reads the observed form, 12- and 24-hour times, negative and zero offsets, and nothing looser", () => {
    expect(parseCursorTimestamp("Tuesday, Jun 2, 2026, 11:20 AM (UTC+8)")).toBe("2026-06-02T03:20:00.000Z");
    expect(parseCursorTimestamp("Friday, Jul 31, 2026, 11:12 PM (UTC+8)")).toBe("2026-07-31T15:12:00.000Z");
    expect(parseCursorTimestamp("Monday, Dec 1, 2026, 12:05 AM (UTC-5)")).toBe("2026-12-01T05:05:00.000Z");
    expect(parseCursorTimestamp("Monday, Dec 1, 2026, 12:05 PM (UTC-5)")).toBe("2026-12-01T17:05:00.000Z");
    expect(parseCursorTimestamp("Jun 2, 2026, 23:59 (UTC)")).toBe("2026-06-02T23:59:00.000Z");
    expect(parseCursorTimestamp("Tuesday, Jun 2, 2026, 11:20 AM (UTC+5:30)")).toBe(
      "2026-06-02T05:50:00.000Z",
    );
    expect(parseCursorTimestamp("2026-06-02T03:20:00Z")).toBeNull();
    expect(parseCursorTimestamp("Tuesday, Jun 2, 2026, 25:20 AM (UTC+8)")).toBeNull();
    expect(parseCursorTimestamp("Tuesday, Zzz 2, 2026, 11:20 AM (UTC+8)")).toBeNull();
    expect(parseCursorTimestamp("")).toBeNull();
  });
});

describe("the Cursor adapter", () => {
  it("recognizes a transcript by its bare {role, message} records, and nothing else claims it", () => {
    const lines = linesOf(MAIN);
    expect(cursorAdapter.detect(lines)).toBe(true);
    expect(cursorAdapter.detect(linesOf(SUBAGENT))).toBe(true);
    expect(claudeCodeAdapter.detect(lines)).toBe(false);
    expect(codexAdapter.detect(lines)).toBe(false);
    expect(geminiCliAdapter.detect(lines)).toBe(false);
    expect(kimiCodeAdapter.detect(lines)).toBe(false);
    for (const other of [
      join("claude-code", "simple.jsonl"),
      join("codex", "simple.jsonl"),
      join("gemini-cli", "session.jsonl"),
      join("kimi-code", "01JRZ3K2Y7Q8W6X5V4T3S2R1P0", "wire.jsonl"),
    ]) {
      expect(cursorAdapter.detect(linesOf(join(ROOT, "fixtures", other))), other).toBe(false);
    }
    // Markers alone name nothing; a record carrying another format's keys is not Cursor's.
    expect(cursorAdapter.detect([JSON.stringify({ type: "turn_ended", status: "success" })])).toBe(false);
    expect(
      cursorAdapter.detect([JSON.stringify({ role: "user", uuid: "u1", message: { content: [] } })]),
    ).toBe(false);
  });

  it("maps the records in order, dates everything by the user's clock, and pairs nothing it was not given", () => {
    const r = cursorAdapter.convert(linesOf(MAIN), { path: MAIN });
    expect(r.sessionId).toBe(SID);
    expect(r.records).toBe(18);
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "tool.call", // Glob
      "tool.call", // Read
      "tool.call", // Shell
      "tool.call", // Write
      "tool.call", // StrReplace
      "tool.call", // ApplyPatch
      "message.assistant",
      "message.user",
      "tool.call", // Delete
      "tool.call", // TodoWrite
      "message.user", // Cursor's own, after a subagent finished
      "message.assistant",
      "message.user", // after an interruption, unwrapped
      "message.assistant",
      "session.end",
    ]);
    const start = r.drafts[0]!.payload as Record<string, Json>;
    expect(start).toMatchObject({
      runtime: "cursor",
      runtimeVersion: null,
      cwd: null,
      gitBranch: null,
      nativeSessionId: SID,
      native: { kind: "main", projectSlug: SLUG },
    });
    expect(r.drafts[0]!.ts).toBe("2026-06-02T03:20:00.000Z");

    const users = payloads(r.drafts, "message.user");
    expect(users.map((u) => u.text)).toEqual([
      "Summarize the two sales reports and write the totals to summary.md",
      "Delete notes.md — the key AKIAIOSFODNN7EXAMPLE leaked into it. Chart attached.",
      "Perform any necessary follow-up actions in response to the subagent completion above.",
      "Your previous response was interrupted. Continue from where you left off.",
    ]);
    expect(users[0]!.native).toEqual({ line: 0, timestampText: "Tuesday, Jun 2, 2026, 11:20 AM (UTC+8)" });
    expect(users[1]!.native).toMatchObject({ tags: ["image_files"] });
    expect(users[2]!.native).toEqual({ line: 11, injected: true });
    expect(users[3]!.native).toEqual({ line: 14, unwrapped: true, injected: true });

    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => c.name)).toEqual([
      "Glob",
      "Read",
      "Shell",
      "Write",
      "StrReplace",
      "ApplyPatch",
      "Delete",
      "TodoWrite",
    ]);
    expect(calls.every((c) => c.toolUseId === null)).toBe(true);
    expect(calls[3]!.input).toEqual({
      path: "/Users/alex/Projects/demo/summary.md",
      contents: "# Totals\n\nQ1: 120\nQ2: 140\n",
    });
    // Two calls in one record keep their block order.
    expect(calls[3]!.native).toEqual({ line: 5, block: 0 });
    expect(calls[4]!.native).toEqual({ line: 5, block: 1 });
    // ApplyPatch's input is the patch text; carried as one field, and said so.
    expect(calls[5]!.input).toEqual({
      patch:
        "*** Begin Patch\n*** Add File: /Users/alex/Projects/demo/notes.md\n+Q2 was recounted.\n*** End Patch",
    });
    expect(calls[5]!.native).toEqual({ line: 6, block: 0, inputWasString: true });

    const assistants = payloads(r.drafts, "message.assistant");
    expect(assistants.map((a) => a.model)).toEqual([null, null, null, null]);
    expect(assistants[0]!.blocks).toEqual([{ type: "text", text: "I'll look for the reports first." }]);

    // The clock: the second prompt moves it; the assistant records after it inherit it.
    expect(r.drafts[10]!.ts).toBe("2026-06-02T03:31:00.000Z");
    expect(r.drafts[11]!.ts).toBe("2026-06-02T03:31:00.000Z");
    expect(r.drafts[13]!.ts).toBe("2026-06-02T03:31:00.000Z");
    expect(r.drafts.at(-1)!.payload).toEqual({ reason: "transcript-end", synthesized: true });
    // Nothing is paired that the transcript never recorded.
    expect(payloads(r.drafts, "tool.result")).toEqual([]);
    expect(payloads(r.drafts, "file.diff")).toEqual([]);
    expect(payloads(r.drafts, "file.delete")).toEqual([]);
    expect(payloads(r.drafts, "cost")).toEqual([]);
  });

  it("counts every turn marker by status, a block it has no event for, prompts with no clock, and a record it does not know", () => {
    const r = cursorAdapter.convert(linesOf(MAIN), { path: MAIN });
    expect(r.skipped).toEqual({
      "turn-ended:success": 1,
      "turn-ended:error": 1,
      "turn-ended:aborted": 1,
      "assistant-block:image": 1,
      "user-timestamp-absent": 2,
      "unknown-record": 1,
    });
  });

  it("names a subagent's parent from the path, and derives an id when there is no path", () => {
    const sub = cursorAdapter.convert(linesOf(SUBAGENT), { path: SUBAGENT });
    expect(sub.sessionId).toBe(SUB);
    expect(sub.drafts[0]!.payload).toMatchObject({
      nativeSessionId: SUB,
      native: { kind: "subagent", parentSessionId: SID, projectSlug: SLUG },
    });
    expect(sub.drafts[0]!.ts).toBe("2026-06-02T03:25:00.000Z");
    expect(payloads(sub.drafts, "message.user")[0]!.native).toMatchObject({ injected: true });
    expect(payloads(sub.drafts, "tool.call").map((c) => c.name)).toEqual(["ReadFile"]);

    const bare = cursorAdapter.convert(linesOf(MAIN));
    expect(bare.sessionId).toMatch(/^cursor-[0-9a-f]{12}$/);
    expect(bare.skipped["session-id-derived-without-path"]).toBe(1);
    expect((bare.drafts[0]!.payload as Record<string, Json>).native).toEqual({ kind: "main" });
  });

  it("is deterministic, and refuses a transcript whose prompts carry no clock", () => {
    const a = cursorAdapter.convert(linesOf(MAIN), { path: MAIN });
    const b = cursorAdapter.convert(linesOf(MAIN), { path: MAIN });
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    const unclocked = [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\nhi\n</user_query>" }] },
      }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    ];
    expect(() => cursorAdapter.convert(unclocked)).toThrow(/no timestamp/);
  });
});

describe("a live share of a Cursor transcript", () => {
  it("streams records as they are appended, and ends the session only when told the file is done", () => {
    const dir = mktemp();
    const path = join(dir, `${SID}.jsonl`);
    const all = linesOf(MAIN);
    writeFileSync(path, all.slice(0, 2).join("\n") + "\n", "utf8");
    const follower = new SessionFollower(path, cursorAdapter);
    expect(follower.poll().map((e) => e.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
    ]);
    appendFileSync(path, all.slice(2, 10).join("\n") + "\n", "utf8");
    const next = follower.poll();
    expect(next.map((e) => e.type)).toEqual([
      "tool.call",
      "tool.call",
      "tool.call",
      "tool.call",
      "tool.call",
      "tool.call",
      "message.assistant",
      "message.user",
    ]);
    appendFileSync(path, all.slice(10).join("\n") + "\n", "utf8");
    expect(follower.poll().length).toBe(6);
    expect(follower.finish().map((e) => e.type)).toEqual(["session.end"]);
  });
});

describe("agit import on a Cursor transcript", () => {
  it("imports, redacts, verifies, replays, and is found where Cursor keeps transcripts", () => {
    const dir = mktemp();
    const r = agit(["import", MAIN, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("adapter     cursor@0.1.0");
    expect(r.out).toContain("turn-ended:success×1");
    expect(agit(["verify", SID, "--dir", dir]).code).toBe(0);
    const stored = readFileSync(join(dir, ".agit", "sessions", SID, "events.jsonl"), "utf8");
    expect(stored).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(stored).toContain("[REDACTED:");
    const replay = agit(["replay", SID, "--timeline", "--dir", dir]).out;
    expect(replay).toContain("StrReplace");
    expect(agit(["export", SID, "--atif", "--dir", dir]).code).toBe(0);
    expect(agit(["import", SUBAGENT, "--dir", dir]).code).toBe(0);
    expect(agit(["show", SUB, "--dir", dir]).out).toContain("cursor");

    const home = mktemp();
    const transcripts = join(home, ".cursor", "projects", SLUG, "agent-transcripts");
    mkdirSync(join(transcripts, SID, "subagents"), { recursive: true });
    writeFileSync(join(transcripts, SID, `${SID}.jsonl`), readFileSync(MAIN));
    writeFileSync(join(transcripts, SID, "subagents", `${SUB}.jsonl`), readFileSync(SUBAGENT));
    writeFileSync(join(transcripts, SID, "notes.txt"), "not a transcript", "utf8");
    mkdirSync(join(home, ".cursor", "projects", "empty-window", "agent-transcripts"), { recursive: true });
    const { logs, roots } = discoverSessionLogs(home, {});
    expect(logs.map((l) => [l.runtime, l.path]).sort()).toEqual(
      [
        ["cursor", join(transcripts, SID, `${SID}.jsonl`)],
        ["cursor", join(transcripts, SID, "subagents", `${SUB}.jsonl`)],
      ].sort(),
    );
    expect(roots.find((x) => x.runtime === "cursor")).toMatchObject({ exists: true, found: 2 });
  });
});
