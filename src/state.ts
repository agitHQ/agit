/**
 * Views over an event log: cumulative file state at any point, usage totals,
 * compact per-event rendering. All read-only folds over events — no I/O.
 */

import type { AgitEvent, Json } from "./format/events.js";

export interface FileState {
  path: string;
  kind: "create" | "modify";
  afterHash: string;
  lastSeq: number;
  edits: number;
  added: number;
  removed: number;
  /**
   * Seq of the first structured edit whose beforeHash contradicted the last
   * known content hash — cryptographic proof the file was modified outside
   * structured edits somewhere in between (a shell command, the user, another
   * process). Undefined means "no contradiction observed", not "unchanged".
   */
  divergedAtSeq?: number;
  /** Seq of the structured deletion that removed the file. A later edit of the same path clears it. */
  deletedAtSeq?: number;
}

/** Fold file.diff events up to and including seq `at` (default: all). Lower bound on reality — SPEC §5.7. */
export function fileStateAt(events: AgitEvent[], at?: number): Map<string, FileState> {
  const files = new Map<string, FileState>();
  for (const e of events) {
    if (at !== undefined && e.seq > at) break;
    if (e.type === "file.delete") {
      const d = e.payload as { path?: Json; beforeHash?: Json };
      if (typeof d.path !== "string") continue;
      const prev = files.get(d.path);
      // A deletion's beforeHash is a claim about the content that was removed;
      // if it contradicts the last content we know, something edited the file
      // outside structured edits first — the same proof file.diff gives.
      const contradicted =
        prev !== undefined && typeof d.beforeHash === "string" && d.beforeHash !== prev.afterHash;
      files.set(d.path, {
        path: d.path,
        kind: prev?.kind ?? "modify",
        afterHash: prev?.afterHash ?? "",
        lastSeq: e.seq,
        edits: (prev?.edits ?? 0) + 1,
        added: prev?.added ?? 0,
        removed: prev?.removed ?? 0,
        divergedAtSeq: prev?.divergedAtSeq ?? (contradicted ? e.seq : undefined),
        deletedAtSeq: e.seq,
      });
      continue;
    }
    if (e.type !== "file.diff") continue;
    const p = e.payload as { path?: Json; kind?: Json; afterHash?: Json; beforeHash?: Json; diff?: Json };
    if (typeof p.path !== "string" || typeof p.afterHash !== "string") continue;
    const { added, removed } = diffStat(typeof p.diff === "string" ? p.diff : "");
    const prev = files.get(p.path);
    const contradicted =
      prev !== undefined && typeof p.beforeHash === "string" && p.beforeHash !== prev.afterHash;
    files.set(p.path, {
      path: p.path,
      kind: prev ? prev.kind : p.kind === "create" ? "create" : "modify",
      afterHash: p.afterHash,
      lastSeq: e.seq,
      edits: (prev?.edits ?? 0) + 1,
      added: (prev?.added ?? 0) + added,
      removed: (prev?.removed ?? 0) + removed,
      divergedAtSeq: prev?.divergedAtSeq ?? (contradicted ? e.seq : undefined),
    });
  }
  return files;
}

/**
 * Timeline rows for a session, one line per event — with a date separator
 * whenever the (UTC) date changes, so a multi-day session never reads
 * 23:59 -> 00:03 as if seconds passed. Single-day sessions get no separators.
 */
export function timelineLines(events: AgitEvent[]): string[] {
  const out: string[] = [];
  if (events.length === 0) return out;
  const spansDays = events[0]!.ts.slice(0, 10) !== events[events.length - 1]!.ts.slice(0, 10);
  let currentDate = "";
  for (const e of events) {
    const date = e.ts.slice(0, 10);
    if (spansDays && date !== currentDate) {
      out.push(`       ────── ${date} ──────`);
      currentDate = date;
    }
    out.push(`${String(e.seq).padStart(5)}  ${e.ts.slice(11, 19)}  ${eventLine(e)}`);
  }
  return out;
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiMessages: number;
  models: Set<string>;
}

export function usageTotals(events: AgitEvent[], at?: number): UsageTotals {
  const t: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    apiMessages: 0,
    models: new Set(),
  };
  for (const e of events) {
    if (at !== undefined && e.seq > at) break;
    if (e.type !== "cost") continue;
    const p = e.payload as { model?: Json; usage?: { [k: string]: Json } };
    if (typeof p.model === "string") t.models.add(p.model);
    const u = p.usage ?? {};
    t.inputTokens += num(u.inputTokens);
    t.outputTokens += num(u.outputTokens);
    t.cacheReadInputTokens += num(u.cacheReadInputTokens);
    t.cacheCreationInputTokens += num(u.cacheCreationInputTokens);
    t.apiMessages++;
  }
  return t;
}

function num(v: Json | undefined): number {
  return typeof v === "number" ? v : 0;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiMessages: number;
  /** Distinct paths whose edits are attributed to this model. */
  files: Set<string>;
}

/**
 * Split usage by model, and attribute file edits to one.
 *
 * Tokens are exact: every cost event names its own model. File attribution
 * is a stated rule rather than recorded fact — a file.diff carries no model —
 * so an edit is credited to the nearest preceding event that names one (the
 * assistant message that called the tool, or the cost of that exchange).
 * Edits before any such event are credited to "(unattributed)" rather than
 * guessed at, and callers are expected to print the rule alongside the table.
 */
export function usageByModel(events: AgitEvent[], at?: number): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  const UNATTRIBUTED = "(unattributed)";
  const bucket = (model: string): ModelUsage => {
    let m = byModel.get(model);
    if (!m) {
      m = {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        apiMessages: 0,
        files: new Set(),
      };
      byModel.set(model, m);
    }
    return m;
  };

  // Every model named anywhere in the window. With exactly one, there is no
  // attribution question to be honest about: every edit is its.
  const named = new Set<string>();
  for (const e of events) {
    if (at !== undefined && e.seq > at) break;
    const m = (e.payload as { model?: Json }).model;
    if (typeof m === "string" && m !== "") named.add(m);
  }
  const only = named.size === 1 ? [...named][0]! : null;

  // Codex names the model on the assistant message that *ends* a turn, after
  // its tool calls; Claude Code names it on the one that starts the turn.
  // So an edit with nothing before it looks forward to the end of its turn.
  const modelLaterInTurn = (from: number): string | null => {
    for (let j = from + 1; j < events.length; j++) {
      const e = events[j]!;
      if (at !== undefined && e.seq > at) break;
      if (e.type === "message.user") break;
      const m = (e.payload as { model?: Json }).model;
      if (typeof m === "string" && m !== "") return m;
    }
    return null;
  };

  let current: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (at !== undefined && e.seq > at) break;
    const p = e.payload as { model?: Json; usage?: { [k: string]: Json }; path?: Json };
    if (e.type === "message.user") current = null; // a new turn: nothing precedes yet
    if (typeof p.model === "string" && p.model !== "") current = p.model;

    if (e.type === "cost") {
      const m = bucket(typeof p.model === "string" && p.model !== "" ? p.model : UNATTRIBUTED);
      const u = p.usage ?? {};
      m.inputTokens += num(u.inputTokens);
      m.outputTokens += num(u.outputTokens);
      m.cacheReadInputTokens += num(u.cacheReadInputTokens);
      m.cacheCreationInputTokens += num(u.cacheCreationInputTokens);
      m.apiMessages++;
      continue;
    }
    if (e.type === "file.diff" && typeof p.path === "string") {
      bucket(current ?? modelLaterInTurn(i) ?? only ?? UNATTRIBUTED).files.add(p.path);
    }
  }

  // Busiest first by output tokens, then by name so ties stay deterministic.
  return [...byModel.values()].sort(
    (a, b) => b.outputTokens - a.outputTokens || a.model.localeCompare(b.model),
  );
}

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

/** One-line rendering for timelines. */
export function eventLine(e: AgitEvent): string {
  const p = e.payload as { [k: string]: Json };
  switch (e.type) {
    case "session.start":
      return `session.start  runtime=${str(p.runtime)} ${str(p.runtimeVersion)}`.trimEnd();
    case "session.end":
      return `session.end    reason=${str(p.reason)}`;
    case "message.user":
      return `user           ${excerpt(str(p.text), 90)}`;
    case "message.assistant": {
      const blocks = Array.isArray(p.blocks) ? (p.blocks as { type?: Json; text?: Json }[]) : [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => str(b.text))
        .join(" ");
      const kinds = blocks.map((b) => str(b.type)).join("+") || "empty";
      return `assistant      [${kinds}] ${excerpt(text, 76)}`;
    }
    case "tool.call":
      return `tool.call      ${str(p.name)} ${excerpt(firstArg(p.input), 70)}`;
    case "tool.result":
      return `tool.result    ${p.isError === true ? "ERROR " : ""}${excerpt(str(p.output), 76)}`;
    case "file.diff": {
      const { added, removed } = diffStat(str(p.diff));
      return `file.diff      ${str(p.kind)} ${str(p.path)} (+${added} -${removed})`;
    }
    case "file.delete":
      return `file.delete    ${str(p.path)}`;
    case "cost": {
      const u = (p.usage ?? {}) as { [k: string]: Json };
      return `cost           ${str(p.model)} in=${num(u.inputTokens)} out=${num(u.outputTokens)} cacheRead=${num(u.cacheReadInputTokens)}`;
    }
  }
}

function firstArg(input: Json | undefined): string {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) return "";
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  const preferred = ["command", "file_path", "pattern", "path", "url", "prompt"];
  const [k, v] = entries.find(([key]) => preferred.includes(key)) ?? entries[0]!;
  return `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`;
}

export function excerpt(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

/**
 * One display line, clipped to `max` with its indentation intact.
 *
 * `excerpt` collapses every run of whitespace into a single space, which is
 * exactly right for squeezing an event into a one-line timeline row and
 * exactly wrong anywhere the leading whitespace *is* the content — a unified
 * diff, or tool input that was pretty-printed on purpose. Use this for text
 * rendered line by line.
 */
export function clipLine(s: string, max: number): string {
  const line = s.endsWith("\r") ? s.slice(0, -1) : s; // CRLF logs render on one line
  return line.length <= max ? line : line.slice(0, max - 1) + "…";
}
