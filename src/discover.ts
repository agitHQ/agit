/**
 * Where the supported runtimes keep their session logs, so `agit import
 * --all` can find them without the user hunting for a path (issue #60).
 *
 * Every location here was read from the runtime's own source or docs, not
 * guessed, and the adapter's `detect()` still has the final say on each file:
 *
 *  - Claude Code  ~/.claude/projects/<project>/<session>.jsonl
 *  - Codex        ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
 *  - OpenClaw     $OPENCLAW_STATE_DIR (default ~/.openclaw)/agents/<id>/sessions/<session>.jsonl
 *                 — src/config/state-dir.ts and src/config/sessions/paths.ts —
 *                 and the agent database beside it,
 *                 agents/<id>/agent/openclaw-agent.sqlite
 *                 (src/state/openclaw-agent-db.paths.ts), which holds every
 *                 session's transcript rows and is where newer OpenClaw
 *                 versions keep them; the incognito database beside it is
 *                 process-held and deliberately not read.
 *                 Skipped on purpose, per src/config/sessions/artifacts.ts:
 *                 compaction checkpoints (`<id>.checkpoint.<uuid>.jsonl`, which
 *                 carry the same session id and would overwrite the real one),
 *                 trajectory artifacts (`*.trajectory.jsonl`), and archives
 *                 (`*.jsonl.deleted…` / `.reset…` / `.bak…`, which do not end
 *                 in `.jsonl` and so never match).
 *
 * Discovery is a directory listing, nothing more: no daemon, no hooks, no
 * state of its own. Retroactive import stays the default — a log written
 * months ago is found the same way as one written a minute ago.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DiscoveredLog {
  runtime: string;
  path: string;
  mtimeMs: number;
  bytes: number;
}

export interface ScanRoot {
  runtime: string;
  dir: string;
  exists: boolean;
  found: number;
}

const OPENCLAW_CHECKPOINT =
  /^.+\.checkpoint\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function record(runtime: string, path: string, out: DiscoveredLog[]): void {
  const st = statSync(path);
  out.push({ runtime, path, mtimeMs: st.mtimeMs, bytes: st.size });
}

/** Claude Code: one JSONL per session, directly under each project directory. */
function scanClaudeCode(root: string, out: DiscoveredLog[]): void {
  for (const project of listDir(root)) {
    const dir = join(root, project);
    if (!isDir(dir)) continue;
    for (const name of listDir(dir)) {
      const p = join(dir, name);
      if (name.endsWith(".jsonl") && isFile(p)) record("claude-code", p, out);
    }
  }
}

/** Codex: rollout-*.jsonl under a yyyy/mm/dd tree; walked a little deeper than that in case the layout shifts. */
function scanCodex(root: string, out: DiscoveredLog[], depth = 0): void {
  if (depth > 4) return;
  for (const name of listDir(root)) {
    const p = join(root, name);
    if (isDir(p)) scanCodex(p, out, depth + 1);
    else if (/^rollout-.*\.jsonl$/.test(name) && isFile(p)) record("codex", p, out);
  }
}

/**
 * OpenClaw: agents/<id>/sessions/<session>.jsonl, minus the artifacts that
 * share a session's id, plus agents/<id>/agent/openclaw-agent.sqlite.
 */
function scanOpenClaw(agentsRoot: string, out: DiscoveredLog[]): void {
  for (const agent of listDir(agentsRoot)) {
    const db = join(agentsRoot, agent, "agent", "openclaw-agent.sqlite");
    if (isFile(db)) record("openclaw", db, out);
    const sessions = join(agentsRoot, agent, "sessions");
    if (!isDir(sessions)) continue;
    for (const name of listDir(sessions)) {
      if (!name.endsWith(".jsonl")) continue;
      if (name.endsWith(".trajectory.jsonl") || OPENCLAW_CHECKPOINT.test(name)) continue;
      const p = join(sessions, name);
      if (isFile(p)) record("openclaw", p, out);
    }
  }
}

/** The state dir OpenClaw itself would use: the env override, else ~/.openclaw. */
function openClawStateDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return override.startsWith("~/") || override === "~"
      ? resolve(home, override.slice(2))
      : resolve(override);
  }
  return join(home, ".openclaw");
}

export interface Discovery {
  /** Oldest first, then by path — a stable order for output and for import. */
  logs: DiscoveredLog[];
  roots: ScanRoot[];
}

export function discoverSessionLogs(home: string, env: NodeJS.ProcessEnv = process.env): Discovery {
  const targets: { runtime: string; dir: string; scan: (dir: string, out: DiscoveredLog[]) => void }[] = [
    { runtime: "claude-code", dir: join(home, ".claude", "projects"), scan: scanClaudeCode },
    { runtime: "codex", dir: join(home, ".codex", "sessions"), scan: (d, o) => scanCodex(d, o) },
    { runtime: "openclaw", dir: join(openClawStateDir(home, env), "agents"), scan: scanOpenClaw },
  ];
  const logs: DiscoveredLog[] = [];
  const roots: ScanRoot[] = [];
  for (const t of targets) {
    const exists = existsSync(t.dir) && isDir(t.dir);
    const before = logs.length;
    if (exists) t.scan(t.dir, logs);
    roots.push({ runtime: t.runtime, dir: t.dir, exists, found: logs.length - before });
  }
  logs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return { logs, roots };
}

/** `7d`, `24h`, `30m` → milliseconds; anything else is the caller's error. */
export function parseSince(text: string): number | null {
  const m = /^(\d+)([dhm])$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
  return n * unit;
}
