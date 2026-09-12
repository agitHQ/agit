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
 * Only Claude Code is wired, because only Claude Code documents a path
 * (code.claude.com/docs/en/hooks, "Stop decision control" and
 * "UserPromptSubmit decision control"):
 *
 *   - Stop: `hookSpecificOutput.additionalContext` is "non-error feedback for
 *     Claude. The conversation continues so Claude can act on it", shown in
 *     the transcript as hook feedback. Claude Code's own loop guards apply —
 *     the `stop_hook_active` input and its cap of 8 consecutive continuations.
 *   - UserPromptSubmit: the same field rides alongside the human's next
 *     prompt, which covers the case where the agent was idle when the
 *     message arrived.
 *
 * Hook output strings are capped at 10,000 characters by Claude Code; a
 * drain that would exceed the budget delivers what fits and leaves the rest
 * queued for the next boundary, and says so.
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
export const STEERABLE_RUNTIMES: ReadonlySet<string> = new Set(["claude-code"]);

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

export type SteerHookEvent = "Stop" | "UserPromptSubmit";

/** The documented `hookSpecificOutput` shape, keyed to the event that fired. */
export function steerHookOutput(event: SteerHookEvent, context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}

export interface HookRun {
  /** Empty when there is nothing to say — Claude Code treats no output as "no opinion". */
  stdout: string;
  /** Always 0: a steering hook must never turn into an error in someone's session. */
  exit: 0;
}

/**
 * One hook invocation. `input` is the JSON Claude Code wrote to stdin. Only
 * the main agent's Stop and UserPromptSubmit are served; a subagent's hook
 * (which carries `agent_id`) and every other event drain nothing, because
 * the message was addressed to the session, not to a helper inside it.
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
  if (event !== "Stop" && event !== "UserPromptSubmit") return { stdout: "", exit: 0 };
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
  return { stdout: steerHookOutput(event, formatSteerContext(drained)), exit: 0 };
}

/** The settings.json fragment that wires both events to `agit hook`. */
export function steerHookConfig(): string {
  const handler = { hooks: [{ type: "command", command: "agit hook", timeout: 10 }] };
  return JSON.stringify({ hooks: { Stop: [handler], UserPromptSubmit: [handler] } }, null, 2);
}

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
