/**
 * The pi adapter over a session built the way pi's SessionManager writes
 * one: a version-3 header and a tree of entries. The assertions are what
 * reading it the way pi's own loader does yields — and, for `write` and
 * `edit`, what replaying pi's own tools over content the log holds proves.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import { classifySessionLog, piAdapter } from "../src/adapters/pi.js";
import { discoverSessionLogs } from "../src/discover.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { applyUnifiedDiff } from "../src/patch.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SID = "8f3b2c1d-4e5a-4b6c-9d7e-0f1a2b3c4d5e";
const FILE = join(ROOT, "fixtures", "pi", `2026-05-28T20-26-40-000Z_${SID}.jsonl`);

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-pi-"));
const linesOf = (p: string): string[] =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
const payloads = (drafts: { type: string; payload: Json }[], type: string): Record<string, Json>[] =>
  drafts.filter((d) => d.type === type).map((d) => d.payload as Record<string, Json>);
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

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

const header = (version: number | undefined, cwd = "/home/dev/hello"): string =>
  JSON.stringify({
    type: "session",
    ...(version === undefined ? {} : { version }),
    id: SID,
    timestamp: "2026-05-28T20:26:40.000Z",
    cwd,
  });
let n = 0;
const entry = (type: string, body: Record<string, Json>, parentId: string | null = null): string =>
  JSON.stringify({
    type,
    id: `e${++n}`,
    parentId,
    timestamp: `2026-05-28T20:26:${String(41 + (n % 19)).padStart(2, "0")}.000Z`,
    ...body,
  });
const assistant = (content: Json[], extra: Record<string, Json> = {}): Record<string, Json> => ({
  message: {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
    stopReason: "toolUse",
    timestamp: 1780000001000,
    ...extra,
  },
});
const result = (
  id: string,
  name: string,
  text: string,
  details?: Json,
  isError = false,
): Record<string, Json> => ({
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
    isError,
    timestamp: 1780000002000,
  },
});

describe("telling pi from OpenClaw, which writes the same format", () => {
  it("splits on session version first, then on whose tools a version-3 file calls", () => {
    const user = entry("message", { message: { role: "user", content: "hi", timestamp: 1 } });
    expect(classifySessionLog([header(4), user])).toBe("openclaw");
    expect(classifySessionLog([header(3), user])).toBe("pi");
    expect(classifySessionLog([header(undefined), user])).toBe("pi");
    const exec = entry(
      "message",
      assistant([{ type: "toolCall", id: "c1", name: "exec", arguments: { command: "ls" } }]),
    );
    expect(classifySessionLog([header(3), user, exec])).toBe("openclaw");
    const bash = entry(
      "message",
      assistant([{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }]),
    );
    expect(classifySessionLog([header(3), user, bash])).toBe("pi");
    expect(classifySessionLog(linesOf(join(ROOT, "fixtures", "openclaw", "simple.jsonl")))).toBe("openclaw");
    expect(classifySessionLog(linesOf(join(ROOT, "fixtures", "gemini-cli", "session.jsonl")))).toBeNull();
    expect(classifySessionLog(linesOf(join(ROOT, "fixtures", "claude-code", "simple.jsonl")))).toBeNull();
    // Each adapter claims only its own.
    expect(piAdapter.detect(linesOf(FILE))).toBe(true);
    expect(openclawAdapter.detect(linesOf(FILE))).toBe(false);
    for (const f of ["simple.jsonl", "edits.jsonl"]) {
      expect(openclawAdapter.detect(linesOf(join(ROOT, "fixtures", "openclaw", f)))).toBe(true);
      expect(piAdapter.detect(linesOf(join(ROOT, "fixtures", "openclaw", f)))).toBe(false);
    }
  });
});

describe("the pi adapter", () => {
  it("reads the session in file order, keeping the tree under native and counting the rest by name", () => {
    const r = piAdapter.convert(linesOf(FILE), { path: FILE });
    expect(r.sessionId).toBe(SID);
    expect(r.records).toBe(18);
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "tool.call",
      "cost",
      "tool.result",
      "file.diff",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "file.diff",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "cost",
      "cost",
      "message.user",
      "message.assistant",
      "cost",
      "session.end",
    ]);
    const start = payloads(r.drafts, "session.start")[0]!;
    expect(start).toMatchObject({ runtime: "pi", cwd: "/home/dev/hello", nativeSessionId: SID });
    expect(start.native).toEqual({ sessionVersion: 3, parentSession: null });
    expect(r.drafts[0]!.ts).toBe("2026-05-28T20:26:40.000Z");
    expect(r.drafts[2]!.ts).toBe("2026-05-28T20:26:44.000Z");

    const a = payloads(r.drafts, "message.assistant");
    expect(a[0]!.blocks).toEqual([
      { type: "thinking", text: "Read the entry point first, then a single edit." },
      { type: "text", text: "Reading the entry point." },
    ]);
    expect(a[0]!).toMatchObject({ model: "claude-sonnet-5", stopReason: "toolUse" });
    expect(a[0]!.native).toMatchObject({
      entryId: "b2c3d4e5",
      parentId: "a1b2c3d4",
      provider: "anthropic",
      api: "anthropic-messages",
    });
    expect(a[2]!.model).toBe("gpt-5.5");
    // The branch: the last user turn hangs off the bash call, not the entry before it.
    const users = payloads(r.drafts, "message.user");
    expect(users[1]!.text).toBe("Actually skip the tests.");
    expect(users[1]!.native).toEqual({ entryId: "d6e7f8a9", parentId: "b8c9d0e1" });

    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => [c.name, c.toolUseId])).toEqual([
      ["read", "call_read_1"],
      ["edit", "call_edit_1"],
      ["write", "call_write_1"],
      ["bash", "call_bash_1"],
    ]);
    const results = payloads(r.drafts, "tool.result");
    expect(results.map((x) => [x.toolUseId, x.isError])).toEqual([
      ["call_read_1", false],
      ["call_edit_1", false],
      ["call_write_1", false],
      ["call_bash_1", true],
    ]);
    expect(results[1]!.structured).toMatchObject({ firstChangedLine: 3 });
    expect(results[1]!.native).toMatchObject({ toolName: "edit" });

    const costs = payloads(r.drafts, "cost");
    expect(costs).toHaveLength(7);
    expect(costs[1]!.usage).toEqual({
      inputTokens: 1400,
      outputTokens: 60,
      cacheReadInputTokens: 1100,
      cacheCreationInputTokens: 200,
    });
    // The compaction's own usage, attributed to the model then in force (the model_change to gpt-5.5).
    expect(costs[5]!).toMatchObject({ model: "gpt-5.5" });
    expect(costs[5]!.native).toMatchObject({ entryType: "compaction" });
    expect(JSON.stringify(r.drafts)).not.toContain("0.003");
    expect(r.skipped).toEqual({
      "cost-usd-not-stored (SPEC §5.9)": 7,
      "write:prior content unknown": 1,
      "entry:model_change": 1,
      "message-role:bashExecution": 1,
      "message-role:custom": 1,
      "entry:compaction": 1,
      "entry:label": 1,
    });
  });

  it("hashes a write over the bytes pi wrote, and an edit over the replay of pi's own patch", () => {
    const r = piAdapter.convert(linesOf(FILE), { path: FILE });
    const diffs = payloads(r.drafts, "file.diff");
    const before = 'import { greet } from "./greet";\n\nconsole.log("hi");\n';
    const after = 'import { greet } from "./greet";\n\nconsole.log(greet("world"));\n';
    expect(diffs[0]).toMatchObject({
      path: "/home/dev/hello/src/index.ts",
      kind: "modify",
      beforeHash: sha(before),
      afterHash: sha(after),
      toolUseId: "call_edit_1",
      source: "edit",
    });
    // pi's patch is the event's diff when nothing was normalized away, and it replays.
    expect(diffs[0]!.diff).toBe(
      (payloads(r.drafts, "tool.result")[1]!.structured as Record<string, Json>).patch,
    );
    expect(applyUnifiedDiff(before, diffs[0]!.diff as string)).toBe(after);
    const readme = "# hello\n\nGreets the world.\n";
    expect(diffs[1]).toMatchObject({
      path: "/home/dev/hello/README.md",
      kind: "create",
      beforeHash: null,
      afterHash: sha(readme),
      toolUseId: "call_write_1",
      source: "write",
    });
    expect(applyUnifiedDiff(null, diffs[1]!.diff as string)).toBe(readme);
  });

  it("replays an edit on a CRLF file with a BOM the way edit.ts does, and skips what it cannot verify", () => {
    const crlf = "﻿a\r\nb\r\nc\r\n";
    const patch = "--- x.txt\n+++ x.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    const lines = [
      header(3),
      entry(
        "message",
        assistant([
          { type: "toolCall", id: "w1", name: "write", arguments: { path: "x.txt", content: crlf } },
        ]),
      ),
      entry("message", result("w1", "write", "Successfully wrote to x.txt")),
      entry(
        "message",
        assistant([
          {
            type: "toolCall",
            id: "e1",
            name: "edit",
            arguments: { path: "./x.txt", edits: [{ oldText: "b", newText: "B" }] },
          },
        ]),
      ),
      entry(
        "message",
        result("e1", "edit", "Successfully replaced 1 block(s) in x.txt.", {
          diff: "",
          patch,
          firstChangedLine: 2,
        }),
      ),
      // A second edit whose patch no longer matches the content agit holds.
      entry(
        "message",
        assistant([
          {
            type: "toolCall",
            id: "e2",
            name: "edit",
            arguments: { path: "x.txt", edits: [{ oldText: "zzz", newText: "y" }] },
          },
        ]),
      ),
      entry(
        "message",
        result("e2", "edit", "Successfully replaced 1 block(s) in x.txt.", {
          diff: "",
          patch: "--- x.txt\n+++ x.txt\n@@ -1,1 +1,1 @@\n-zzz\n+y\n",
        }),
      ),
      // An edit to a file the log never held, and a failed edit.
      entry(
        "message",
        assistant([
          { type: "toolCall", id: "e3", name: "edit", arguments: { path: "/elsewhere/y.txt", edits: [] } },
        ]),
      ),
      entry(
        "message",
        result("e3", "edit", "ok", { diff: "", patch: "--- y\n+++ y\n@@ -1,1 +1,1 @@\n-1\n+2\n" }),
      ),
      entry(
        "message",
        assistant([{ type: "toolCall", id: "e4", name: "edit", arguments: { path: "x.txt", edits: [] } }]),
      ),
      entry("message", result("e4", "edit", "Could not find the exact text in x.txt.", undefined, true)),
      // A tilde path is pi's home, which agit does not know.
      entry(
        "message",
        assistant([
          { type: "toolCall", id: "w2", name: "write", arguments: { path: "~/notes.md", content: "n\n" } },
        ]),
      ),
      entry("message", result("w2", "write", "Successfully wrote to ~/notes.md")),
    ];
    const r = piAdapter.convert(lines);
    const diffs = payloads(r.drafts, "file.diff");
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ path: "/home/dev/hello/x.txt", kind: "create", afterHash: sha(crlf) });
    const expected = "﻿a\r\nB\r\nc\r\n";
    expect(diffs[1]).toMatchObject({
      path: "/home/dev/hello/x.txt",
      kind: "modify",
      beforeHash: sha(crlf),
      afterHash: sha(expected),
    });
    // Normalization happened, so the event's diff is a full-file one that replays to the same bytes.
    expect(diffs[1]!.diff).not.toBe(patch);
    expect(applyUnifiedDiff(crlf, diffs[1]!.diff as string)).toBe(expected);
    expect(r.skipped["edit:patch did not apply"]).toBe(1);
    expect(r.skipped["edit:base content not in log"]).toBe(1);
    expect(r.skipped["write:path not resolvable"]).toBe(1);
    expect(payloads(r.drafts, "tool.result").filter((x) => x.isError)).toHaveLength(1);
  });

  it("seeds later edits from an untruncated read only, and from --base", () => {
    const text = "one\ntwo\n";
    const patch = "--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
    const mk = (readArgs: Record<string, Json>, readDetails?: Json): string[] => [
      header(3),
      entry(
        "message",
        assistant([{ type: "toolCall", id: "r1", name: "read", arguments: { path: "f.txt", ...readArgs } }]),
      ),
      entry("message", result("r1", "read", text, readDetails)),
      entry(
        "message",
        assistant([
          {
            type: "toolCall",
            id: "e1",
            name: "edit",
            arguments: { path: "f.txt", edits: [{ oldText: "two", newText: "TWO" }] },
          },
        ]),
      ),
      entry(
        "message",
        result("e1", "edit", "Successfully replaced 1 block(s) in f.txt.", { diff: "", patch }),
      ),
    ];
    const full = piAdapter.convert(mk({}));
    expect(payloads(full.drafts, "file.diff")[0]).toMatchObject({
      kind: "modify",
      beforeHash: sha(text),
      afterHash: sha("one\nTWO\n"),
    });
    expect(piAdapter.convert(mk({ offset: 1 })).skipped["edit:base content not in log"]).toBe(1);
    expect(piAdapter.convert(mk({ limit: 2 })).skipped["edit:base content not in log"]).toBe(1);
    expect(
      piAdapter.convert(mk({}, { truncation: { truncated: true } })).skipped["edit:base content not in log"],
    ).toBe(1);
    // --base supplies the file the session never read.
    const base = mktemp();
    writeFileSync(join(base, "f.txt"), text, "utf8");
    const lines = mk({}).filter((_, i) => i !== 1 && i !== 2);
    const seeded = piAdapter.convert(lines, {
      base: { kind: "dir", ref: base, files: new Map([["f.txt", text]]) },
    });
    expect(payloads(seeded.drafts, "file.diff")[0]).toMatchObject({ kind: "modify", beforeHash: sha(text) });
  });

  it("reads a version-1 file without ids, counts what it does not know, and refuses a header it cannot date", () => {
    const v1 = [
      header(undefined),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-28T20:26:41.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", data: "", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-28T20:26:42.000Z",
        message: { role: "hookMessage", customType: "x", content: "c", display: true, timestamp: 2 },
      }),
      JSON.stringify({
        type: "thinking_level_change",
        timestamp: "2026-05-28T20:26:43.000Z",
        thinkingLevel: "high",
      }),
      JSON.stringify({ type: "something_new", timestamp: "2026-05-28T20:26:44.000Z" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "thinking", thinking: "", redacted: true },
            { type: "widget" },
          ],
          api: "x",
          provider: "y",
          model: "m",
          usage: {},
          stopReason: "stop",
          timestamp: 1780000005000,
        },
      }),
      "not json",
    ];
    const r = piAdapter.convert(v1);
    expect(payloads(r.drafts, "session.start")[0]!.native).toEqual({
      sessionVersion: 1,
      parentSession: null,
    });
    expect(payloads(r.drafts, "message.user")[0]).toMatchObject({
      text: "hi\n[image]",
      native: { entryId: null, parentId: null },
    });
    // No entry timestamp: the message's own epoch milliseconds date it.
    expect(r.drafts.find((d) => d.type === "message.assistant")!.ts).toBe("2026-05-28T20:26:45.000Z");
    expect(r.skipped).toEqual({
      "content:image": 1,
      "message-role:hookMessage": 1,
      "entry:thinking_level_change": 1,
      "entry:something_new": 1,
      "thinking:redacted": 1,
      "unknown-block:widget": 1,
      "<unparseable>": 1,
    });
    expect(() => piAdapter.convert([JSON.stringify({ type: "session", id: SID, cwd: "/x" })])).toThrow(
      /timestamp/,
    );
    expect(() =>
      piAdapter.convert([entry("message", { message: { role: "user", content: "x", timestamp: 1 } })]),
    ).toThrow(/header/);
  });

  it("holds back session.end for a live share, and is deterministic", () => {
    const lines = linesOf(FILE);
    const live = piAdapter.convert(lines, { live: true });
    expect(live.drafts.at(-1)!.type).not.toBe("session.end");
    const a = piAdapter.convert(lines);
    const b = piAdapter.convert(lines);
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    expect(toJsonl(buildChain(live.sessionId, live.drafts))).toBe(
      toJsonl(buildChain(a.sessionId, a.drafts.slice(0, -1))),
    );
  });
});

describe("agit import on a pi session", () => {
  it("imports, verifies, forks the write, and is found where pi keeps sessions", () => {
    const dir = mktemp();
    const r = agit(["import", FILE, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`imported ${SID}`);
    expect(r.out).toContain("pi@");
    expect(agit(["verify", SID, "--dir", dir]).code).toBe(0);
    expect(agit(["show", SID, "--dir", dir]).out).toContain("runtime     pi");
    const fork = agit(["fork", SID, "--at", "24", "--out", join(dir, "fork"), "--dir", dir]);
    expect(fork.code, fork.out).toBe(0);
    expect(readFileSync(join(dir, "fork", "tree", "README.md"), "utf8")).toBe(
      "# hello\n\nGreets the world.\n",
    );
    expect(agit(["export", SID, "--markdown", "--dir", dir]).code).toBe(0);

    const home = mktemp();
    const project = join(home, ".pi", "agent", "sessions", "--home-dev-hello--");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `2026-05-28T20-26-40-000Z_${SID}.jsonl`), readFileSync(FILE));
    writeFileSync(join(project, "notes.txt"), "x", "utf8");
    const { logs, roots } = discoverSessionLogs(home, {}, "linux");
    expect(logs.filter((l) => l.runtime === "pi").map((l) => l.path)).toEqual([
      join(project, `2026-05-28T20-26-40-000Z_${SID}.jsonl`),
    ]);
    expect(roots.find((x) => x.runtime === "pi")).toMatchObject({
      dir: join(home, ".pi", "agent", "sessions"),
      exists: true,
      found: 1,
    });
    expect(
      discoverSessionLogs(home, { PI_CODING_AGENT_DIR: join(home, "elsewhere") }, "linux").roots.find(
        (x) => x.runtime === "pi",
      )!.dir,
    ).toBe(join(home, "elsewhere", "sessions"));
  });
});
