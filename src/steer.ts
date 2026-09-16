/**
 * Steering: viewer messages that reach the agent — opt-in, at a turn boundary.
 *
 * Sharing is watch-only by default: a viewer's message lands in the sharing
 * human's terminal and nowhere else. `agit share --steer` adds one thing. A
 * viewer who holds the steer key the sharer issued can queue a message for
 * the agent, and the agent reads it the next time its own runtime gives a
 * hook the floor. Nothing is injected mid-run, nothing is typed into a
 * terminal on the human's behalf, and the human sees every queued message in
 * the share terminal as it arrives, attributed.
 *
 * A runtime is wired only where it documents a path. Five do:
 *
 * Claude Code (code.claude.com/docs/en/hooks, "Stop decision control" and
 * "UserPromptSubmit decision control"):
 *   - Stop: `hookSpecificOutput.additionalContext` is "non-error feedback for
 *     Claude. The conversation continues so Claude can act on it", shown in
 *     the transcript as hook feedback. Claude Code's own loop guards apply —
 *     the `stop_hook_active` input and its cap of 8 consecutive continuations.
 *   - UserPromptSubmit: the same field rides alongside the human's next
 *     prompt, which covers the case where the agent was idle when the
 *     message arrived.
 *   Verified against the runtime (claude 2.1.263, -p mode).
 *
 * Gemini CLI (docs/hooks/reference.md, "Agent hooks", in
 * google-gemini/gemini-cli; the mechanics in packages/core/src/core/
 * client.ts and hooks/types.ts):
 *   - AfterAgent: a `decision` of `"block"` with a `reason` — the reason "is
 *     sent to the agent as a new prompt". In client.ts a blocking decision
 *     yields `AgentExecutionBlocked` and calls `sendMessageStream` with the
 *     reason as the next request; the history is kept (only
 *     `clearContext`, which this never sets, would reset it), and the
 *     continuation runs with `stop_hook_active` true and a bounded turn
 *     count. So the transcript shows a hook block whose reason is the
 *     teammate's message, and the agent answers it with everything it had.
 *   - BeforeAgent: `hookSpecificOutput.additionalContext` is "appended to
 *     the prompt for this turn only" — the idle case. Gemini escapes `<`
 *     and `>` in it (`getAdditionalContext`), so a message reads as text.
 *   Both hooks share the base input (`session_id`, `hook_event_name`), and
 *   `session_id` is `Config.getSessionId()`, the same value the recorder
 *   writes as the recording's `sessionId` — the id the adapter reports.
 *   Derived from the source above; not yet exercised against a running
 *   Gemini CLI.
 *
 * pi and OpenCode take an extension or plugin file rather than a settings
 * fragment; each is printed by `agit hook --config <runtime>` and described
 * beside its source below. OpenCode's two boundaries are its `chat.message`
 * plugin hook (the human's next prompt, the idle case) and the
 * `session.idle` event (the agent just finished), both from
 * packages/plugin/src/index.ts in sst/opencode; the plugin hands the
 * messages over as a synthetic text part of the prompt, or as a prompt of
 * their own through the SDK. Derived from the source; not yet exercised
 * against a running OpenCode.
 *
 * Hermes Agent (website/docs/user-guide/features/hooks.md in
 * NousResearch/hermes-agent; the mechanics in agent/shell_hooks.py,
 * agent/turn_context.py, agent/turn_stop_gates.py, hermes_cli/plugins.py):
 * shell hooks declared under `hooks:` in ~/.hermes/config.yaml, each a
 * command Hermes runs with JSON on stdin (`_serialize_payload`:
 * `hook_event_name`, `session_id`, `cwd`, …) and reads JSON from. Hermes
 * writes the event name itself, so the two below are its own:
 *   - `pre_llm_call`: fires once per turn before the tool loop; stdout
 *     `{"context": …}` (`_parse_context`) is appended to the user message
 *     (`_collect_pre_llm_call_context`) — the idle case.
 *   - `pre_verify`: the round-end gate, `{"action": "continue", "message":
 *     …}` (`_parse_pre_verify`; Claude Code's Stop dialect is accepted too)
 *     appends the message as a synthetic user nudge and re-enters the turn
 *     (`_pre_verify_nudge` in turn_stop_gates.py). It fires only after a
 *     turn that edited files, at most `max_verify_nudges` (3) times per
 *     turn — so after a turn with no edits a message waits for the next
 *     prompt's pre_llm_call; README says so.
 *   `session_id` is `agent.session_id`, the value Hermes persists as
 *   `sessions.id` / `messages.session_id` in state.db, which the adapter
 *   reports. Hermes runs the command with `shell=False` in its own cwd
 *   (`_spawn`), so `agit share` must run from the directory hermes runs in,
 *   and on Windows the command has to name `agit.cmd`. Hermes asks once
 *   to allow each (event, command) pair. Derived from the source; not yet
 *   exercised against a running Hermes.
 *
 * Hook output strings are capped at 10,000 characters by Claude Code; a
 * drain that would exceed the budget delivers what fits and leaves the rest
 * queued for the next boundary, and says so. Gemini CLI publishes no cap;
 * the same budget applies.
 *
 * Files, under the store: `.agit/steer/<runtime session id>.jsonl` holds one
 * message per line, appended by the sharer; `<id>.cursor` holds how many of
 * those lines a hook has already delivered, written by the hook only. Two
 * writers, two files, one direction each — so no lock: the sharer only ever
 * appends, and the hook only ever counts complete lines (a line without its
 * newline is still being written and is left for the next drain).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agitDir, assertSafeSessionId } from "./store.js";

export interface SteerMessage {
  /** ISO timestamp the relay stamped on the message. */
  ts: string;
  name: string;
  text: string;
}

/** Runtimes with a documented turn-boundary hook. Adapter names, not display names. */
export const STEERABLE_RUNTIMES: ReadonlySet<string> = new Set([
  "claude-code",
  "gemini-cli",
  "pi",
  "opencode",
  "hermes",
]);

/** What to tell the sharer about the hooks their runtime fires. */
export function steerHookDescription(runtime: string): string {
  if (runtime === "gemini-cli") return "Gemini CLI AfterAgent / BeforeAgent hooks";
  if (runtime === "pi") return "pi's agent_end / before_agent_start extension events";
  if (runtime === "opencode") return "OpenCode's session.idle event / chat.message plugin hook";
  if (runtime === "hermes") return "Hermes Agent's pre_llm_call / pre_verify shell hooks";
  return "Claude Code Stop / UserPromptSubmit hooks";
}

/** Claude Code caps hook output strings at 10,000 characters; leave headroom for the framing. */
export const STEER_CONTEXT_BUDGET = 9_000;

export function steerDir(base: string): string {
  return join(agitDir(base), "steer");
}

export function steerInboxPath(base: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(steerDir(base), `${sessionId}.jsonl`);
}

function cursorPath(base: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(steerDir(base), `${sessionId}.cursor`);
}

/** 72 bits, URL-safe, short enough to read out loud in a standup. */
export function newSteerKey(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Constant-time comparison over digests, so neither the length nor the
 * position of the first mismatch leaks — the relay forwards whatever a
 * viewer typed, and a viewer with the link may try as often as the relay's
 * per-sender message budget allows.
 */
export function steerKeyMatches(offered: unknown, expected: string): boolean {
  if (typeof offered !== "string" || offered === "") return false;
  const a = createHash("sha256").update(offered).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Forget anything queued for this session by an earlier share. */
export function resetSteer(base: string, sessionId: string): void {
  rmSync(steerInboxPath(base, sessionId), { force: true });
  rmSync(cursorPath(base, sessionId), { force: true });
}

/** Append one message. Newline-terminated, so a reader can tell a whole line from one still landing. */
export function queueSteer(base: string, sessionId: string, msg: SteerMessage): void {
  mkdirSync(steerDir(base), { recursive: true });
  const line = JSON.stringify({ ts: msg.ts, name: msg.name, text: msg.text });
  if (line.includes("\n")) throw new Error("steer message serialized with a raw newline");
  appendFileSync(steerInboxPath(base, sessionId), line + "\n", "utf8");
}

/** Complete lines only: a trailing fragment without its newline is not yet a message. */
function completeLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const end = raw.lastIndexOf("\n");
  if (end === -1) return [];
  return raw.slice(0, end).split("\n");
}

function readCursor(base: string, sessionId: string): number {
  try {
    const n = Number(readFileSync(cursorPath(base, sessionId), "utf8").trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export interface Drained {
  delivered: SteerMessage[];
  /** Messages still queued because the budget ran out. */
  remaining: number;
}

/**
 * Take what a hook can deliver now and advance the cursor past it. Lines that
 * do not parse are skipped, counted into the cursor, and never retried — a
 * torn line at the tail is not one of them, because completeLines() leaves
 * it for the next drain.
 */
export function drainSteer(base: string, sessionId: string, budget = STEER_CONTEXT_BUDGET): Drained {
  const lines = completeLines(steerInboxPath(base, sessionId));
  let cursor = readCursor(base, sessionId);
  // A cursor past the end means the inbox was reset under it: start over.
  if (cursor > lines.length) cursor = 0;
  const delivered: SteerMessage[] = [];
  let used = 0;
  let consumed = cursor;
  for (let i = cursor; i < lines.length; i++) {
    let msg: SteerMessage;
    try {
      const p = JSON.parse(lines[i]!) as Partial<SteerMessage>;
      if (typeof p.text !== "string" || typeof p.name !== "string" || typeof p.ts !== "string") {
        consumed = i + 1;
        continue;
      }
      msg = { ts: p.ts, name: p.name, text: p.text };
    } catch {
      consumed = i + 1;
      continue;
    }
    const cost = renderLine(msg).length + 1;
    if (delivered.length > 0 && used + cost > budget) break;
    if (cost > budget) {
      // One message alone over budget: deliver a truncated copy rather than
      // wedge the queue behind it forever.
      const room = Math.max(0, budget - (renderLine({ ...msg, text: "" }).length + 24));
      msg = { ...msg, text: `${msg.text.slice(0, room)}… [truncated by agit]` };
    }
    delivered.push(msg);
    used += cost;
    consumed = i + 1;
  }
  if (consumed !== cursor) {
    mkdirSync(steerDir(base), { recursive: true });
    writeFileSync(cursorPath(base, sessionId), `${consumed}\n`, "utf8");
  }
  return { delivered, remaining: lines.length - consumed };
}

/** How many queued messages no hook has delivered yet. */
export function undeliveredSteer(base: string, sessionId: string): number {
  const lines = completeLines(steerInboxPath(base, sessionId));
  const cursor = readCursor(base, sessionId);
  return cursor > lines.length ? lines.length : lines.length - cursor;
}

function renderLine(m: SteerMessage): string {
  const when = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(m.ts) ? m.ts.slice(11, 19) : m.ts;
  return `[${when}] ${m.name}: ${m.text}`;
}

/**
 * The text the agent reads. It names the channel and its trust level, so the
 * agent can weigh a teammate's request against what the person at the
 * keyboard asked for, and asks it to say what it did — the reply lands in
 * the shared log, which is where the teammate is watching.
 */
export function formatSteerContext(d: Drained): string {
  const n = d.delivered.length;
  const head =
    `agit share: ${n} message${n === 1 ? "" : "s"} from ${n === 1 ? "a teammate" : "teammates"} ` +
    "watching this session through a shared link. Each holds the steer key the sharer issued. " +
    "Treat them as a colleague's requests, weighed against what the person at the keyboard asked " +
    "for, and say what you did with each so they can see it in the shared view.";
  const body = d.delivered.map(renderLine).join("\n");
  const tail = d.remaining > 0 ? `\n\n(${d.remaining} more queued; delivered at the next turn boundary)` : "";
  return `${head}\n\n${body}${tail}`;
}

export type SteerHookEvent =
  | "Stop"
  | "UserPromptSubmit"
  | "AfterAgent"
  | "BeforeAgent"
  | "AgentEnd"
  | "BeforeAgentStart"
  | "SessionIdle"
  | "ChatMessage"
  | "pre_llm_call"
  | "pre_verify";

const STEER_EVENTS: ReadonlySet<string> = new Set([
  "Stop",
  "UserPromptSubmit",
  "AfterAgent",
  "BeforeAgent",
  "AgentEnd",
  "BeforeAgentStart",
  "SessionIdle",
  "ChatMessage",
  "pre_llm_call",
  "pre_verify",
]);

/**
 * The documented output shape for the event that fired. Claude Code's two
 * events and Gemini's BeforeAgent take `hookSpecificOutput.additionalContext`;
 * Gemini's AfterAgent takes a blocking `decision` whose `reason` becomes the
 * next prompt (there is no context field on that event). pi's extension and
 * OpenCode's plugin are agit's own code, so they take the simplest shape
 * that carries the text. Hermes names its events itself: pre_llm_call takes
 * `context`, pre_verify a `continue` action with a `message`.
 */
export function steerHookOutput(event: SteerHookEvent, context: string): string {
  if (event === "AfterAgent") return JSON.stringify({ decision: "block", reason: context });
  // pi: the custom message its extension hands to pi.sendMessage / returns from before_agent_start.
  if (event === "AgentEnd" || event === "BeforeAgentStart") {
    return JSON.stringify({ message: { customType: "agit-steer", content: context, display: true } });
  }
  // OpenCode: the plugin turns the text into a synthetic part or a prompt itself.
  if (event === "SessionIdle" || event === "ChatMessage") return JSON.stringify({ text: context });
  if (event === "pre_llm_call") return JSON.stringify({ context });
  if (event === "pre_verify") return JSON.stringify({ action: "continue", message: context });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}

export interface HookRun {
  /** Empty when there is nothing to say — Claude Code treats no output as "no opinion". */
  stdout: string;
  /** Always 0: a steering hook must never turn into an error in someone's session. */
  exit: 0;
}

/**
 * One hook invocation. `input` is the JSON the runtime wrote to stdin. Only
 * the main agent's turn-boundary events are served — Claude Code's Stop and
 * UserPromptSubmit, Gemini CLI's AfterAgent and BeforeAgent, pi's AgentEnd
 * and BeforeAgentStart, OpenCode's SessionIdle and ChatMessage, Hermes's
 * pre_llm_call and pre_verify; a subagent's
 * hook (Claude Code marks one with `agent_id`) and every other event drain
 * nothing, because the message was addressed to the session, not to a
 * helper inside it.
 */
export function runSteerHook(base: string, input: string): HookRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { stdout: "", exit: 0 };
  }
  if (parsed === null || typeof parsed !== "object") return { stdout: "", exit: 0 };
  const rec = parsed as Record<string, unknown>;
  const event = rec.hook_event_name;
  if (typeof event !== "string" || !STEER_EVENTS.has(event)) return { stdout: "", exit: 0 };
  if (typeof rec.agent_id === "string") return { stdout: "", exit: 0 };
  const sessionId = rec.session_id;
  if (typeof sessionId !== "string") return { stdout: "", exit: 0 };
  try {
    assertSafeSessionId(sessionId);
  } catch {
    return { stdout: "", exit: 0 };
  }
  if (!existsSync(steerInboxPath(base, sessionId))) return { stdout: "", exit: 0 };
  const drained = drainSteer(base, sessionId);
  if (drained.delivered.length === 0) return { stdout: "", exit: 0 };
  return { stdout: steerHookOutput(event as SteerHookEvent, formatSteerContext(drained)), exit: 0 };
}

/**
 * The settings.json fragment that wires a runtime's two events to
 * `agit hook`: Claude Code's `timeout` is seconds, Gemini CLI's milliseconds
 * (docs/hooks/reference.md, "Hook configuration"), and Gemini takes a
 * `name` for its logs.
 */
export function steerHookConfig(runtime = "claude-code"): string {
  if (runtime === "pi") return PI_EXTENSION_LINES.join("\n") + "\n";
  if (runtime === "opencode") return OPENCODE_PLUGIN_LINES.join("\n") + "\n";
  if (runtime === "hermes") return HERMES_HOOKS_YAML;
  if (runtime === "gemini-cli") {
    const handler = {
      hooks: [{ type: "command", command: "agit hook", name: "agit-steer", timeout: 10_000 }],
    };
    return JSON.stringify({ hooks: { AfterAgent: [handler], BeforeAgent: [handler] } }, null, 2);
  }
  const handler = { hooks: [{ type: "command", command: "agit hook", timeout: 10 }] };
  return JSON.stringify({ hooks: { Stop: [handler], UserPromptSubmit: [handler] } }, null, 2);
}

/**
 * The `hooks:` block for ~/.hermes/config.yaml (agent/shell_hooks.py,
 * `_parse_hooks_block`: one list of entries per event, `command` required,
 * `timeout` in seconds, default 60, max 300). Hermes splits the command
 * itself and runs it without a shell, so it is two words.
 */
const HERMES_HOOKS_YAML = [
  "hooks:",
  "  pre_llm_call:",
  '    - command: "agit hook"',
  "      timeout: 10",
  "  pre_verify:",
  '    - command: "agit hook"',
  "      timeout: 10",
  "",
].join("\n");

/**
 * The pi extension `agit hook --config pi` prints, as one TypeScript source
 * (pi loads `~/.pi/agent/extensions/*.ts` through jiti, uncompiled). It runs
 * `agit hook` — agit on PATH, in the session's cwd — at the two documented
 * boundaries and hands what comes back to pi through pi's own API:
 *   - `before_agent_start` returns `{ message }`, which pi stores in the
 *     session and sends to the model ("can inject a message");
 *   - `agent_end` calls `pi.sendMessage(message, { deliverAs: "followUp",
 *     triggerTurn: true })`: delivered once the agent has no more tool calls,
 *     and a fresh turn if it was idle.
 * Lines are joined here so the file carries no template literal of its own.
 */
const PI_EXTENSION_LINES: readonly string[] = [
  "// agit-steer: hands messages queued by `agit share --steer` to pi at its turn boundaries.",
  "// Printed by `agit hook --config pi`; lives at ~/.pi/agent/extensions/agit-steer.ts.",
  "// Runs `agit hook` (agit must be on PATH), which prints nothing unless a live share queued a message.",
  'import { execFileSync } from "node:child_process";',
  'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  "",
  "type SteerMessage = { customType: string; content: string; display: boolean };",
  "",
  "function drain(event: string, sessionId: string, cwd: string): SteerMessage | null {",
  "  try {",
  '    const out = execFileSync("agit", ["hook"], {',
  "      cwd,",
  '      encoding: "utf8",',
  "      input: JSON.stringify({ hook_event_name: event, session_id: sessionId }),",
  "      timeout: 10_000,",
  "      windowsHide: true,",
  '      shell: process.platform === "win32",',
  "    });",
  '    if (out.trim() === "") return null;',
  "    const parsed = JSON.parse(out) as { message?: SteerMessage };",
  '    return parsed !== null && typeof parsed === "object" && parsed.message ? parsed.message : null;',
  "  } catch {",
  "    return null;",
  "  }",
  "}",
  "",
  "export default function (pi: ExtensionAPI) {",
  '  pi.on("before_agent_start", async (_event, ctx) => {',
  '    const message = drain("BeforeAgentStart", ctx.sessionManager.getSessionId(), ctx.cwd);',
  "    return message ? { message } : undefined;",
  "  });",
  '  pi.on("agent_end", async (_event, ctx) => {',
  '    const message = drain("AgentEnd", ctx.sessionManager.getSessionId(), ctx.cwd);',
  '    if (message) pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });',
  "  });",
  "}",
];

/**
 * The OpenCode plugin `agit hook --config opencode` prints, as one
 * TypeScript source (OpenCode loads `{plugin,plugins}/*.{ts,js}` under the
 * project's `.opencode` and the global config dir at startup —
 * packages/opencode/src/config/plugin.ts). It runs `agit hook` — agit on
 * PATH, in the project directory the plugin is handed — at the two
 * documented boundaries and hands what comes back to OpenCode through
 * OpenCode's own API (packages/plugin/src/index.ts):
 *   - `chat.message` fires with the parts of the prompt OpenCode is about to
 *     store (session/prompt.ts) and the hook may add to them: the messages
 *     ride along as one synthetic text part of the human's next prompt;
 *   - `event` sees `session.idle`, which session/status.ts publishes when a
 *     session's status becomes idle: the messages start a fresh turn through
 *     `client.session.promptAsync` (POST /session/{id}/prompt_async, "start
 *     if needed and return immediately").
 * Lines are joined here so the file carries no template literal of its own.
 */
const OPENCODE_PLUGIN_LINES: readonly string[] = [
  "// agit-steer: hands messages queued by `agit share --steer` to OpenCode at its turn boundaries.",
  "// Printed by `agit hook --config opencode`; save it as .opencode/plugins/agit-steer.ts in the project",
  "// (or ~/.config/opencode/plugins/agit-steer.ts for every project). OpenCode loads it at startup.",
  "// Runs `agit hook` (agit must be on PATH), which prints nothing unless a live share queued a message.",
  'import { execFileSync } from "node:child_process";',
  'import { randomBytes } from "node:crypto";',
  'import type { Plugin } from "@opencode-ai/plugin";',
  "",
  "function drain(event: string, sessionID: string, cwd: string): string | null {",
  "  try {",
  '    const out = execFileSync("agit", ["hook"], {',
  "      cwd,",
  '      encoding: "utf8",',
  "      input: JSON.stringify({ hook_event_name: event, session_id: sessionID }),",
  "      timeout: 10_000,",
  "      windowsHide: true,",
  '      shell: process.platform === "win32",',
  "    });",
  '    if (out.trim() === "") return null;',
  "    const parsed = JSON.parse(out) as { text?: unknown };",
  '    return parsed !== null && typeof parsed === "object" && typeof parsed.text === "string" ? parsed.text : null;',
  "  } catch {",
  "    return null;",
  "  }",
  "}",
  "",
  "// A part id in OpenCode's own shape (src/id/id.ts: prefix, the low 48 bits of time * 4096 + counter,",
  "// then 14 base62 characters), with the counter at its maximum so the part sorts after the ones the",
  "// prompt already has.",
  "function partId(): string {",
  "  const mask = (BigInt(1) << BigInt(48)) - BigInt(1);",
  "  const now = (BigInt(Date.now()) * BigInt(0x1000) + BigInt(0xfff)) & mask;",
  '  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";',
  "  const bytes = randomBytes(14);",
  '  let tail = "";',
  "  for (let i = 0; i < 14; i++) tail += chars[bytes[i]! % 62];",
  '  return "prt_" + now.toString(16).padStart(12, "0") + tail;',
  "}",
  "",
  "export const AgitSteer: Plugin = async ({ client, directory }) => ({",
  "  // The human's next prompt: the queued messages ride along as one synthetic text part of it.",
  '  "chat.message": async (input, output) => {',
  '    const text = drain("ChatMessage", input.sessionID, directory);',
  "    if (text === null) return;",
  "    output.parts.push({",
  "      id: partId(),",
  "      sessionID: input.sessionID,",
  "      messageID: output.message.id,",
  '      type: "text",',
  "      text,",
  "      synthetic: true,",
  "    });",
  "  },",
  "  // The agent went idle: the queued messages start a fresh turn of their own.",
  "  event: async ({ event }) => {",
  '    if (event.type !== "session.idle") return;',
  "    const sessionID = event.properties.sessionID;",
  '    const text = drain("SessionIdle", sessionID, directory);',
  "    if (text === null) return;",
  '    await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } });',
  "  },",
  "});",
];

/**
 * Buffers queued messages until the runtime session id is known. A live
 * share learns the id from the follower's first poll, which happens a beat
 * after the inbox opens; a message in that window waits here rather than
 * being dropped or keyed by a guess.
 */
export class SteerQueue {
  private buffered: SteerMessage[] = [];
  private timer: NodeJS.Timeout | null = null;
  private resolved: string | null = null;

  constructor(
    private readonly base: string,
    private readonly sessionIdOf: () => string | null,
  ) {}

  /** The session id once known; null before the first poll. */
  get sessionId(): string | null {
    return this.resolved ?? this.sessionIdOf();
  }

  enqueue(msg: SteerMessage): void {
    this.buffered.push(msg);
    if (!this.flush() && this.timer === null) {
      this.timer = setInterval(() => {
        if (this.flush()) this.stopTimer();
      }, 250);
      this.timer.unref();
    }
  }

  /** Write everything buffered; false if the id is still unknown. */
  flush(): boolean {
    const id = this.sessionId;
    if (id === null) return false;
    if (this.resolved === null) {
      this.resolved = id;
      resetSteer(this.base, id);
    }
    for (const m of this.buffered) queueSteer(this.base, id, m);
    this.buffered = [];
    return true;
  }

  /** Messages no hook has delivered, including any still buffered here. */
  undelivered(): number {
    const id = this.sessionId;
    return this.buffered.length + (id === null ? 0 : undeliveredSteer(this.base, id));
  }

  /** End of share: nothing further will be queued; drop the files. */
  close(): number {
    this.stopTimer();
    const n = this.undelivered();
    const id = this.sessionId;
    if (id !== null) resetSteer(this.base, id);
    this.buffered = [];
    return n;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
