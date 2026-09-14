/**
 * Steering (src/steer.ts): viewer messages that reach the agent, opt-in, at
 * a turn boundary, through Claude Code's own documented hooks. Three layers
 * are tested here, each at its seam: the inbox files a hook drains, the
 * relay's handling of a steer claim (key to the writer only, never to other
 * viewers), and the real CLI end to end — `agit share --steer`, a message
 * with the right key and one with a wrong key, `agit hook` reading stdin
 * the way Claude Code writes it.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";
import { createShare, openInbox, readSse, type InboxMessage } from "../src/share.js";
import {
  drainSteer,
  formatSteerContext,
  newSteerKey,
  queueSteer,
  resetSteer,
  runSteerHook,
  steerHookConfig,
  steerInboxPath,
  steerKeyMatches,
  SteerQueue,
  undeliveredSteer,
} from "../src/steer.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const CODEX = join(ROOT, "fixtures", "codex", "simple.jsonl");

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-steer-"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const NL_ = "\n";
/** Poll until `cond` holds, failing with `what` after `ms` — never a fixed wait for something asynchronous. */
async function waitFor(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(50);
  }
}
const SID = "11111111-2222-4333-8444-555555555555";

function agit(args: string[], stdin?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input: stdin ?? "" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** For anything that talks to a relay living in this process: a sync spawn would starve it. */
function agitAsync(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const code = (err as { code?: number } | null)?.code;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin!.end(stdin ?? "");
  });
}

/** A relay that answers whatever it is told to. Anything from a relay is untrusted. */
async function hostileRelay(reply: (req: http.IncomingMessage) => unknown): Promise<string> {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(req)));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  open.push({ close: () => new Promise((r) => srv.close(() => r())) });
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});
async function relay(): Promise<{ handle: RelayHandle; base: string }> {
  const handle = await startRelay({ port: 0 });
  open.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

function hookInput(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SID,
    transcript_path: `/home/x/.claude/projects/p/${SID}.jsonl`,
    cwd: "/home/x/p",
    hook_event_name: event,
    ...extra,
  });
}

describe("the steer inbox", () => {
  it("delivers each message once, in order, and never a torn tail line", () => {
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:01.000Z", name: "alice", text: "try the other branch" });
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:02.000Z", name: "bob", text: "and add a test" });
    // A third message still landing: no trailing newline yet.
    writeFileSync(steerInboxPath(dir, SID), readFileSync(steerInboxPath(dir, SID), "utf8") + '{"ts":"x"', {
      flag: "w",
    });

    const first = drainSteer(dir, SID);
    expect(first.delivered.map((m) => m.name)).toEqual(["alice", "bob"]);
    expect(first.remaining).toBe(0);
    expect(drainSteer(dir, SID).delivered).toEqual([]);

    // The torn line completes as garbage, then a real one follows: the
    // garbage is skipped for good, the real one delivered.
    writeFileSync(steerInboxPath(dir, SID), readFileSync(steerInboxPath(dir, SID), "utf8") + "}\n", {
      flag: "w",
    });
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:03.000Z", name: "cy", text: "ship it" });
    const second = drainSteer(dir, SID);
    expect(second.delivered.map((m) => m.text)).toEqual(["ship it"]);
    expect(undeliveredSteer(dir, SID)).toBe(0);
  });

  it("stays under Claude Code's output cap and says what is still queued", () => {
    const dir = mktemp();
    for (let i = 0; i < 5; i++) {
      queueSteer(dir, SID, { ts: "2026-09-12T10:00:00.000Z", name: "n", text: "x".repeat(3000) });
    }
    const d = drainSteer(dir, SID);
    expect(d.delivered.length).toBe(2); // ~3020 chars each under a 9000 budget
    expect(d.remaining).toBe(3);
    const ctx = formatSteerContext(d);
    expect(ctx.length).toBeLessThan(10_000);
    expect(ctx).toContain("3 more queued");
    expect(drainSteer(dir, SID).delivered.length).toBe(2);
    expect(drainSteer(dir, SID).delivered.length).toBe(1);
    expect(drainSteer(dir, SID).delivered.length).toBe(0);
  });

  it("truncates one oversized message rather than wedging the queue behind it", () => {
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:00.000Z", name: "n", text: "y".repeat(20_000) });
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:01.000Z", name: "n", text: "after" });
    const d = drainSteer(dir, SID);
    expect(d.delivered.length).toBe(1);
    expect(d.delivered[0]!.text.endsWith("[truncated by agit]")).toBe(true);
    expect(formatSteerContext(d).length).toBeLessThan(10_000);
    expect(drainSteer(dir, SID).delivered.map((m) => m.text)).toEqual(["after"]);
  });

  it("starts over when the inbox was reset under a stale cursor", () => {
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "t", name: "n", text: "one" });
    queueSteer(dir, SID, { ts: "t", name: "n", text: "two" });
    expect(drainSteer(dir, SID).delivered.length).toBe(2);
    resetSteer(dir, SID);
    queueSteer(dir, SID, { ts: "t", name: "n", text: "fresh" });
    expect(drainSteer(dir, SID).delivered.map((m) => m.text)).toEqual(["fresh"]);
  });

  it("refuses a session id that is not a safe directory name", () => {
    const dir = mktemp();
    expect(() => queueSteer(dir, "../../etc", { ts: "t", name: "n", text: "x" })).toThrow();
    expect(() => steerInboxPath(dir, "..")).toThrow();
  });

  it("compares keys without leaking through type or emptiness", () => {
    const k = newSteerKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(steerKeyMatches(k, k)).toBe(true);
    expect(steerKeyMatches(k + "x", k)).toBe(false);
    expect(steerKeyMatches("", k)).toBe(false);
    expect(steerKeyMatches(undefined, k)).toBe(false);
    expect(steerKeyMatches(42, k)).toBe(false);
  });
});

describe("the hook", () => {
  it("hands queued messages to Stop and UserPromptSubmit in the documented shape, once", () => {
    const dir = mktemp();
    queueSteer(dir, SID, {
      ts: "2026-09-12T10:00:01.000Z",
      name: "alice",
      text: "look at the failing test first",
    });
    const stop = runSteerHook(
      dir,
      hookInput("Stop", { stop_hook_active: false, last_assistant_message: "done" }),
    );
    expect(stop.exit).toBe(0);
    const parsed = JSON.parse(stop.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "[10:00:01] alice: look at the failing test first",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain("steer key");
    // Delivered: the next Stop has nothing to say, so the agent may stop.
    expect(runSteerHook(dir, hookInput("Stop", { stop_hook_active: true })).stdout).toBe("");

    queueSteer(dir, SID, { ts: "2026-09-12T10:00:02.000Z", name: "bob", text: "then the docs" });
    const prompt = runSteerHook(dir, hookInput("UserPromptSubmit", { prompt: "carry on" }));
    const p2 = JSON.parse(prompt.stdout) as { hookSpecificOutput: { hookEventName: string } };
    expect(p2.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("hands queued messages to Gemini CLI's AfterAgent as a blocking reason and to BeforeAgent as context", () => {
    // AfterAgent has no context field: a blocking decision's `reason` is
    // "sent to the agent as a new prompt" (docs/hooks/reference.md), and
    // client.ts keeps the history and continues with it. BeforeAgent takes
    // additionalContext like Claude Code's UserPromptSubmit.
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:01.000Z", name: "alice", text: "check the tests too" });
    const after = runSteerHook(
      dir,
      hookInput("AfterAgent", { prompt: "x", prompt_response: "y", stop_hook_active: false }),
    );
    const parsed = JSON.parse(after.stdout) as {
      decision: string;
      reason: string;
      hookSpecificOutput?: unknown;
    };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[10:00:01] alice: check the tests too");
    expect(parsed.hookSpecificOutput).toBeUndefined();
    expect(runSteerHook(dir, hookInput("AfterAgent", { stop_hook_active: true })).stdout).toBe("");

    queueSteer(dir, SID, { ts: "2026-09-12T10:00:02.000Z", name: "bob", text: "and the docs" });
    const before = JSON.parse(runSteerHook(dir, hookInput("BeforeAgent", { prompt: "carry on" })).stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(before.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
    expect(before.hookSpecificOutput.additionalContext).toContain("bob: and the docs");
  });

  it("hands queued messages to pi as the custom message its extension injects, at both boundaries", () => {
    // pi's documented channel is an extension: before_agent_start may return
    // `{ message }`, and agent_end may pi.sendMessage() one (docs/extensions.md).
    // The hook answers both with that message, ready to pass straight through.
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:01.000Z", name: "alice", text: "skip the tests" });
    const end = JSON.parse(runSteerHook(dir, hookInput("AgentEnd")).stdout) as {
      message: { customType: string; content: string; display: boolean };
    };
    expect(end.message).toMatchObject({ customType: "agit-steer", display: true });
    expect(end.message.content).toContain("[10:00:01] alice: skip the tests");
    expect(runSteerHook(dir, hookInput("AgentEnd")).stdout).toBe(""); // drained
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:02.000Z", name: "bob", text: "and lint" });
    const start = JSON.parse(runSteerHook(dir, hookInput("BeforeAgentStart")).stdout) as {
      message: { content: string };
    };
    expect(start.message.content).toContain("bob: and lint");
    // The extension itself: one TypeScript source, pi's export shape, both events, agit on PATH.
    const ext = steerHookConfig("pi");
    expect(ext).toContain("export default function (pi: ExtensionAPI)");
    expect(ext).toContain('pi.on("before_agent_start"');
    expect(ext).toContain('pi.on("agent_end"');
    expect(ext).toContain('execFileSync("agit", ["hook"]');
    expect(ext).toContain('deliverAs: "followUp", triggerTurn: true');
    const cli = agit(["hook", "--config", "pi"]);
    expect(cli.code).toBe(0);
    expect(cli.stdout.trimEnd()).toBe(ext.trimEnd());
    expect(cli.stderr).toContain("~/.pi/agent/extensions/agit-steer.ts");
  });

  it("serves OpenCode's two events as the text the plugin needs, and prints the plugin", () => {
    const dir = mktemp();
    const oc = "ses_abc123";
    queueSteer(dir, oc, { ts: "2026-09-12T10:00:01.000Z", name: "alice", text: "run the tests" });
    const input = (event: string): string => JSON.stringify({ hook_event_name: event, session_id: oc });
    const idle = JSON.parse(runSteerHook(dir, input("SessionIdle")).stdout) as { text: string };
    expect(Object.keys(idle)).toEqual(["text"]);
    expect(idle.text).toContain("alice: run the tests");
    expect(runSteerHook(dir, input("ChatMessage")).stdout).toBe(""); // drained
    queueSteer(dir, oc, { ts: "2026-09-12T10:00:02.000Z", name: "bob", text: "and lint" });
    const chat = JSON.parse(runSteerHook(dir, input("ChatMessage")).stdout) as { text: string };
    expect(chat.text).toContain("bob: and lint");
    // The plugin itself: one TypeScript source, OpenCode's export shape, both hooks, agit on PATH.
    const plugin = steerHookConfig("opencode");
    expect(plugin).toContain("export const AgitSteer: Plugin = async ({ client, directory }) =>");
    expect(plugin).toContain('"chat.message": async (input, output) =>');
    expect(plugin).toContain('if (event.type !== "session.idle") return;');
    expect(plugin).toContain('execFileSync("agit", ["hook"]');
    expect(plugin).toContain("client.session.promptAsync({ path: { id: sessionID }");
    expect(plugin).toContain("synthetic: true");
    const cli = agit(["hook", "--config", "opencode"]);
    expect(cli.code).toBe(0);
    expect(cli.stdout.trimEnd()).toBe(plugin.trimEnd());
    expect(cli.stderr).toContain(".opencode/plugins/agit-steer.ts");
  });

  it("prints a settings fragment per runtime: seconds for Claude Code, milliseconds and a name for Gemini CLI", () => {
    const claude = JSON.parse(steerHookConfig()) as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
    };
    expect(Object.keys(claude.hooks).sort()).toEqual(["Stop", "UserPromptSubmit"]);
    expect(claude.hooks.Stop![0]!.hooks[0]!.timeout).toBe(10);
    const gemini = JSON.parse(steerHookConfig("gemini-cli")) as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
    };
    expect(Object.keys(gemini.hooks).sort()).toEqual(["AfterAgent", "BeforeAgent"]);
    expect(gemini.hooks.AfterAgent![0]!.hooks[0]).toMatchObject({
      command: "agit hook",
      name: "agit-steer",
      timeout: 10_000,
    });
    const cli = agit(["hook", "--config", "gemini-cli"]);
    expect(cli.code).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(gemini);
    expect(agit(["hook", "--config", "codex"]).code).toBe(2);
  });

  it("is silent for every other event, for a subagent, for garbage, and for an unknown session", () => {
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "t", name: "n", text: "x" });
    expect(runSteerHook(dir, hookInput("PreToolUse")).stdout).toBe("");
    expect(runSteerHook(dir, hookInput("SubagentStop", { agent_id: "a1" })).stdout).toBe("");
    expect(runSteerHook(dir, hookInput("Stop", { agent_id: "a1" })).stdout).toBe("");
    expect(runSteerHook(dir, "not json").stdout).toBe("");
    expect(runSteerHook(dir, "[]").stdout).toBe("");
    expect(runSteerHook(dir, JSON.stringify({ hook_event_name: "Stop", session_id: "../x" })).stdout).toBe(
      "",
    );
    expect(runSteerHook(dir, JSON.stringify({ hook_event_name: "Stop", session_id: "nobody" })).stdout).toBe(
      "",
    );
    // None of that consumed the message.
    expect(runSteerHook(dir, hookInput("Stop")).stdout).toContain("x");
  });

  it("agit hook reads stdin and prints the JSON; --config prints a settings fragment for both events", () => {
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "2026-09-12T10:00:01.000Z", name: "alice", text: "via the real cli" });
    const r = agit(["hook", "--dir", dir], hookInput("Stop"));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("via the real cli");
    const again = agit(["hook", "--dir", dir], hookInput("Stop"));
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("");

    const cfg = agit(["hook", "--config"]);
    expect(cfg.code).toBe(0);
    const parsed = JSON.parse(cfg.stdout) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(parsed.hooks).sort()).toEqual(["Stop", "UserPromptSubmit"]);
    expect(parsed.hooks.Stop![0]!.hooks[0]!.command).toBe("agit hook");
    expect(JSON.parse(steerHookConfig())).toEqual(parsed);
  });
});

describe("the relay", () => {
  async function inboxFrames(
    base: string,
    share: { shareId: string; writerToken: string },
  ): Promise<InboxMessage[]> {
    const got: InboxMessage[] = [];
    // Resolved by onOpen: the relay has this connection in its inbox set, so
    // a message posted from here on is forwarded to it.
    await new Promise<void>((connected) => {
      const ctl = openInbox(
        base,
        { ...share, ttlMs: 0, viewUrl: "" },
        { onMessage: (m) => got.push(m), onOpen: connected },
      );
      open.push({ close: async () => ctl.abort() });
    });
    return got;
  }

  async function viewerFrames(base: string, shareId: string): Promise<Record<string, unknown>[]> {
    const got: Record<string, unknown>[] = [];
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/shares/${shareId}/stream`, { signal: ctl.signal });
    void readSse(
      res.body!,
      (event, data) => {
        if (event === "msg") got.push(JSON.parse(data) as Record<string, unknown>);
      },
      ctl.signal,
    ).catch(() => undefined);
    open.push({ close: async () => ctl.abort() });
    return got;
  }

  it("forwards a steer claim's key to the writer inbox only, and marks the claim for viewers", async () => {
    const { base } = await relay();
    const share = await createShare(base, undefined, { steer: true });
    expect(share.steer).toBe(true);
    const inbox = await inboxFrames(base, share);
    const viewers = await viewerFrames(base, share.shareId);

    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/shares/${share.shareId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ name: "alice", text: "steer me", key: "sekrit" })).status).toBe(200);
    expect((await post({ name: "bob", text: "just chatting" })).status).toBe(200);
    await waitFor(() => inbox.length >= 2, "both messages in the inbox");

    expect(inbox.map((m) => [m.name, m.steer, m.key])).toEqual([
      ["alice", true, "sekrit"],
      ["bob", undefined, undefined],
    ]);
    expect(viewers.map((m) => [m.name, m.steer, "key" in m])).toEqual([
      ["alice", true, false],
      ["bob", undefined, false],
    ]);

    const info = await fetch(`${base}/api/shares/${share.shareId}/stream`).then(async (r) => {
      const reader = r.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      return new TextDecoder().decode(value);
    });
    expect(info).toContain('"steer":true');
  });

  it("drops the key on a share that did not opt in", async () => {
    const { base } = await relay();
    const share = await createShare(base);
    expect(share.steer).toBe(false);
    const inbox = await inboxFrames(base, share);
    await fetch(`${base}/api/shares/${share.shareId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice", text: "hi", key: "sekrit" }),
    });
    await waitFor(() => inbox.length >= 1, "the message in the inbox");
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.key).toBeUndefined();
    expect(inbox[0]!.steer).toBeUndefined();
  });
});

describe("agit share --steer, end to end", () => {
  /**
   * Spawn `agit share` with a preload that raises SIGINT in-process once a
   * stop file appears — the test ends the share when its assertions are
   * done, never on a clock. A timed SIGINT used to end the share under
   * load before the message had arrived, and `close()` then removed the
   * inbox the assertions were about to read.
   */
  function spawnShare(args: string[]): { cli: ReturnType<typeof spawn>; stop: () => void } {
    const scratch = mktemp();
    const preload = join(scratch, "sigint.mjs");
    const stopFile = join(scratch, "stop");
    writeFileSync(
      preload,
      [
        'import { existsSync } from "node:fs";',
        `const stop = ${JSON.stringify(stopFile)};`,
        "// An emit with no listener is silently lost: keep trying until the CLI is listening.",
        "const tick = () => {",
        '  if (existsSync(stop) && process.listenerCount("SIGINT") > 0) process.emit("SIGINT");',
        "  else setTimeout(tick, 50).unref();",
        "};",
        "setTimeout(tick, 50).unref();",
        "",
      ].join(NL_),
      "utf8",
    );
    const cli = spawn(process.execPath, ["--import", pathToFileURL(preload).href, CLI, "share", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { cli, stop: () => writeFileSync(stopFile, "", "utf8") };
  }

  it("queues a message with the right key for the hook, shows a wrong one as terminal-only, and cleans up", async () => {
    const dir = mktemp();
    const lines = readFileSync(SIMPLE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const sessionId = claudeCodeAdapter.convert(lines).sessionId;
    const native = join(dir, "native.jsonl");
    writeFileSync(native, lines.join("\n") + "\n", "utf8");
    const { base } = await relay();

    const { cli, stop } = spawnShare([native, "--steer", "--relay", base, "--dir", dir]);
    let out = "";
    let err = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    cli.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    // Wait for the banner: it carries the key and the link.
    await waitFor(() => /steer key: /.test(out), "the steer banner");
    const key = /steer key: ([A-Za-z0-9_-]+)/.exec(out)?.[1];
    const link = /http:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(out)?.[0];
    expect(key, out + err).toBeTruthy();
    expect(link, out + err).toBeTruthy();

    // Two viewers: one with the key (the terminal path, via `agit steer`),
    // one guessing (the page path, via plain HTTP).
    const sent = await agitAsync([
      "steer",
      link!,
      "look at the failing test first",
      "--steer-key",
      key!,
      "--name",
      "alice",
    ]);
    expect(sent.code, sent.stdout + sent.stderr).toBe(0);
    await fetch(`${link!.replace(/\/s\/.*$/, "")}/api/shares/${link!.split("/s/")[1]}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mallory", text: "rm -rf everything", key: "guess" }),
    });
    await waitFor(() => existsSync(steerInboxPath(dir, sessionId)), "the steer inbox file");

    // Only the keyed message is queued; the hook sees exactly that.
    const inbox = steerInboxPath(dir, sessionId);
    expect(existsSync(inbox), out + err).toBe(true);
    const queued = readFileSync(inbox, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { name: string });
    expect(queued.map((m) => m.name)).toEqual(["alice"]);
    const hook = await agitAsync(
      ["hook", "--dir", dir],
      JSON.stringify({ hook_event_name: "Stop", session_id: sessionId }),
    );
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain("look at the failing test first");
    expect(hook.stdout).not.toContain("rm -rf");

    await waitFor(() => out.includes("rm -rf everything"), "the rejected message in the terminal");
    stop();
    const code: number = await new Promise((r) => cli.on("close", (c) => r(c ?? -1)));
    expect(code, out + err).toBe(0);
    expect(out).toContain("⇢ agent (queued for its next turn): look at the failing test first");
    expect(out).toContain("(steer key rejected; terminal only) rm -rf everything");
    expect(out).not.toContain("never reached the agent"); // it was drained
    expect(existsSync(inbox)).toBe(false); // ended: nothing left behind
  }, 30_000);

  it("reports messages the agent never got when the share ends first", async () => {
    const dir = mktemp();
    const lines = readFileSync(SIMPLE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const native = join(dir, "native.jsonl");
    writeFileSync(native, lines.join("\n") + "\n", "utf8");
    const { base } = await relay();
    const { cli, stop } = spawnShare([native, "--steer", "--relay", base, "--dir", dir]);
    let out = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    await waitFor(() => /steer key: /.test(out), "the steer banner");
    const key = /steer key: ([A-Za-z0-9_-]+)/.exec(out)![1]!;
    const link = /http:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(out)![0];
    expect((await agitAsync(["steer", link, "one", "--steer-key", key])).code).toBe(0);
    expect((await agitAsync(["steer", link, "two", "--steer-key", key])).code).toBe(0);
    const sessionId = claudeCodeAdapter.convert(lines).sessionId;
    await waitFor(
      () =>
        existsSync(steerInboxPath(dir, sessionId)) &&
        readFileSync(steerInboxPath(dir, sessionId), "utf8")
          .split(NL_)
          .filter((l) => l.trim() !== "").length >= 2,
      "both messages queued",
    );
    stop();
    await new Promise((r) => cli.on("close", r));
    expect(out).toContain("2 steering message(s) were queued but never reached the agent");
  }, 60_000);

  it("accepts --steer on a pi session, keyed by the session header's id", async () => {
    const dir = mktemp();
    const pi = join(
      ROOT,
      "fixtures",
      "pi",
      "2026-05-28T20-26-40-000Z_8f3b2c1d-4e5a-4b6c-9d7e-0f1a2b3c4d5e.jsonl",
    );
    const native = join(dir, "session.jsonl");
    writeFileSync(native, readFileSync(pi));
    const { base } = await relay();
    const { cli, stop } = spawnShare([native, "--steer", "--relay", base, "--dir", dir]);
    let out = "";
    let err = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    cli.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    await waitFor(() => /steer key: /.test(out), "the steer banner");
    expect(out, out + err).toContain("pi's agent_end / before_agent_start extension events");
    expect(out).toContain("agit hook --config pi");
    const key = /steer key: ([A-Za-z0-9_-]+)/.exec(out)![1]!;
    const link = /http:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(out)![0];
    expect((await agitAsync(["steer", link, "read the README first", "--steer-key", key])).code).toBe(0);
    const sid = "8f3b2c1d-4e5a-4b6c-9d7e-0f1a2b3c4d5e";
    await waitFor(() => existsSync(steerInboxPath(dir, sid)), "the steer inbox file");
    expect(existsSync(steerInboxPath(dir, sid)), out + err).toBe(true);
    const hook = await agitAsync(
      ["hook", "--dir", dir],
      JSON.stringify({ hook_event_name: "AgentEnd", session_id: sid }),
    );
    expect(JSON.parse(hook.stdout)).toMatchObject({ message: { customType: "agit-steer" } });
    expect(hook.stdout).toContain("read the README first");
    stop();
    await new Promise((r) => cli.on("close", r));
  }, 60_000);

  it("accepts --steer on an OpenCode database, keyed by the session's own id", async () => {
    const dir = mktemp();
    const native = join(dir, "opencode.db");
    writeFileSync(native, readFileSync(join(ROOT, "fixtures", "opencode", "opencode-live.sqlite")));
    const { base } = await relay();
    const sid = "ses_fixtureaaaa0001";
    const { cli, stop } = spawnShare([native, "--thread", sid, "--steer", "--relay", base, "--dir", dir]);
    let out = "";
    let err = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    cli.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    await waitFor(() => /steer key: /.test(out), "the steer banner");
    expect(out, out + err).toContain("OpenCode's session.idle event / chat.message plugin hook");
    expect(out).toContain("agit hook --config opencode");
    const key = /steer key: ([A-Za-z0-9_-]+)/.exec(out)![1]!;
    const link = /http:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(out)![0];
    expect((await agitAsync(["steer", link, "ship it", "--steer-key", key])).code).toBe(0);
    await waitFor(() => existsSync(steerInboxPath(dir, sid)), "the steer inbox file");
    const hook = await agitAsync(
      ["hook", "--dir", dir],
      JSON.stringify({ hook_event_name: "SessionIdle", session_id: sid }),
    );
    expect(JSON.parse(hook.stdout)).toEqual({ text: expect.stringContaining("ship it") });
    stop();
    await new Promise((r) => cli.on("close", r));
  }, 60_000);

  it("accepts --steer on a Gemini CLI recording, keyed by the recording's own session id", async () => {
    const dir = mktemp();
    const gemini = join(ROOT, "fixtures", "gemini-cli", "session.jsonl");
    const native = join(dir, "session-x.jsonl");
    writeFileSync(native, readFileSync(gemini));
    const { base } = await relay();
    const { cli, stop } = spawnShare([native, "--steer", "--relay", base, "--dir", dir]);
    let out = "";
    let err = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    cli.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    await waitFor(() => /steer key: /.test(out), "the steer banner");
    expect(out, out + err).toContain("Gemini CLI AfterAgent / BeforeAgent hooks");
    expect(out).toContain("agit hook --config gemini-cli");
    const key = /steer key: ([A-Za-z0-9_-]+)/.exec(out)![1]!;
    const link = /http:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(out)![0];
    expect((await agitAsync(["steer", link, "use the other tool", "--steer-key", key])).code).toBe(0);
    // Queued under the Gemini session id, which is what its hooks will present as session_id.
    const sid = "0c3d7a1e-5b2f-4c8a-9d6e-1f2a3b4c5d6e";
    await waitFor(() => existsSync(steerInboxPath(dir, sid)), "the steer inbox file");
    expect(existsSync(steerInboxPath(dir, sid)), out + err).toBe(true);
    const hook = await agitAsync(
      ["hook", "--dir", dir],
      JSON.stringify({ hook_event_name: "AfterAgent", session_id: sid }),
    );
    expect(JSON.parse(hook.stdout)).toMatchObject({ decision: "block" });
    expect(hook.stdout).toContain("use the other tool");
    stop();
    await new Promise((r) => cli.on("close", r));
  }, 60_000);

  it("refuses runtimes without a documented hook, static shares, and a relay that ignores the flag", async () => {
    const dir = mktemp();
    const { base } = await relay();
    const codex = await agitAsync(["share", CODEX, "--steer", "--relay", base, "--dir", dir]);
    expect(codex.code).toBe(2);
    expect(codex.stderr).toContain("codex has no documented turn-boundary hook");

    const stat = await agitAsync(["share", SIMPLE, "--steer", "--static", "--relay", base, "--dir", dir]);
    expect(stat.code).toBe(2);
    expect(stat.stderr).toContain("--steer needs a live session");

    // A relay from before --steer existed answers without echoing the flag:
    // it would forward no keys, so a share that promised steering would lie.
    const old = await hostileRelay(() => ({
      shareId: "abcdefghijklmnop",
      writerToken: "t",
      ttlMs: 3600_000,
      path: "/s/abcdefghijklmnop",
    }));
    await expect(createShare(old, undefined, { steer: true })).rejects.toThrow("does not support steering");
    // Without the ask, the same answer is fine.
    expect((await createShare(old)).steer).toBe(false);
  });

  it("agit steer insists on a key, because without one it would only be chat", () => {
    const r = agit(["steer", "https://relay.example/s/abcdefghijkl", "hello"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--steer-key is required");
  });

  it("SteerQueue holds a message until the session id is known, then binds and resets stale files", async () => {
    const dir = mktemp();
    queueSteer(dir, SID, { ts: "t", name: "stale", text: "from an earlier share" });
    let known: string | null = null;
    const q = new SteerQueue(dir, () => known);
    q.enqueue({ ts: "t", name: "alice", text: "early" });
    expect(q.undelivered()).toBe(1);
    expect(existsSync(steerInboxPath(dir, SID))).toBe(true); // the stale file, untouched so far
    known = SID;
    // The queue retries on a timer once the id is known; wait for the write, not the clock.
    await waitFor(
      () => readFileSync(steerInboxPath(dir, SID), "utf8").includes('"alice"'),
      "the buffered message to land",
    );
    expect(drainSteer(dir, SID).delivered.map((m) => m.name)).toEqual(["alice"]);
    expect(q.close()).toBe(0);
    expect(existsSync(steerInboxPath(dir, SID))).toBe(false);
  });
});
