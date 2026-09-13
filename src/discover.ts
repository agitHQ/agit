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
 *  - OpenCode     $XDG_DATA_HOME (default ~/.local/share)/opencode/opencode.db,
 *                 plus opencode-<channel>.db for a non-release channel —
 *                 packages/core/src/global.ts (xdg-basedir) and
 *                 packages/core/src/database/database.ts `path()`. Every
 *                 session lives in that one file.
 *                 Skipped on purpose, per src/config/sessions/artifacts.ts:
 *                 compaction checkpoints (`<id>.checkpoint.<uuid>.jsonl`, which
 *                 carry the same session id and would overwrite the real one),
 *                 trajectory artifacts (`*.trajectory.jsonl`), and archives
 *                 (`*.jsonl.deleted…` / `.reset…` / `.bak…`, which do not end
 *                 in `.jsonl` and so never match).
 *  - Gemini CLI   ~/.gemini/tmp/<project>/chats/session-*.jsonl, a subagent's
 *                 under chats/<parent session id>/<id>.jsonl, and the legacy
 *                 single-document session-*.json — ChatRecordingService in
 *                 packages/core/src/services/chatRecordingService.ts and
 *                 Storage.getProjectTempDir() in packages/core/src/config/
 *                 storage.ts (the global runtime dir is ~/.gemini).
 *  - Kimi Code    $KIMI_SHARE_DIR (default ~/.kimi)/sessions/<md5 of the work
 *                 dir>/<session id>/wire.jsonl, and a subagent's under
 *                 <session id>/subagents/<agent id>/wire.jsonl —
 *                 docs/en/configuration/data-locations.md and
 *                 src/kimi_cli/session.py. context.jsonl beside it is the
 *                 model context, without timestamps, and is not a log.
 *  - Cline        the SDK sessions at $CLINE_DIR (default ~/.cline)/data/
 *                 sessions/<id>/<id>.messages.json (sdk/packages/core/docs/
 *                 messages-contract-v1.md), and the 3.x task directories,
 *                 <globalStorage>/tasks/<taskId>/api_conversation_history.json
 *                 (apps/vscode/src/core/storage/disk.ts), where
 *                 <globalStorage> is $CLINE_DIR/data for the 3.x CLI
 *                 (standalone/vscode-context.ts) and, for the VS Code
 *                 extension, the editor's User/globalStorage/
 *                 saoudrizwan.claude-dev under its user-data directory:
 *                 %APPDATA%/Code on Windows, ~/Library/Application Support/
 *                 Code on macOS, $XDG_CONFIG_HOME (default ~/.config)/Code on
 *                 Linux, per VS Code's own settings docs; Insiders is
 *                 "Code - Insiders" beside it. Other editors that host the
 *                 extension are imported by path.
 *  - pi           $PI_CODING_AGENT_DIR (default ~/.pi/agent)/sessions/
 *                 --<cwd>--/<timestamp>_<session id>.jsonl —
 *                 packages/coding-agent/docs/session-format.md and
 *                 src/config.ts getAgentDir() in badlogic/pi-mono.
 *  - Roo Code     the same task directories under the editor's
 *                 User/globalStorage/rooveterinaryinc.roo-cline
 *                 (src/utils/storage.ts in RooCodeInc/Roo-Code; the
 *                 `customStoragePath` setting can move them, in which case
 *                 they are imported by path). Read by the cline-classic
 *                 adapter, which tells the two dialects apart.
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

/** Gemini CLI: tmp/<project>/chats/<recording>, one level of subagent directories below. */
function scanGeminiCli(tmpRoot: string, out: DiscoveredLog[]): void {
  const recording = (name: string): boolean => name.endsWith(".jsonl") || name.endsWith(".json");
  for (const project of listDir(tmpRoot)) {
    const chats = join(tmpRoot, project, "chats");
    if (!isDir(chats)) continue;
    for (const name of listDir(chats)) {
      const p = join(chats, name);
      if (isDir(p)) {
        for (const inner of listDir(p)) {
          const q = join(p, inner);
          if (recording(inner) && isFile(q)) record("gemini-cli", q, out);
        }
      } else if (recording(name) && isFile(p)) {
        record("gemini-cli", p, out);
      }
    }
  }
}

/** OpenCode: every opencode*.db in its XDG data directory. */
function scanOpenCode(dataDir: string, out: DiscoveredLog[]): void {
  for (const name of listDir(dataDir)) {
    if (!/^opencode(-[A-Za-z0-9._-]+)?\.db$/.test(name)) continue;
    const p = join(dataDir, name);
    if (isFile(p)) record("opencode", p, out);
  }
}

/** xdg-basedir's rule, which OpenCode uses: $XDG_DATA_HOME when set and non-empty, else ~/.local/share. */
function xdgDataDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.XDG_DATA_HOME?.trim();
  return override ? resolve(override) : join(home, ".local", "share");
}

/** Kimi Code: sessions/<work dir hash>/<session id>/wire.jsonl, and each subagent's below it. */
function scanKimiCode(sessionsRoot: string, out: DiscoveredLog[]): void {
  for (const workDir of listDir(sessionsRoot)) {
    const byHash = join(sessionsRoot, workDir);
    if (!isDir(byHash)) continue;
    for (const session of listDir(byHash)) {
      const dir = join(byHash, session);
      const wire = join(dir, "wire.jsonl");
      if (isFile(wire)) record("kimi-code", wire, out);
      const subagents = join(dir, "subagents");
      if (!isDir(subagents)) continue;
      for (const agent of listDir(subagents)) {
        const sub = join(subagents, agent, "wire.jsonl");
        if (isFile(sub)) record("kimi-code", sub, out);
      }
    }
  }
}

/** pi sessions: sessions/--<cwd>--/<timestamp>_<id>.jsonl. */
function scanPi(sessionsRoot: string, out: DiscoveredLog[]): void {
  for (const project of listDir(sessionsRoot)) {
    const dir = join(sessionsRoot, project);
    if (!isDir(dir)) continue;
    for (const name of listDir(dir)) {
      if (name.endsWith(".jsonl") && isFile(join(dir, name))) record("pi", join(dir, name), out);
    }
  }
}

/** The agent dir pi itself would use: the env override, else ~/.pi/agent. */
function piAgentDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? resolve(override) : join(home, ".pi", "agent");
}

/** Cline SDK sessions: data/sessions/<id>/<id>.messages.json. */
function scanClineSdk(sessionsRoot: string, out: DiscoveredLog[]): void {
  for (const id of listDir(sessionsRoot)) {
    const dir = join(sessionsRoot, id);
    if (!isDir(dir)) continue;
    for (const name of listDir(dir)) {
      if (name.endsWith(".messages.json") && isFile(join(dir, name)))
        record("cline-sdk", join(dir, name), out);
    }
  }
}

/** Cline 3.x (and Roo Code) task directories: tasks/<taskId>/api_conversation_history.json. */
function scanClineClassic(tasksRoot: string, out: DiscoveredLog[], runtime = "cline-classic"): void {
  for (const taskId of listDir(tasksRoot)) {
    const transcript = join(tasksRoot, taskId, "api_conversation_history.json");
    if (isFile(transcript)) record(runtime, transcript, out);
  }
}

/** The dir Cline's own CLI would use: the env override, else ~/.cline. */
function clineDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLINE_DIR?.trim();
  return override ? resolve(override) : join(home, ".cline");
}

/**
 * VS Code's user-data directory per platform (settings docs, "User settings
 * file locations"), for the editors named; `%APPDATA%` and `$XDG_CONFIG_HOME`
 * are honoured the way VS Code honours them.
 */
function vscodeUserDataDirs(home: string, env: NodeJS.ProcessEnv, platform: string): string[] {
  const base =
    platform === "win32"
      ? env.APPDATA?.trim() || join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return ["Code", "Code - Insiders"].map((editor) => join(base, editor));
}

/** The share dir Kimi Code itself would use: the env override, else ~/.kimi. */
function kimiShareDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.KIMI_SHARE_DIR?.trim();
  return override ? resolve(override) : join(home, ".kimi");
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

export function discoverSessionLogs(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Discovery {
  const cline = clineDir(home, env);
  const targets: { runtime: string; dir: string; scan: (dir: string, out: DiscoveredLog[]) => void }[] = [
    { runtime: "claude-code", dir: join(home, ".claude", "projects"), scan: scanClaudeCode },
    { runtime: "codex", dir: join(home, ".codex", "sessions"), scan: (d, o) => scanCodex(d, o) },
    { runtime: "openclaw", dir: join(openClawStateDir(home, env), "agents"), scan: scanOpenClaw },
    { runtime: "gemini-cli", dir: join(home, ".gemini", "tmp"), scan: scanGeminiCli },
    { runtime: "opencode", dir: join(xdgDataDir(home, env), "opencode"), scan: scanOpenCode },
    { runtime: "kimi-code", dir: join(kimiShareDir(home, env), "sessions"), scan: scanKimiCode },
    { runtime: "pi", dir: join(piAgentDir(home, env), "sessions"), scan: scanPi },
    { runtime: "cline-sdk", dir: join(cline, "data", "sessions"), scan: scanClineSdk },
    { runtime: "cline-classic", dir: join(cline, "data", "tasks"), scan: scanClineClassic },
    ...vscodeUserDataDirs(home, env, platform).map((userData) => ({
      runtime: "cline-classic",
      dir: join(userData, "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"),
      scan: scanClineClassic,
    })),
    ...vscodeUserDataDirs(home, env, platform).map((userData) => ({
      runtime: "roo-code",
      dir: join(userData, "User", "globalStorage", "rooveterinaryinc.roo-cline", "tasks"),
      scan: (dir: string, out: DiscoveredLog[]) => scanClineClassic(dir, out, "roo-code"),
    })),
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
