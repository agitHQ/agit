/**
 * The Cline task-directory adapter over the two fixtures built to Cline's
 * own source at v3.89.2: an XML-era task (no timestamps or usage in the
 * transcript, tool calls as XML in the text, results as framed text blocks)
 * and a native-era one (`ts`, `metrics`, `modelInfo`, `tool_use` /
 * `tool_result`). The assertions are what reading a task the way Cline
 * wrote it yields, plus the parser ported from parse-assistant-message.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clineClassicAdapter, parseAssistantXml } from "../src/adapters/cline-classic.js";
import { discoverSessionLogs } from "../src/discover.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const XML_ID = "1736589300000";
const NATIVE_ID = "1789136000000";
const XML_TASK = join(ROOT, "fixtures", "cline-classic", XML_ID);
const NATIVE_TASK = join(ROOT, "fixtures", "cline-classic", NATIVE_ID);
const transcript = (task: string): string => join(task, "api_conversation_history.json");

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-cline-classic-"));
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

/** A task directory of our own: a transcript and, optionally, a timeline beside it. */
function taskDir(id: string, api: unknown[], ui?: unknown[]): string {
  const dir = join(mktemp(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "api_conversation_history.json"), JSON.stringify(api), "utf8");
  if (ui !== undefined) writeFileSync(join(dir, "ui_messages.json"), JSON.stringify(ui), "utf8");
  return dir;
}

const text = (t: string): Json => ({ type: "text", text: t });

describe("parseAssistantXml, Cline's parseAssistantMessageV2", () => {
  it("splits text from tool calls and trims values, leaving unknown tags as text", () => {
    const parts = parseAssistantXml(
      "Let me look.\n\n<read_file>\n<path> src/a.ts </path>\n</read_file>\n\nThen <b>bold</b> done.",
    );
    expect(parts).toEqual([
      { type: "text", text: "Let me look." },
      { type: "tool", name: "read_file", params: { path: "src/a.ts" }, partial: false },
      { type: "text", text: "Then <b>bold</b> done." },
    ]);
  });

  it("takes write_to_file content between the first <content> and the last </content>", () => {
    const parts = parseAssistantXml(
      "<write_to_file>\n<path>x.md</path>\n<content>\n# Notes\n\nA closing </content> tag inside the file.\n</content>\n</write_to_file>",
    );
    expect(parts).toEqual([
      {
        type: "tool",
        name: "write_to_file",
        params: { path: "x.md", content: "# Notes\n\nA closing </content> tag inside the file." },
        partial: false,
      },
    ]);
  });

  it("keeps a call the message ended inside, marked partial, with the open parameter so far", () => {
    const parts = parseAssistantXml("Working.\n<execute_command>\n<command>npm test");
    expect(parts).toEqual([
      { type: "text", text: "Working." },
      { type: "tool", name: "execute_command", params: { command: "npm test" }, partial: true },
    ]);
    expect(parseAssistantXml("   ")).toEqual([]);
    expect(parseAssistantXml("<not_a_tool>x</not_a_tool>")).toEqual([
      { type: "text", text: "<not_a_tool>x</not_a_tool>" },
    ]);
  });
});

describe("the Cline task-directory adapter", () => {
  it("recognizes a transcript by its shape and opening <task>, and nothing else", () => {
    expect(clineClassicAdapter.detect(linesOf(transcript(XML_TASK)))).toBe(true);
    expect(clineClassicAdapter.detect(linesOf(transcript(NATIVE_TASK)))).toBe(true);
    expect(clineClassicAdapter.detect(linesOf(join(XML_TASK, "ui_messages.json")))).toBe(false);
    for (const other of [
      join("cline-sdk", "simple.messages.json"),
      join("atif", "simple.json"),
      join("claude-code", "simple.jsonl"),
      join("codex", "simple.jsonl"),
      join("gemini-cli", "legacy.json"),
    ]) {
      expect(clineClassicAdapter.detect(linesOf(join(ROOT, "fixtures", other))), other).toBe(false);
    }
    // A bare Anthropic message array that is not a Cline task.
    expect(clineClassicAdapter.detect([JSON.stringify([{ role: "user", content: "hello" }])])).toBe(false);
    expect(clineClassicAdapter.detect([JSON.stringify([])])).toBe(false);
  });

  it("reads an XML-era task: calls from the text, results paired in order, dates and usage from the timeline", () => {
    const r = clineClassicAdapter.convert(linesOf(transcript(XML_TASK)), { path: transcript(XML_TASK) });
    expect(r.sessionId).toBe(XML_ID);
    expect(r.records).toBe(12);
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "tool.call",
      "cost",
      "session.end",
    ]);
    // The task is the one user message; environment_details and the framed
    // results are not the person's words.
    const users = payloads(r.drafts, "message.user");
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe(
      "<task>\nAdd a greeting helper in src/greet.ts and use it from src/index.ts\n</task>",
    );
    expect(r.skipped["environment-details"]).toBe(6);

    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => [c.name, c.toolUseId])).toEqual([
      ["read_file", "xml:1:0"],
      ["write_to_file", "xml:3:0"],
      ["replace_in_file", "xml:5:0"],
      ["execute_command", "xml:7:0"],
      ["attempt_completion", "xml:9:0"],
      ["attempt_completion", "xml:11:0"],
    ]);
    expect(calls[1]!.input).toEqual({
      path: "src/greet.ts",
      content: "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}",
    });
    expect(calls[3]!.input).toEqual({ command: "npm test", requires_approval: "false" });
    expect(calls[0]!.native).toMatchObject({ xml: true, partial: false, index: 1 });

    const results = payloads(r.drafts, "tool.result");
    expect(results.map((x) => [x.toolUseId, x.isError])).toEqual([
      ["xml:1:0", false],
      ["xml:3:0", false],
      ["xml:5:0", false],
      ["xml:7:0", true],
      ["xml:9:0", false],
    ]);
    expect(results[0]!.output).toBe("[read_file for 'src/index.ts'] Result:\nconsole.log(\"hi\");\n");
    expect(results[3]!.output).toContain("Command timed out after 30s");
    expect(results[0]!.native).toMatchObject({ tool: "read_file", xml: true });
    expect(r.skipped["tool-result-unpaired"]).toBeUndefined();

    // Dated from ui_messages.json by conversationHistoryIndex: the task's
    // own line dates the first message, the next request's api_req_started
    // dates the assistant message before it.
    expect(r.drafts[0]!.ts).toBe("2025-01-11T09:55:00.000Z");
    expect(r.drafts[2]!.ts).toBe("2025-01-11T09:55:03.000Z");
    expect(r.drafts[5]!.ts).toBe("2025-01-11T09:55:04.500Z");
    expect(r.skipped["message-timestamp-from-ui-messages"]).toBe(11);
    expect(r.skipped["message-timestamp-inherited"]).toBe(1); // the last reply: nothing was written after it
    expect(r.skipped["message-timestamp-by-request-order"]).toBeUndefined();

    // Usage from api_req_started, with cache writes and reads kept apart.
    const costs = payloads(r.drafts, "cost");
    expect(costs).toHaveLength(6);
    expect(costs[2]!.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 120,
      cacheReadInputTokens: 1200,
      cacheCreationInputTokens: 200,
    });
    expect(costs[2]!.model).toBeNull();
    expect(costs[2]!.native).toMatchObject({ source: "ui_messages.json" });
    expect(r.skipped["cost-from-ui-messages"]).toBe(6);
    expect(r.skipped["cost-usd-not-stored (SPEC §5.9)"]).toBe(6);
    expect(JSON.stringify(r.drafts)).not.toContain("0.0042");

    // Edits are calls, counted; nothing is hashed from <final_file_content>.
    expect(payloads(r.drafts, "file.diff")).toEqual([]);
    expect(r.skipped["file-edit-unverifiable"]).toBe(2);
  });

  it("reads a native-era task from its own stamps: ids, thinking, metrics, model", () => {
    const r = clineClassicAdapter.convert(linesOf(transcript(NATIVE_TASK)), {
      path: transcript(NATIVE_TASK),
    });
    expect(r.sessionId).toBe(NATIVE_ID);
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
      "tool.call",
      "cost",
      "session.end",
    ]);
    expect(r.drafts[0]!.ts).toBe("2026-09-11T14:13:20.000Z");
    expect(r.drafts[2]!.ts).toBe("2026-09-11T14:13:23.200Z");
    const assistant = payloads(r.drafts, "message.assistant")[0]!;
    expect(assistant.model).toBe("claude-sonnet-5");
    expect(assistant.blocks).toEqual([
      { type: "thinking", text: "The helper exists already; read the entry point, then patch it." },
      { type: "text", text: "Reading the entry point." },
    ]);
    expect(assistant.native).toMatchObject({
      messageId: "msg_01native0001",
      provider: "anthropic",
      mode: "act",
    });
    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => [c.name, c.toolUseId])).toEqual([
      ["read_file", "toolu_01readidx"],
      ["apply_patch", "toolu_01patch"],
      ["attempt_completion", "toolu_01done"],
    ]);
    expect(calls[0]!.native).toMatchObject({ xml: false });
    const results = payloads(r.drafts, "tool.result");
    expect(results.map((x) => x.toolUseId)).toEqual(["toolu_01readidx", "toolu_01patch"]);
    expect(results[1]!.native).toMatchObject({ tool: "apply_patch", xml: false });
    const costs = payloads(r.drafts, "cost");
    expect(costs[0]!.usage).toEqual({
      inputTokens: 2100,
      outputTokens: 85,
      cacheReadInputTokens: 1400,
      cacheCreationInputTokens: 0,
    });
    expect(costs[0]!.native).toMatchObject({
      messageId: "msg_01native0001",
      cachedTokensIncludeWrites: true,
    });
    expect(r.skipped["cost-from-ui-messages"]).toBeUndefined();
    expect(r.skipped["message-timestamp-from-ui-messages"]).toBeUndefined();
    expect(r.skipped["file-edit-unverifiable"]).toBe(1);
    expect(r.skipped["cost-usd-not-stored (SPEC §5.9)"]).toBe(3);
  });

  it("without a path, derives a session id and says so; without any timestamp source, refuses", () => {
    const native = clineClassicAdapter.convert(linesOf(transcript(NATIVE_TASK)));
    expect(native.sessionId).toMatch(/^cline-[0-9a-f]{12}$/);
    expect(native.skipped["session-id-derived-without-path"]).toBe(1);
    expect(clineClassicAdapter.convert(linesOf(transcript(NATIVE_TASK))).sessionId).toBe(native.sessionId);
    expect(() => clineClassicAdapter.convert(linesOf(transcript(XML_TASK)))).toThrow(/no timestamp/);
    // A path whose directory holds no timeline is the same refusal.
    const alone = taskDir(
      "1700000000000",
      JSON.parse(readFileSync(transcript(XML_TASK), "utf8")) as unknown[],
    );
    expect(() =>
      clineClassicAdapter.convert(linesOf(join(alone, "api_conversation_history.json")), {
        path: join(alone, "api_conversation_history.json"),
      }),
    ).toThrow(/ui_messages\.json/);
  });

  it("pairs by request order when the timeline predates conversationHistoryIndex", () => {
    const api = [
      {
        role: "user",
        content: [text("<task>\nsay hi\n</task>"), text("<environment_details>\nx\n</environment_details>")],
      },
      {
        role: "assistant",
        content: [text("Hi.\n\n<attempt_completion>\n<result>\nhi\n</result>\n</attempt_completion>")],
      },
      {
        role: "user",
        content: [
          text(
            "[attempt_completion] Result:\nThe user has provided feedback on the results.\n<feedback>\nagain\n</feedback>",
          ),
        ],
      },
      { role: "assistant", content: [text("Hi again.")] },
    ];
    const req = (n: number): string =>
      JSON.stringify({
        request: "…",
        tokensIn: 100 * n,
        tokensOut: n,
        cacheWrites: 0,
        cacheReads: 0,
        cost: 0.001,
      });
    const ui = [
      { ts: 1700000000000, type: "say", say: "task", text: "say hi" },
      { ts: 1700000001000, type: "say", say: "api_req_started", text: req(1) },
      { ts: 1700000003000, type: "say", say: "text", text: "Hi." },
      { ts: 1700000004000, type: "ask", ask: "completion_result", text: "hi" },
      { ts: 1700000010000, type: "say", say: "user_feedback", text: "again" },
      { ts: 1700000011000, type: "say", say: "api_req_started", text: req(2) },
      { ts: 1700000013000, type: "say", say: "text", text: "Hi again." },
    ];
    const dir = taskDir("1700000000000", api, ui);
    const p = join(dir, "api_conversation_history.json");
    const r = clineClassicAdapter.convert(linesOf(p), { path: p });
    expect(r.sessionId).toBe("1700000000000");
    expect(r.drafts.map((d) => [d.type, d.ts])).toEqual([
      ["session.start", "2023-11-14T22:13:21.000Z"],
      ["message.user", "2023-11-14T22:13:21.000Z"],
      ["message.assistant", "2023-11-14T22:13:30.000Z"],
      ["tool.call", "2023-11-14T22:13:30.000Z"],
      ["cost", "2023-11-14T22:13:30.000Z"],
      ["tool.result", "2023-11-14T22:13:31.000Z"],
      ["message.assistant", "2023-11-14T22:13:33.000Z"],
      ["cost", "2023-11-14T22:13:33.000Z"],
      ["session.end", "2023-11-14T22:13:33.000Z"],
    ]);
    expect(payloads(r.drafts, "cost").map((c) => c.usage)).toEqual([
      { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      { inputTokens: 200, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    ]);
    expect(r.skipped["message-timestamp-by-request-order"]).toBe(4);
    expect(r.skipped["message-timestamp-from-ui-messages"]).toBe(4);
  });

  it("gives a result that pairs with no call a null id, counts it, and counts blocks it does not know", () => {
    const api = [
      {
        role: "user",
        ts: 1700000000000,
        content: [text("<task>\nt\n</task>"), { type: "image", source: { type: "base64" } }],
      },
      { role: "assistant", ts: 1700000001000, content: [text("<read_file>\n<path>a</path>\n</read_file>")] },
      // The result names a different tool than the call before it.
      {
        role: "user",
        ts: 1700000002000,
        content: [text("[list_files for '.'] Result:\nnothing"), text("plain words")],
      },
      {
        role: "assistant",
        ts: 1700000003000,
        content: [{ type: "redacted_thinking", data: "x" }, text("ok")],
      },
      { role: "user", ts: 1700000004000, content: "a bare string turn" },
      { role: "system", ts: 1700000005000, content: "?" },
    ];
    const r = clineClassicAdapter.convert([JSON.stringify(api)]);
    const results = payloads(r.drafts, "tool.result");
    expect(results).toHaveLength(1);
    expect(results[0]!.toolUseId).toBeNull();
    expect(r.skipped["tool-result-unpaired"]).toBe(1);
    expect(payloads(r.drafts, "message.user").map((m) => m.text)).toEqual([
      "<task>\nt\n</task>",
      "plain words",
      "a bare string turn",
    ]);
    expect(r.skipped["unknown-block:image"]).toBe(1);
    expect(r.skipped["redacted-thinking"]).toBe(1);
    expect(r.skipped["unknown-role:system"]).toBe(1);
    // A native result that says is_error is believed.
    const err = clineClassicAdapter.convert([
      JSON.stringify([
        { role: "user", ts: 1, content: [text("<task>\nt\n</task>")] },
        {
          role: "assistant",
          ts: 2,
          content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }],
        },
        {
          role: "user",
          ts: 3,
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: "[read_file for 'a'] Result:\nno such file",
            },
          ],
        },
      ]),
    ]);
    expect(payloads(err.drafts, "tool.result")[0]).toMatchObject({ toolUseId: "t1", isError: true });
  });

  it("holds back session.end for a live share, and is deterministic", () => {
    const lines = linesOf(transcript(NATIVE_TASK));
    const live = clineClassicAdapter.convert(lines, { path: transcript(NATIVE_TASK), live: true });
    expect(live.drafts.at(-1)!.type).not.toBe("session.end");
    const a = clineClassicAdapter.convert(lines, { path: transcript(NATIVE_TASK) });
    const b = clineClassicAdapter.convert(lines, { path: transcript(NATIVE_TASK) });
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    expect(toJsonl(buildChain(live.sessionId, live.drafts))).toBe(
      toJsonl(buildChain(a.sessionId, a.drafts.slice(0, -1))),
    );
  });
});

describe("agit import on a Cline task directory", () => {
  it("imports the directory itself or its transcript, verifies, and reads back", () => {
    const dir = mktemp();
    const r = agit(["import", XML_TASK, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`imported ${XML_ID}`);
    expect(r.out).toContain("cline-classic@");
    expect(r.out).toContain("file-edit-unverifiable×2");
    expect(agit(["import", transcript(NATIVE_TASK), "--dir", dir]).out).toContain(`imported ${NATIVE_ID}`);
    expect(agit(["verify", XML_ID, "--dir", dir]).code).toBe(0);
    expect(agit(["verify", NATIVE_ID, "--dir", dir]).code).toBe(0);
    const shown = agit(["show", NATIVE_ID, "--dir", dir]).out;
    expect(shown).toContain("runtime     cline");
    expect(shown).toContain("claude-sonnet-5");
    expect(agit(["replay", XML_ID, "--timeline", "--dir", dir]).out).toContain("write_to_file");
    expect(agit(["export", XML_ID, "--atif", "--dir", dir]).code).toBe(0);
    expect(agit(["export", XML_ID, "--markdown", "--dir", dir]).code).toBe(0);
    // Re-import is a no-op.
    expect(agit(["import", XML_TASK, "--dir", dir]).out).toContain("unchanged");
    // A directory that is neither a bundle nor a task says so.
    const empty = mktemp();
    const bad = agit(["import", empty, "--dir", dir]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("api_conversation_history.json");
  });

  it("is found where Cline's CLI and the VS Code extension keep tasks, per platform", () => {
    const home = mktemp();
    const cliTasks = join(home, ".cline", "data", "tasks");
    mkdirSync(join(cliTasks, XML_ID), { recursive: true });
    writeFileSync(
      join(cliTasks, XML_ID, "api_conversation_history.json"),
      readFileSync(transcript(XML_TASK)),
    );
    writeFileSync(
      join(cliTasks, XML_ID, "ui_messages.json"),
      readFileSync(join(XML_TASK, "ui_messages.json")),
    );
    mkdirSync(join(cliTasks, "not-a-task"), { recursive: true }); // no transcript: ignored
    const sdk = join(home, ".cline", "data", "sessions", "s-1");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "s-1.messages.json"), "{}", "utf8");
    const code = join(
      home,
      ".config",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "tasks",
      NATIVE_ID,
    );
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, "api_conversation_history.json"), readFileSync(transcript(NATIVE_TASK)));

    const linux = discoverSessionLogs(home, {}, "linux");
    expect(linux.logs.map((l) => [l.runtime, l.path]).sort()).toEqual(
      [
        ["cline-classic", join(cliTasks, XML_ID, "api_conversation_history.json")],
        ["cline-classic", join(code, "api_conversation_history.json")],
        ["cline-sdk", join(sdk, "s-1.messages.json")],
      ].sort(),
    );
    expect(linux.roots.filter((r) => r.runtime === "cline-classic").map((r) => r.dir)).toEqual([
      cliTasks,
      join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"),
      join(home, ".config", "Code - Insiders", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"),
    ]);
    // The other platforms' editor roots, and the env overrides each honours.
    const mac = discoverSessionLogs(home, {}, "darwin").roots.filter((r) => r.runtime === "cline-classic");
    expect(mac[1]!.dir).toBe(
      join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "tasks",
      ),
    );
    const win = discoverSessionLogs(home, { APPDATA: join(home, "Roaming") }, "win32").roots.filter(
      (r) => r.runtime === "cline-classic",
    );
    expect(win[1]!.dir).toBe(
      join(home, "Roaming", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"),
    );
    const xdg = discoverSessionLogs(home, { XDG_CONFIG_HOME: join(home, "cfg") }, "linux").roots.filter(
      (r) => r.runtime === "cline-classic",
    );
    expect(xdg[1]!.dir).toBe(
      join(home, "cfg", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"),
    );
    const elsewhere = discoverSessionLogs(home, { CLINE_DIR: join(home, "elsewhere") }, "linux").roots;
    expect(elsewhere.find((r) => r.runtime === "cline-sdk")!.dir).toBe(
      join(home, "elsewhere", "data", "sessions"),
    );

    // And `import --all` imports what it found, with the timeline beside the transcript.
    const dir = mktemp();
    const all = agit(["import", "--all", "--dir", dir], {
      HOME: home,
      USERPROFILE: home,
      CLINE_DIR: join(home, ".cline"),
      APPDATA: join(home, "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
    });
    expect(all.out).toMatch(new RegExp(`imported   ${XML_ID}\\s+cline-classic`));
    expect(agit(["verify", XML_ID, "--dir", dir]).code).toBe(0);
  });
});
