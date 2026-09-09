#!/usr/bin/env node
/** agit — git for running agents. Local verbs only (roadmap milestone 1). */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { openclawAdapter } from "./adapters/openclaw.js";
import type { Adapter } from "./adapters/adapter.js";
import { buildChain, sha256Hex, toJsonl } from "./format/hash.js";
import { verifyChain } from "./format/verify.js";
import { SCHEMA_VERSION, type AgitEvent, type SessionMeta } from "./format/events.js";
import { writeFork } from "./fork.js";
import { renderSessionHtml } from "./html.js";
import { diffSessions, renderDiff, treeOnDisk } from "./diff.js";
import { discoverSessionLogs, parseSince } from "./discover.js";
import { buildMatcher, grepEvents, GrepPatternError, renderHit } from "./grep.js";
import { mergeFork, readForkInfo } from "./merge.js";
import { redactDeep, type RedactionCounts } from "./redact.js";
import { startRelay } from "./relay/relay.js";
import {
  createShare,
  endShare,
  getShareHead,
  openInbox,
  pushEvents,
  SessionFollower,
  StabilityError,
  type ShareInfo,
} from "./share.js";
import {
  assertSafeSessionId,
  deleteShareState,
  listSessionIds,
  readSessionEvents,
  readSessionLines,
  readSessionMeta,
  resolveSessionId,
  resolveShareState,
  sessionDir,
  type ShareState,
  writeSession,
  writeShareState,
} from "./store.js";
import { clipLine, fileStateAt, timelineLines, usageByModel, usageTotals } from "./state.js";

const ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter, openclawAdapter];
const DEFAULT_RELAY = process.env.AGIT_RELAY ?? "http://127.0.0.1:7717";

const USAGE = `agit — git for running agents

usage:
  agit import <session | bundle>       ingest a native session into .agit/, or
                                       adopt an agit log or pr bundle as-is
  agit import --all [--since 7d]       find every session the supported runtimes
                                       have written and import what is new
  agit import --latest                 import the most recently written session
  agit ls                              list imported sessions
  agit show <id> [--by-model]          summarize one session; --by-model splits
                                       cost and file edits per model
  agit verify <id | events.jsonl>      validate the hash chain — of a stored
                                       session, or any log file (pr bundles,
                                       downloaded share logs)
  agit replay <id> [--at N] [--state]  step through events; --at jumps to N,
                                       --state prints file state at that point
  agit replay <id> --timeline          print the whole timeline, one line per event
  agit grep <pattern> [--type T]       search every imported session; --path
        [--path] [--regex] [-i|-s]     matches file.diff paths only
  agit export <id> [--json]            write the event log to stdout — JSONL, or a
                                       JSON array with --json — for other tools
  agit export-html <id> [--out FILE]   write a self-contained, offline HTML session viewer
  agit fork <id> --at N [--out DIR]    branch at event N: reconstruct the file tree
                                       (hash-verified) and write a context seed
  agit diff <a> <b> | <fork-dir>       compare two sessions, or a fork against
                                       its parent from the fork point
  agit merge <fork-dir> [--into DIR]   three-way merge a fork's files back
                                       (base = fork point), via git merge-file
  agit pr <id> [--at N] [--out DIR]    handoff bundle for a colleague: log +
                                       meta + verified tree + context seed
  agit share <id | native.jsonl>       share a session through a relay — live if it
                                       is still running; viewer messages land here
  agit share --resume <share-id>       resume a live share after a crash (relay
                                       keeps the buffer; only the tail is pushed)
  agit relay                           run a relay (self-hosted, in-memory)

options:
  --dir <path>     where .agit/ lives (default: current directory)
  --out <dir>      fork/pr: where to write the fork or bundle
  --into <dir>     merge: target directory (default: current directory)
  --summary <txt>  merge: what the fork learned, recorded in merge.json
  --since <dur>    import --all: only logs modified within 7d / 24h / 30m
  --type <t>       grep: only this event type (tool.call, file.diff, ...)
  --path           grep: match file.diff paths instead of rendered lines
  --regex          grep: treat the pattern as a regular expression
  -s               grep: case-sensitive (default is insensitive)
  --relay <url>    relay to share through (default: $AGIT_RELAY or http://127.0.0.1:7717)
  --ttl <hours>    how long the share link lives (default 24h, max 168h)
  --static         share the log as it is now; do not tail for growth
  --port <n>       relay: port to listen on (default 7717)
  --host <addr>    relay: address to bind (default 127.0.0.1; 0.0.0.0 exposes it)
  --trusted-proxy <addr>  relay: trust X-Forwarded-For from this proxy (repeatable)

<id> accepts any unique prefix. See SPEC.md for the format, PROTOCOL.md for the relay.`;

interface Opts {
  dir: string;
  at?: number;
  timeline: boolean;
  state: boolean;
  byModel: boolean;
  all: boolean;
  latest: boolean;
  since?: number;
  json: boolean;
  grepType?: string;
  grepPath: boolean;
  grepRegex: boolean;
  caseSensitive: boolean;
  out?: string;
  into?: string;
  summary?: string;
  relay: string;
  ttlHours?: number;
  static: boolean;
  resume: boolean;
  port?: number;
  host?: string;
  trustedProxies: string[];
  args: string[];
}

function parseArgs(argv: string[]): { verb: string; opts: Opts } {
  const opts: Opts = {
    dir: process.cwd(),
    timeline: false,
    state: false,
    byModel: false,
    all: false,
    latest: false,
    json: false,
    grepPath: false,
    grepRegex: false,
    caseSensitive: false,
    relay: DEFAULT_RELAY,
    static: false,
    resume: false,
    trustedProxies: [],
    args: [],
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dir") opts.dir = resolve(argv[++i] ?? ".");
    else if (a === "--at") opts.at = Number(argv[++i]);
    else if (a === "--timeline") opts.timeline = true;
    else if (a === "--state") opts.state = true;
    else if (a === "--by-model") opts.byModel = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--latest") opts.latest = true;
    else if (a === "--since") {
      const ms = parseSince(argv[++i] ?? "");
      if (ms === null) {
        console.error("--since takes a duration like 7d, 24h or 30m");
        process.exit(2);
      }
      opts.since = ms;
    } else if (a === "--type") opts.grepType = argv[++i];
    else if (a === "--path") opts.grepPath = true;
    else if (a === "--regex") opts.grepRegex = true;
    else if (a === "-s") opts.caseSensitive = true;
    else if (a === "-i") opts.caseSensitive = false;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--into") opts.into = argv[++i];
    else if (a === "--summary") opts.summary = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--relay") opts.relay = argv[++i] ?? opts.relay;
    else if (a === "--ttl") opts.ttlHours = Number(argv[++i]);
    else if (a === "--static") opts.static = true;
    else if (a === "--resume") opts.resume = true;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--host") opts.host = argv[++i];
    else if (a === "--trusted-proxy") opts.trustedProxies.push(argv[++i] ?? "");
    else if (a === "--help" || a === "-h") rest.unshift("help");
    else rest.push(a);
  }
  const verb = rest.shift() ?? "help";
  opts.args = rest;
  return { verb, opts };
}

async function main(): Promise<number> {
  const { verb, opts } = parseArgs(process.argv.slice(2));
  switch (verb) {
    case "import":
      return cmdImport(opts);
    case "ls":
      return cmdLs(opts);
    case "show":
      return cmdShow(opts);
    case "verify":
      return cmdVerify(opts);
    case "replay":
      return cmdReplay(opts);
    case "grep":
      return cmdGrep(opts);
    case "export":
      return cmdExport(opts);
    case "export-html":
      return cmdExportHtml(opts);
    case "fork":
      return cmdFork(opts);
    case "diff":
      return cmdDiff(opts);
    case "merge":
      return cmdMerge(opts);
    case "pr":
      return cmdPr(opts);
    case "share":
      return cmdShare(opts);
    case "relay":
      return cmdRelay(opts);
    case "help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${verb}\n`);
      console.log(USAGE);
      return 2;
  }
}

/** Read a native log, tolerating a UTF-8 BOM (editors add them on re-save). */
function readNativeLog(path: string): string {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

/**
 * Does this look like an agit event log rather than a runtime's native one?
 * The first event of a chain is unmistakable — schema version, seq 0, a known
 * type, a session id and a hash — and no native format carries that shape.
 */
function looksLikeAgitLog(lines: string[]): boolean {
  const first = lines.find((l) => l.trim() !== "");
  if (first === undefined) return false;
  let o: unknown;
  try {
    o = JSON.parse(first);
  } catch {
    return false;
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
  const e = o as Record<string, unknown>;
  return (
    e.v === SCHEMA_VERSION &&
    e.seq === 0 &&
    typeof e.session === "string" &&
    typeof e.hash === "string" &&
    typeof e.type === "string"
  );
}

/**
 * The gate every verb that publishes or hands off a stored session goes
 * through. A chain that does not recompute is refused outright, and the
 * refusal says which check failed and at which event. Verification is the
 * claim this tool makes; a silent pass-through here would be the one bug
 * that undoes all of it.
 */
function refuseUnlessVerified(opts: Opts, id: string, verb: string, consequence: string): boolean {
  const meta = readSessionMeta(opts.dir, id);
  const check = verifyChain(readSessionLines(opts.dir, id), meta ?? undefined);
  if (check.ok) return true;
  const why = check.firstBroken
    ? `event ${check.firstBroken.seq}: ${check.firstBroken.reason}`
    : "chain does not verify";
  console.error(`refusing to ${verb}: chain verification failed — ${why}`);
  console.error(
    `  ${check.events} event${check.events === 1 ? "" : "s"} verified before the break; ${consequence}. Run: agit verify ${id.slice(0, 8)}`,
  );
  return false;
}

interface ImportOutcome {
  status: "imported" | "updated" | "unchanged" | "unrecognized";
  id?: string;
  adapter?: Adapter;
  events?: number;
  previousEvents?: number;
  records?: number;
  skipped?: Record<string, number>;
  redactions?: RedactionCounts;
  headHash?: string;
}

/**
 * sha256 of every stored session's source file: the cheap, exact way to know
 * a log is already in the store. Import is deterministic, so a matching hash
 * means byte-identical output and nothing to do.
 */
function knownSources(dir: string): Map<string, string> {
  const known = new Map<string, string>();
  for (const id of listSessionIds(dir)) {
    const meta = readSessionMeta(dir, id);
    if (meta?.source?.sha256) known.set(meta.source.sha256, id);
  }
  return known;
}

/** Convert one native log into the store. Prints nothing; callers decide how much to say. */
function importNativeLog(
  opts: Opts,
  path: string,
  raw: string,
  lines: string[],
  known: Map<string, string>,
): ImportOutcome {
  const sha256 = sha256Hex(raw);
  const knownId = known.get(sha256);
  if (knownId !== undefined) return { status: "unchanged", id: knownId };

  const adapter = ADAPTERS.find((a) => a.detect(lines));
  if (!adapter) return { status: "unrecognized" };

  const converted = adapter.convert(lines);
  const redactions: RedactionCounts = {};
  for (const d of converted.drafts) d.payload = redactDeep(d.payload, redactions);
  const events = buildChain(converted.sessionId, converted.drafts);
  // Same id already stored means the source grew (a resumed session) or changed.
  const previous = listSessionIds(opts.dir).includes(converted.sessionId)
    ? readSessionMeta(opts.dir, converted.sessionId)
    : null;

  const meta: SessionMeta = {
    agitSchema: 1,
    sessionId: converted.sessionId,
    adapter: { name: adapter.name, version: adapter.version },
    importedAt: new Date().toISOString(),
    source: { path, sha256, bytes: statSync(path).size, records: converted.records },
    skipped: converted.skipped,
    redactions,
    eventCount: events.length,
    headHash: events[events.length - 1]!.hash,
  };
  writeSession(opts.dir, converted.sessionId, toJsonl(events), meta);
  known.set(sha256, converted.sessionId);
  return {
    status: previous ? "updated" : "imported",
    id: converted.sessionId,
    adapter,
    events: events.length,
    previousEvents: previous?.eventCount,
    records: converted.records,
    skipped: converted.skipped,
    redactions,
    headHash: meta.headHash,
  };
}

/** The full report for one import — what `agit import <file>` has always printed. */
function printImportReport(opts: Opts, outcome: ImportOutcome): number {
  if (outcome.status === "unrecognized") {
    console.error(
      "no adapter recognizes this file (adapters available: " + ADAPTERS.map((a) => a.name).join(", ") + ")",
    );
    return 1;
  }
  if (outcome.status === "unchanged") {
    console.log(`unchanged ${outcome.id} — already imported from this file; nothing to do`);
    return 0;
  }
  const id = outcome.id!;
  const adapter = outcome.adapter!;
  const skipped = outcome.skipped ?? {};
  const redactions = outcome.redactions ?? {};
  console.log(`${outcome.status} ${id}`);
  console.log(`  adapter     ${adapter.name}@${adapter.version}`);
  console.log(
    outcome.status === "updated"
      ? `  events      ${outcome.previousEvents} → ${outcome.events} (from ${outcome.records} native records)`
      : `  events      ${outcome.events} (from ${outcome.records} native records)`,
  );
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) {
    const detail = Object.entries(skipped)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    console.log(`  skipped     ${skippedTotal} native records with no mapping: ${detail}`);
  }
  const redactedTotal = Object.values(redactions).reduce((a, b) => a + b, 0);
  console.log(
    redactedTotal > 0
      ? `  redacted    ${redactedTotal}: ${Object.entries(redactions)
          .map(([k, v]) => `${k}×${v}`)
          .join(", ")}`
      : `  redacted    nothing matched the credential patterns (SPEC §8 — a seatbelt, not a guarantee)`,
  );
  console.log(`  head        ${outcome.headHash!.slice(0, 12)}`);
  console.log(`  wrote       ${sessionDir(opts.dir, id)}`);
  return 0;
}

function cmdImport(opts: Opts): number {
  if (opts.all || opts.latest || opts.since !== undefined) return cmdImportDiscovered(opts);
  const src = opts.args[0];
  if (!src) {
    console.error(
      "usage: agit import <native-session.jsonl | agit-bundle>   |   agit import --all | --latest",
    );
    return 2;
  }
  return importPath(opts, resolve(src));
}

/** One path: a pr bundle directory, an agit log, or a native session log. */
function importPath(opts: Opts, target: string): number {
  let path = target;
  if (!existsSync(path)) {
    console.error(`no such file: ${path}`);
    return 1;
  }
  // `agit pr` writes a directory; accept it as directly as a file.
  if (statSync(path).isDirectory()) {
    const inner = join(path, "events.jsonl");
    if (!existsSync(inner)) {
      console.error(`${path} is a directory with no events.jsonl in it`);
      return 1;
    }
    path = inner;
  }
  const raw = readNativeLog(path);
  const lines = raw.split("\n").filter((l) => l.trim() !== "");

  // Adoption gets the unfiltered text: dropping blank lines first would both
  // hide the "blank line inside log" break from verifyChain and quietly
  // rewrite a log this path promises to store byte for byte.
  if (looksLikeAgitLog(lines)) return adoptBundle(opts, path, raw);

  return printImportReport(opts, importNativeLog(opts, path, raw, lines, knownSources(opts.dir)));
}

function ago(mtimeMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * `agit import --all` / `--latest`: find the supported runtimes' logs where
 * they write them and import what is new. A directory listing plus the
 * ordinary import — no daemon, no hooks. Retroactive by default: a log from
 * months ago is found the same way as one from a minute ago.
 */
function cmdImportDiscovered(opts: Opts): number {
  const { logs, roots } = discoverSessionLogs(homedir());
  console.log("scanned");
  for (const r of roots) {
    const found = r.exists ? `${r.found} log${r.found === 1 ? "" : "s"}` : "not found";
    console.log(`  ${r.runtime.padEnd(12)} ${r.dir}  (${found})`);
  }
  if (logs.length === 0) {
    console.error(
      "\nno session logs found in any of those directories — is a supported runtime installed here?",
    );
    return 1;
  }
  const cutoff = opts.since !== undefined ? Date.now() - opts.since : null;
  const candidates = cutoff === null ? logs : logs.filter((l) => l.mtimeMs >= cutoff);
  if (candidates.length === 0) {
    console.log(
      `\nnothing modified within the --since window (${logs.length} older log${logs.length === 1 ? "" : "s"} left alone)`,
    );
    return 0;
  }

  if (opts.latest) {
    // Newest first, skipping anything no adapter claims — a runtime's
    // directory holds more than session logs — so "latest" means the latest
    // session, not the newest file.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const log = candidates[i]!;
      const lines = readNativeLog(log.path)
        .split("\n")
        .filter((l) => l.trim() !== "");
      if (!ADAPTERS.some((a) => a.detect(lines))) {
        console.log(`  skipped    ${log.path}: no adapter recognizes this file`);
        continue;
      }
      console.log(`\nlatest: ${log.path}  (${log.runtime}, modified ${ago(log.mtimeMs)})\n`);
      return importPath(opts, log.path);
    }
    console.error("\nnone of the logs found is recognized by an adapter");
    return 1;
  }

  const known = knownSources(opts.dir);
  const tally = { imported: 0, updated: 0, unchanged: 0, unrecognized: 0, failed: 0 };
  console.log("");
  for (const log of candidates) {
    let outcome: ImportOutcome;
    try {
      const raw = readNativeLog(log.path);
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      outcome = looksLikeAgitLog(lines)
        ? { status: "unrecognized" }
        : importNativeLog(opts, log.path, raw, lines, known);
    } catch (err) {
      tally.failed++;
      console.log(`  failed     ${log.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    tally[outcome.status]++;
    const id = (outcome.id ?? "").slice(0, 20).padEnd(20);
    if (outcome.status === "imported") {
      console.log(
        `  imported   ${id} ${log.runtime.padEnd(12)} ${String(outcome.events).padStart(6)} events   ${log.path}`,
      );
    } else if (outcome.status === "updated") {
      console.log(
        `  updated    ${id} ${log.runtime.padEnd(12)} ${outcome.previousEvents} → ${outcome.events} events   ${log.path}`,
      );
    } else if (outcome.status === "unrecognized") {
      console.log(`  skipped    ${log.path}: no adapter recognizes this file`);
    }
  }
  const total = listSessionIds(opts.dir).length;
  console.log(
    `\n${tally.imported} imported, ${tally.updated} updated, ${tally.unchanged} unchanged, ${tally.unrecognized} skipped, ${tally.failed} failed — ${total} session${total === 1 ? "" : "s"} in ${join(opts.dir, ".agit")}`,
  );
  return tally.failed > 0 ? 1 : 0;
}

/**
 * Adopt an already-normalized agit log (a `pr` bundle, a downloaded share
 * log) into the local store — the receiving half of `agit pr`.
 *
 * Nothing here rewrites history: the events are stored byte for byte, so
 * their hashes stay the ones the origin published. The chain is verified
 * first and a broken or tampered log is refused outright; redaction is NOT
 * re-run, because re-scanning would change bytes and invalidate every hash
 * downstream — the log carries whatever the origin decided to publish.
 */
function adoptBundle(opts: Opts, path: string, raw: string): number {
  // Split, do not filter: verifyChain tolerates exactly one trailing empty
  // element (the final newline) and treats any other blank as a break.
  const lines = raw.split("\n");
  // A sibling meta.json is the origin's own account of the import. It is kept
  // verbatim when present (it truthfully describes where the log came from)
  // and never invented when absent.
  const metaPath = join(dirname(path), "meta.json");
  let meta: SessionMeta | undefined;
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
    } catch {
      console.error(`${metaPath} is not readable JSON — remove it or fix it; the log itself may be fine`);
      return 1;
    }
  }

  const res = verifyChain(lines, meta);
  if (!res.ok) {
    const b = res.firstBroken;
    console.error(`refusing to adopt: ${b ? `event ${b.seq}: ${b.reason}` : "chain verification failed"}`);
    console.error(`${res.events} events verified before the break`);
    return 1;
  }

  const first = JSON.parse(lines[0]!) as AgitEvent;
  const id = first.session;
  for (let i = 1; i < res.events; i++) {
    const event = JSON.parse(lines[i]!) as AgitEvent;
    if (event.session !== id) {
      console.error(
        `refusing to adopt: mixed session ids (event ${event.seq} belongs to ${event.session}, expected ${id})`,
      );
      return 1;
    }
  }
  try {
    assertSafeSessionId(id);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (meta && meta.sessionId !== id) {
    console.error(`refusing to adopt: meta.json says session ${meta.sessionId}, the log says ${id}`);
    return 1;
  }

  const jsonl = raw; // byte for byte, exactly as the origin published it
  if (listSessionIds(opts.dir).includes(id)) {
    // Re-adopting the same bundle is a no-op; a different log under the same
    // id is someone else's session and is never overwritten.
    const existing = readFileSync(join(sessionDir(opts.dir, id), "events.jsonl"), "utf8");
    if (existing === jsonl) {
      console.log(`already adopted ${id} (identical log; nothing to do)`);
      return 0;
    }
    console.error(`refusing to adopt: session ${id} already exists here with different content`);
    return 1;
  }
  writeSession(opts.dir, id, jsonl, meta);

  const head = [...lines].reverse().find((l) => l.trim() !== "")!;
  console.log(`adopted ${id}`);
  console.log(`  events      ${res.events}, chain intact${meta ? ", matches meta.json head" : ""}`);
  if (meta) {
    console.log(`  origin      ${meta.adapter.name}@${meta.adapter.version}, imported ${meta.importedAt}`);
    const redacted = Object.entries(meta.redactions);
    if (redacted.length > 0) {
      console.log(
        `  redactions  ${redacted.map(([k, v]) => `${k}×${v}`).join(", ")} (applied at the origin; agit did not re-scan)`,
      );
    }
  } else {
    console.log("  meta        none in the bundle — truncation is not checkable for this session");
  }
  console.log(`  head        ${(JSON.parse(head) as AgitEvent).hash.slice(0, 12)}`);
  console.log(`  wrote       ${sessionDir(opts.dir, id)}`);
  return 0;
}

function cmdLs(opts: Opts): number {
  const ids = listSessionIds(opts.dir);
  if (ids.length === 0) {
    if (opts.json) {
      console.log("[]");
    } else {
      console.log("no sessions imported yet (agit import <file>)");
    }
    return 0;
  }
  const rows = ids.map((id) => {
    // One corrupt session must not take down the whole listing.
    let events;
    try {
      events = readSessionEvents(opts.dir, id);
      if (events.length === 0) throw new Error("empty log");
    } catch {
      return {
        id: id.slice(0, 8),
        started: "(corrupt — run `agit verify " + id.slice(0, 8) + "`)",
        dur: "",
        events: "",
        files: "",
        runtime: "",
      };
    }
    const first = events[0]!;
    const last = events[events.length - 1]!;
    const files = fileStateAt(events).size;
    const start = (first.payload as { runtime?: unknown }).runtime;
    return {
      id: id.slice(0, 8),
      started: first.ts.slice(0, 16).replace("T", " "),
      dur: humanDuration(Date.parse(last.ts) - Date.parse(first.ts)),
      events: String(events.length),
      files: String(files),
      runtime: typeof start === "string" ? start : "?",
    };
  });
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const cols = ["id", "started", "dur", "events", "files", "runtime"] as const;
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c].length)));
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(widths[i]!)).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => r[c].padEnd(widths[i]!)).join("  "));
  console.log("(files = lower bound: structured edits only — shell-driven changes are not tracked)");
  return 0;
}

function cmdShow(opts: Opts): number {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);
  const meta = readSessionMeta(opts.dir, id);
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const start = first.payload as { [k: string]: unknown };

  if (opts.json) {
    if (opts.byModel) {
      const rows = usageByModel(events);
      const jsonRows = rows.map((r) => ({
        ...r,
        files: [...r.files],
      }));
      console.log(JSON.stringify(jsonRows, null, 2));
      return 0;
    }
    const byTypeMap = new Map<string, number>();
    const toolsMap = new Map<string, number>();
    for (const e of events) {
      byTypeMap.set(e.type, (byTypeMap.get(e.type) ?? 0) + 1);
      if (e.type === "tool.call") {
        const name = (e.payload as { name?: unknown }).name;
        if (typeof name === "string") toolsMap.set(name, (toolsMap.get(name) ?? 0) + 1);
      }
    }
    const u = usageTotals(events);
    const filesMap = fileStateAt(events);
    const summary = {
      id,
      runtime: typeof start.runtime === "string" ? start.runtime : undefined,
      runtimeVersion: typeof start.runtimeVersion === "string" ? start.runtimeVersion : undefined,
      cwd: typeof start.cwd === "string" ? start.cwd : undefined,
      branch: typeof start.gitBranch === "string" && start.gitBranch ? start.gitBranch : undefined,
      started: first.ts,
      durationMs: Date.parse(last.ts) - Date.parse(first.ts),
      importedAt: meta?.importedAt,
      adapter: meta?.adapter,
      events: events.length,
      byType: Object.fromEntries(byTypeMap),
      tools: Object.fromEntries(toolsMap),
      usage: {
        ...u,
        models: [...u.models],
      },
      files: [...filesMap.values()],
      redactions: meta?.redactions,
    };
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(`session ${id}`);
  console.log(`  runtime     ${start.runtime} ${start.runtimeVersion ?? ""}`.trimEnd());
  if (typeof start.cwd === "string") console.log(`  cwd         ${start.cwd}`);
  if (typeof start.gitBranch === "string" && start.gitBranch) console.log(`  branch      ${start.gitBranch}`);
  console.log(`  started     ${first.ts}`);
  console.log(`  duration    ${humanDuration(Date.parse(last.ts) - Date.parse(first.ts))}`);
  if (meta)
    console.log(`  imported    ${meta.importedAt}  (adapter ${meta.adapter.name}@${meta.adapter.version})`);

  const byType = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    if (e.type === "tool.call") {
      const name = (e.payload as { name?: unknown }).name;
      if (typeof name === "string") tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  console.log(
    `  events      ${events.length}  (${[...byType.entries()].map(([t, n]) => `${t}×${n}`).join(", ")})`,
  );
  if (tools.size > 0) {
    console.log(
      `  tools       ${[...tools.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}×${n}`)
        .join(", ")}`,
    );
  }

  const u = usageTotals(events);
  if (u.apiMessages > 0) {
    console.log(`  models      ${[...u.models].join(", ")}`);
    console.log(
      `  tokens      in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadInputTokens} cacheWrite=${u.cacheCreationInputTokens} (${u.apiMessages} API messages)`,
    );
  }

  if (opts.byModel) {
    printByModel(events);
    return 0;
  }

  const files = fileStateAt(events);
  if (files.size > 0) {
    console.log(
      `  files       >=${files.size} touched — a lower bound: only structured edits are tracked, shell-driven changes are not (SPEC §5.7)`,
    );
    for (const f of files.values()) {
      const diverged =
        f.divergedAtSeq !== undefined
          ? `  [DIVERGED at seq ${f.divergedAtSeq}: content changed outside structured edits]`
          : "";
      console.log(
        `    ${f.kind === "create" ? "A" : "M"} ${f.path}  (+${f.added} -${f.removed}, ${f.edits} edit${f.edits === 1 ? "" : "s"})${diverged}`,
      );
    }
  }
  if (meta && Object.keys(meta.redactions).length > 0) {
    console.log(
      `  redactions  ${Object.entries(meta.redactions)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ")}`,
    );
  }
  return 0;
}

/**
 * What each model cost, and what it changed.
 *
 * Token columns are exact — every cost event names its own model. The files
 * column is an attribution, not a recorded fact: a file.diff carries no model
 * of its own, so an edit is credited to the nearest preceding event that
 * names one. The rule is printed with the table so nobody has to guess how
 * the column was derived.
 */
function printByModel(events: AgitEvent[]): void {
  const rows = usageByModel(events);
  if (rows.length === 0) {
    console.log("\nno cost events in this session — nothing to attribute");
    return;
  }
  const table = rows.map((r) => ({
    model: r.model,
    calls: String(r.apiMessages),
    in: r.inputTokens.toLocaleString("en-US"),
    out: r.outputTokens.toLocaleString("en-US"),
    cacheRead: r.cacheReadInputTokens.toLocaleString("en-US"),
    files: String(r.files.size),
  }));
  const cols = ["model", "calls", "in", "out", "cacheRead", "files"] as const;
  const head = {
    model: "MODEL",
    calls: "CALLS",
    in: "IN",
    out: "OUT",
    cacheRead: "CACHE READ",
    files: "FILES",
  };
  const widths = cols.map((c) => Math.max(head[c].length, ...table.map((r) => r[c].length)));
  const line = (r: Record<string, string>): string =>
    cols.map((c, i) => (c === "model" ? r[c]!.padEnd(widths[i]!) : r[c]!.padStart(widths[i]!))).join("  ");

  console.log("");
  console.log("  " + line(head));
  for (const r of table) console.log("  " + line(r));
  console.log(
    "\n  files = edits credited to the model named by the nearest preceding event;" +
      "\n  tokens are exact, and both are lower bounds wherever the log is (SPEC §5.7).",
  );
}

function cmdVerify(opts: Opts): number {
  // A path to an events.jsonl (a pr bundle, a downloaded share log) verifies
  // directly; otherwise the argument is a store session id.
  let lines: string[];
  let meta: SessionMeta | undefined;
  const arg = opts.args[0];
  if (arg !== undefined && existsSync(resolve(arg)) && statSync(resolve(arg)).isFile()) {
    lines = readFileSync(resolve(arg), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const sibling = join(dirname(resolve(arg)), "meta.json");
    meta = existsSync(sibling) ? (JSON.parse(readFileSync(sibling, "utf8")) as SessionMeta) : undefined;
  } else {
    const id = requireId(opts);
    lines = readSessionLines(opts.dir, id);
    meta = readSessionMeta(opts.dir, id) ?? undefined;
  }
  const res = verifyChain(lines, meta);
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  if (res.ok) {
    console.log(
      `ok: ${res.events} events, chain intact${meta ? ", matches meta.json head" : " (no meta.json — truncation not checkable)"}`,
    );
    return 0;
  }
  console.error(`BROKEN at seq ${res.firstBroken!.seq}: ${res.firstBroken!.reason}`);
  console.error(`${res.events} events verified before the break`);
  return 1;
}

async function cmdReplay(opts: Opts): Promise<number> {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);

  if (opts.timeline || (opts.at === undefined && !process.stdin.isTTY)) {
    for (const line of timelineLines(events)) console.log(line);
    return 0;
  }

  let pos = clamp(opts.at ?? 0, 0, events.length - 1);
  printEventDetail(events, pos);
  if (opts.state) printStateAt(events, pos);
  if (opts.at !== undefined && !process.stdin.isTTY) return 0;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n(${events.length} events — Enter/n next, p prev, g N goto, s state here, q quit)`);
  for (;;) {
    const answer = (await rl.question(`replay ${pos}/${events.length - 1}> `)).trim();
    if (answer === "q") break;
    if (answer === "" || answer === "n") pos = clamp(pos + 1, 0, events.length - 1);
    else if (answer === "p") pos = clamp(pos - 1, 0, events.length - 1);
    else if (answer.startsWith("g")) pos = clamp(Number(answer.slice(1).trim()), 0, events.length - 1);
    else if (answer === "s") {
      printStateAt(events, pos);
      continue;
    } else {
      console.log("Enter/n next, p prev, g N goto, s state, q quit");
      continue;
    }
    printEventDetail(events, pos);
  }
  rl.close();
  return 0;
}

function cmdFork(opts: Opts): number {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);
  if (opts.at === undefined || !Number.isInteger(opts.at)) {
    console.error("usage: agit fork <id> --at N [--out DIR]  (N = event to branch from)");
    return 2;
  }
  if (opts.at < 0 || opts.at >= events.length) {
    console.error(`--at ${opts.at} is outside this session (0..${events.length - 1})`);
    return 2;
  }
  // Never fork an unverified prefix: the fork point hash is a provenance claim.
  if (!refuseUnlessVerified(opts, id, "fork", "nothing was written")) return 1;

  const outDir = resolve(opts.out ?? `agit-fork-${id.slice(0, 8)}-at${opts.at}`);
  if (existsSync(outDir)) {
    console.error(`refusing to write into existing ${outDir} — pass a fresh --out`);
    return 1;
  }
  const res = writeFork(events, opts.at, id, outDir);

  console.log(`forked ${id} at event ${opts.at} (${events[opts.at]!.hash.slice(0, 12)})`);
  const recovered = res.written.filter((w) => w.recovered).length;
  console.log(
    `  tree        ${res.written.length} file${res.written.length === 1 ? "" : "s"} written, every one verified against its event hash` +
      (recovered > 0 ? ` (${recovered} recovered via runtime-recorded pre-edit content)` : ""),
  );
  for (const w of res.written) console.log(`    ${w.rel}${w.recovered ? "  [recovered]" : ""}`);
  if (res.skipped.length > 0) {
    console.log(`  skipped     ${res.skipped.length} not reconstructible:`);
    for (const skip of res.skipped) console.log(`    ${skip.path}: ${skip.reason}`);
  }
  console.log(
    `  seed        ${join(outDir, "SEED.md")} — open your agent in ${join(outDir, "tree")} with this as the first prompt`,
  );
  console.log(`  parentage   ${join(outDir, "fork.json")}`);
  console.log("  (the tree reflects structured edits only; shell-driven changes were invisible to the log)");
  return 0;
}

/**
 * Compare two sessions, or a fork against the parent it came from.
 *
 * A fork directory is the interesting case and needs no ids: fork.json names
 * the source session and the exact event it branched at, so both sides are
 * narrowed to the work done after that point — the comparison is about the
 * two approaches rather than the history they share.
 */
function cmdDiff(opts: Opts): number {
  const first = opts.args[0];
  if (!first) {
    console.error("usage: agit diff <session-a> <session-b>   |   agit diff <fork-dir>");
    return 2;
  }

  // Form 1: a fork directory, compared against its own parent.
  const forkJson = join(resolve(first), "fork.json");
  if (existsSync(forkJson)) {
    const info = readForkInfo(resolve(first));
    let parent: AgitEvent[];
    try {
      parent = readSessionEvents(opts.dir, resolveSessionId(opts.dir, info.sourceSession));
    } catch {
      console.error(
        `source session ${info.sourceSession} is not in this store — import it to compare against the fork.`,
      );
      return 1;
    }
    if (parent[info.atSeq]?.hash !== info.atHash) {
      console.error(
        `fork.json says event ${info.atSeq} is ${info.atHash.slice(0, 12)}, the stored session disagrees`,
      );
      return 1;
    }
    // The fork's own session may or may not have been imported yet. When it
    // has not, compare the fork's written tree against the parent's later
    // work by treating the fork point as the fork side's end.
    const forkIdArg = opts.args[1];
    let forkSide: { events?: AgitEvent[]; label: string; tree?: Map<string, string> };
    if (forkIdArg) {
      const id = resolveSessionId(opts.dir, forkIdArg);
      forkSide = { events: readSessionEvents(opts.dir, id), label: id.slice(0, 8) };
    } else {
      // No session named for the fork, so compare its working tree as it
      // stands on disk — what someone who has been working in it cares
      // about, and the same thing `agit merge` reads.
      forkSide = { tree: treeOnDisk(join(resolve(first), "tree")), label: "fork" };
    }
    const diffResult = diffSessions({
      a: { events: parent, label: info.sourceSession.slice(0, 8) },
      b: forkSide,
      from: { seq: info.atSeq, hash: info.atHash },
    });
    if (opts.json) {
      console.log(JSON.stringify(diffResult, null, 2));
      return 0;
    }
    for (const line of renderDiff(diffResult)) {
      console.log(line);
    }
    return 0;
  }

  // Form 2: two session ids.
  const secondArg = opts.args[1];
  if (!secondArg) {
    console.error("usage: agit diff <session-a> <session-b>   |   agit diff <fork-dir>");
    return 2;
  }
  const idA = resolveSessionId(opts.dir, first);
  const idB = resolveSessionId(opts.dir, secondArg);
  if (idA === idB) {
    console.error("those are the same session");
    return 2;
  }
  const diffResult = diffSessions({
    a: { events: readSessionEvents(opts.dir, idA), label: idA.slice(0, 8) },
    b: { events: readSessionEvents(opts.dir, idB), label: idB.slice(0, 8) },
  });
  if (opts.json) {
    console.log(JSON.stringify(diffResult, null, 2));
    return 0;
  }
  for (const line of renderDiff(diffResult)) {
    console.log(line);
  }
  return 0;
}

function cmdMerge(opts: Opts): number {
  const forkDir = opts.args[0] ? resolve(opts.args[0]) : undefined;
  if (!forkDir || !existsSync(join(forkDir, "fork.json"))) {
    console.error(
      "usage: agit merge <fork-dir> [--into DIR] [--summary TEXT] — fork-dir must contain fork.json",
    );
    return 2;
  }
  const info = readForkInfo(forkDir);
  let events: AgitEvent[];
  try {
    events = readSessionEvents(opts.dir, resolveSessionId(opts.dir, info.sourceSession));
  } catch {
    console.error(
      `source session ${info.sourceSession} is not in this store — the merge base is reconstructed from its log. Import it first.`,
    );
    return 1;
  }
  const intoDir = resolve(opts.into ?? ".");
  const { results, conflicts } = mergeFork({ forkDir, intoDir, sourceEvents: events, summary: opts.summary });

  console.log(`merging fork of ${info.sourceSession} (at event ${info.atSeq}) into ${intoDir}`);
  for (const r of results) console.log(`  ${r.outcome.padEnd(12)} ${r.rel}`);
  console.log(
    conflicts > 0
      ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} — standard markers are in the files; finish by hand.`
      : "clean: no conflicts.",
  );
  console.log(`recorded in ${join(forkDir, "merge.json")}`);
  return conflicts > 0 ? 1 : 0;
}

function cmdPr(opts: Opts): number {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);
  const at = opts.at ?? events.length - 1;
  if (!Number.isInteger(at) || at < 0 || at >= events.length) {
    console.error(`--at ${String(opts.at)} is outside this session (0..${events.length - 1})`);
    return 2;
  }
  if (!refuseUnlessVerified(opts, id, "hand off", "nothing was written")) return 1;
  const outDir = resolve(opts.out ?? `agit-pr-${id.slice(0, 8)}`);
  if (existsSync(outDir)) {
    console.error(`refusing to write into existing ${outDir} — pass a fresh --out`);
    return 1;
  }
  const res = writeFork(events, at, id, outDir);
  // The bundle carries the log itself: the recipient can agit verify it and
  // replay/show/fork it without ever having met this machine.
  writeFileSync(join(outDir, "events.jsonl"), readSessionLines(opts.dir, id).join("\n") + "\n", "utf8");
  const meta = readSessionMeta(opts.dir, id);
  if (meta) writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

  console.log(`handoff bundle for ${id} at event ${at}:`);
  console.log(`  ${outDir}`);
  console.log(`    events.jsonl  the full log — verify with: agit verify ${join(outDir, "events.jsonl")}`);
  console.log(`    tree/         ${res.written.length} reconstructed, hash-verified files`);
  if (res.skipped.length > 0)
    console.log(`                  (${res.skipped.length} not reconstructible — listed in SEED.md)`);
  console.log("    SEED.md       what the session was doing — the recipient's starting prompt");
  console.log("    fork.json     provenance: source session id + fork-point hash");
  console.log("share the directory however you like; nothing in it phones home.");
  return 0;
}

/** The format for everyone else: the log to stdout, no CLI linkage required. */
/**
 * Search every imported session at once.
 *
 * Output is one flat row per hit rather than grouped by session, so the
 * result can be piped into the same tools the user would have reached for
 * anyway. Sessions that fail to parse are reported to stderr and skipped:
 * one corrupt store entry must not hide every other session's matches.
 */
function cmdGrep(opts: Opts): number {
  const pattern = opts.args[0];
  if (pattern === undefined || pattern === "") {
    console.error("usage: agit grep <pattern> [--type <event-type>] [--path] [--regex] [-s]");
    return 2;
  }
  let matches: (s: string) => boolean;
  try {
    matches = buildMatcher(pattern, {
      regex: opts.grepRegex,
      caseSensitive: opts.caseSensitive,
    });
  } catch (err) {
    console.error(err instanceof GrepPatternError ? err.message : String(err));
    return 2;
  }

  const ids = listSessionIds(opts.dir);
  if (ids.length === 0) {
    if (opts.json) {
      // Nothing printed to stdout on empty list when searching
    } else {
      console.log("no sessions imported yet (agit import <file>)");
    }
    return 0;
  }
  const idWidth = 8;
  let total = 0;
  let searched = 0;
  for (const id of ids) {
    let events: AgitEvent[];
    try {
      events = readSessionEvents(opts.dir, id);
    } catch {
      console.error(`skipping ${id.slice(0, idWidth)}: unreadable (agit verify it)`);
      continue;
    }
    searched++;
    for (const hit of grepEvents(id, events, matches, {
      type: opts.grepType,
      path: opts.grepPath,
    })) {
      if (opts.json) {
        console.log(JSON.stringify(hit));
      } else {
        console.log(renderHit(hit, idWidth));
      }
      total++;
    }
  }
  if (total === 0) {
    if (!opts.json) {
      console.error(`no matches in ${searched} session${searched === 1 ? "" : "s"}`);
    }
    return 1;
  }
  return 0;
}

function cmdExport(opts: Opts): number {
  const id = requireId(opts);
  if (!refuseUnlessVerified(opts, id, "export", "nothing was written")) return 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify(readSessionEvents(opts.dir, id), null, 2) + "\n");
  } else {
    // JSONL: the stored log verbatim, hash chain intact — pipe it anywhere.
    for (const line of readSessionLines(opts.dir, id)) process.stdout.write(line + "\n");
  }
  return 0;
}

function cmdExportHtml(opts: Opts): number {
  const id = requireId(opts);
  const meta = readSessionMeta(opts.dir, id);
  if (!refuseUnlessVerified(opts, id, "export", "nothing was written")) return 1;

  const events = readSessionEvents(opts.dir, id);
  const outPath = resolve(opts.out ?? `agit-${id.slice(0, 8)}.html`);

  if (existsSync(outPath)) {
    console.error(`refusing to overwrite existing ${outPath} — pass a fresh --out`);
    return 1;
  }

  const html = renderSessionHtml(events, meta);
  writeFileSync(outPath, html, "utf8");

  console.log(`exported session ${id} to:`);
  console.log(`  ${outPath}`);
  console.log(`  ${events.length} events`);
  console.log("  self-contained HTML — no network or external resources");

  return 0;
}

async function cmdRelay(opts: Opts): Promise<number> {
  let handle;
  try {
    handle = await startRelay({ port: opts.port, host: opts.host, trustedProxies: opts.trustedProxies });
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      console.error(
        `port ${opts.port ?? 7717} is already in use (another relay?) — pass --port <n> to use a different one`,
      );
      return 1;
    }
    throw err;
  }
  const host = opts.host ?? "127.0.0.1";
  console.log(`agit relay listening on http://${host}:${handle.port}`);
  console.log("shares are held in memory only; nothing is written to disk. Ctrl+C to stop.");
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.log(
      "NOTE: bound beyond loopback — anyone who can reach this port can view shares they have links for. Prefer a TLS reverse proxy or tunnel.",
    );
  }
  await waitForSigint();
  await handle.close();
  return 0;
}

async function cmdShare(opts: Opts): Promise<number> {
  if (opts.resume) return cmdShareResume(opts);
  const target = opts.args[0];
  if (!target) {
    console.error("usage: agit share <session-id | native-session.jsonl>   (or --resume <share-id>)");
    return 2;
  }
  const ttlMs =
    opts.ttlHours !== undefined && Number.isFinite(opts.ttlHours) ? opts.ttlHours * 3600_000 : undefined;

  // Resolve what we're sharing: a native log path (live-capable), or an
  // imported session — which is still live-capable when its source file exists.
  let nativePath: string | null = null;
  let staticEvents: AgitEvent[] | null = null;
  if (existsSync(resolve(target)) && !listSessionIds(opts.dir).includes(target)) {
    nativePath = resolve(target);
  } else {
    const id = resolveSessionId(opts.dir, target);
    const meta = readSessionMeta(opts.dir, id);
    if (!opts.static && meta && existsSync(meta.source.path)) {
      nativePath = meta.source.path;
    } else {
      // This is the path that publishes the stored chain itself, so it is
      // the one that must never publish a chain that does not verify.
      if (!refuseUnlessVerified(opts, id, "share", "nothing was published")) return 1;
      staticEvents = readSessionEvents(opts.dir, id);
    }
  }
  if (opts.static && nativePath !== null && staticEvents === null) {
    // --static on a path: one full (non-live) conversion, pushed once.
    const lines = readNativeLog(nativePath)
      .split("\n")
      .filter((l) => l.trim() !== "");
    const adapter = ADAPTERS.find((a) => a.detect(lines));
    if (!adapter) {
      console.error("no adapter recognizes this file");
      return 1;
    }
    const converted = adapter.convert(lines);
    const counts: RedactionCounts = {};
    for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
    staticEvents = buildChain(converted.sessionId, converted.drafts);
    nativePath = null;
  }

  const share = await createShare(opts.relay, ttlMs);
  if (nativePath !== null) {
    // Live shares are resumable after a crash: keep the credentials locally
    // (deleted again on a clean end — a surviving file means "resumable").
    writeShareState(opts.dir, {
      shareId: share.shareId,
      writerToken: share.writerToken,
      ttlMs: share.ttlMs,
      viewUrl: share.viewUrl,
      relay: opts.relay,
      nativePath,
      createdAt: new Date().toISOString(),
    });
  }
  const expiry = new Date(Date.now() + share.ttlMs).toLocaleString();
  console.log(`\n  ${share.viewUrl}\n`);
  console.log(`  sharing the redacted event log — anyone with the link can read it until ${expiry}.`);
  console.log("  viewer messages appear below; they are NOT injected into the running agent.");
  console.log(
    nativePath !== null
      ? `  Ctrl+C ends the share. If this process dies instead: agit share --resume ${share.shareId.slice(0, 8)}\n`
      : "  Ctrl+C ends the share.\n",
  );

  const inbox = openShareInbox(opts.relay, share);
  try {
    if (staticEvents) {
      await pushAll(opts.relay, share, staticEvents);
      console.log(`pushed ${staticEvents.length} events (static). Holding the share open…`);
      await waitForSigint();
      return 0;
    }
    const follower = followerFor(nativePath!);
    if (!follower) return 1;
    const initial = follower.poll();
    await pushAll(opts.relay, share, initial);
    console.log(`live: ${initial.length} events so far, tailing ${nativePath}`);
    return await liveLoop(opts.relay, share, follower, initial.length);
  } finally {
    inbox.abort();
    await endShare(opts.relay, share);
    deleteShareState(opts.dir, share.shareId);
    console.log("share ended.");
  }
}

/**
 * Resume a live share whose CLI died: the relay reports where its stored
 * chain ends; deterministic conversion regenerates the identical prefix,
 * which must carry the relay's head hash — then only the tail is pushed.
 */
async function cmdShareResume(opts: Opts): Promise<number> {
  const prefix = opts.args[0];
  if (!prefix) {
    console.error("usage: agit share --resume <share-id-prefix>");
    return 2;
  }
  let state: ShareState;
  try {
    state = resolveShareState(opts.dir, prefix);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const share: ShareInfo = {
    shareId: state.shareId,
    writerToken: state.writerToken,
    ttlMs: state.ttlMs,
    viewUrl: state.viewUrl,
  };
  // --relay overrides; otherwise resume against the relay the share lives on.
  const relay = opts.relay !== DEFAULT_RELAY ? opts.relay : state.relay;

  let head;
  try {
    head = await getShareHead(relay, share);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      console.error("that share no longer exists on the relay (expired); start a new one.");
      deleteShareState(opts.dir, share.shareId);
      return 1;
    }
    throw err;
  }
  if (head.ended) {
    console.error("that share was ended on the relay; start a new one.");
    deleteShareState(opts.dir, share.shareId);
    return 1;
  }
  if (!existsSync(state.nativePath)) {
    console.error(`source file is gone: ${state.nativePath}`);
    return 1;
  }
  const follower = followerFor(state.nativePath);
  if (!follower) return 1;
  const all = follower.poll();
  if (all.length < head.events) {
    console.error(
      `the source file now yields ${all.length} events but the relay already holds ${head.events} — history shrank; refusing to resume.`,
    );
    return 1;
  }
  if (head.events > 0 && all[head.events - 1]!.hash !== head.lastHash) {
    console.error(
      "the regenerated chain does not match the relay's head — the source file's history changed since the original share; refusing to resume.",
    );
    return 1;
  }

  console.log(`\n  ${share.viewUrl}\n`);
  console.log(
    `  resumed: relay holds ${head.events} events; pushing ${all.length - head.events} more, then tailing ${state.nativePath}`,
  );
  console.log("  Ctrl+C ends the share.\n");
  const inbox = openShareInbox(relay, share);
  // Only end the share once this process has successfully attached as its
  // writer. If the catch-up push fails (e.g. 409 because the original CLI is
  // in fact still alive and pushing), ending the share here would kill it
  // out from under that healthy writer — leave it alone and just report.
  let attached = false;
  try {
    await pushAll(relay, share, all.slice(head.events));
    attached = true;
    return await liveLoop(relay, share, follower, all.length);
  } catch (err) {
    if (!attached) {
      console.error(
        "could not attach to the share (is the original CLI still running?). Leaving it untouched.",
      );
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    throw err;
  } finally {
    inbox.abort();
    if (attached) {
      await endShare(relay, share);
      deleteShareState(opts.dir, share.shareId);
      console.log("share ended.");
    }
  }
}

function followerFor(nativePath: string): SessionFollower | null {
  const adapter = pickAdapterFor(nativePath);
  if (!adapter) {
    console.error("no adapter recognizes this file");
    return null;
  }
  return new SessionFollower(nativePath, adapter);
}

function openShareInbox(relayUrl: string, share: ShareInfo): AbortController {
  let lastViewers = -1;
  return openInbox(relayUrl, share, {
    onMessage: (m) => console.log(`◀ ${m.ts.slice(11, 19)} [${m.name}] ${m.text}`),
    onInfo: (i) => {
      if (i.viewers !== lastViewers) {
        lastViewers = i.viewers;
        console.log(`· ${i.viewers} watching`);
      }
    },
  });
}

/** Tail the native log until Ctrl+C (or a stability failure), then seal the stream. */
async function liveLoop(
  relayUrl: string,
  share: ShareInfo,
  follower: SessionFollower,
  alreadyPushed: number,
): Promise<number> {
  let pushed = alreadyPushed;
  let ticking = false;
  let fatal: Error | null = null;
  const timer = setInterval(() => {
    if (ticking || fatal) return;
    ticking = true;
    void (async () => {
      try {
        const fresh = follower.poll();
        await pushAll(relayUrl, share, fresh);
        pushed += fresh.length;
      } catch (err) {
        if (err instanceof StabilityError) {
          fatal = err;
        }
        // Other errors (relay hiccup, file mid-write) retry next tick.
      } finally {
        ticking = false;
      }
    })();
  }, 1000);

  await waitForSigint(() => fatal !== null);
  clearInterval(timer);
  if (fatal !== null) {
    console.error((fatal as Error).message);
    return 1;
  }
  try {
    const tail = follower.finish();
    await pushAll(relayUrl, share, tail);
    pushed += tail.length;
    if (tail.length > 0)
      console.log(
        `sealed the stream with its final ${tail.length} events — it now matches a full import exactly.`,
      );
  } catch {
    /* best effort on shutdown */
  }
  console.log(`shared ${pushed} events total.`);
  return 0;
}

function pickAdapterFor(path: string): Adapter | undefined {
  const lines = readNativeLog(path)
    .split("\n")
    .filter((l) => l.trim() !== "");
  return ADAPTERS.find((a) => a.detect(lines));
}

/** Push in size-bounded batches so a 30MB session doesn't become one request. */
async function pushAll(relayUrl: string, share: ShareInfo, events: AgitEvent[]): Promise<void> {
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_COUNT = 500;
  let batch: AgitEvent[] = [];
  let bytes = 0;
  for (const e of events) {
    const size = JSON.stringify(e).length;
    if (batch.length > 0 && (bytes + size > MAX_BYTES || batch.length >= MAX_COUNT)) {
      await pushEvents(relayUrl, share, batch);
      batch = [];
      bytes = 0;
    }
    batch.push(e);
    bytes += size;
  }
  if (batch.length > 0) await pushEvents(relayUrl, share, batch);
}

function waitForSigint(alsoWhen?: () => boolean): Promise<void> {
  return new Promise((resolveWait) => {
    // The ref'd interval both polls the extra condition and guarantees the
    // event loop stays alive while we wait (a SIGINT listener alone doesn't).
    const check = setInterval(() => {
      if (alsoWhen?.()) done();
    }, 250);
    const done = () => {
      clearInterval(check);
      process.removeListener("SIGINT", done);
      resolveWait();
    };
    process.once("SIGINT", done);
  });
}

function printEventDetail(events: AgitEvent[], seq: number): void {
  const e = events[seq]!;
  console.log(`\n─── event ${e.seq} · ${e.ts} · ${e.type} ─── hash ${e.hash.slice(0, 12)}`);
  const p = e.payload as { [k: string]: unknown };
  switch (e.type) {
    case "message.user":
    case "message.assistant": {
      const texts =
        e.type === "message.user"
          ? [String(p.text ?? "")]
          : (p.blocks as { type: string; text: string }[]).map((b) =>
              b.type === "thinking" ? `(thinking) ${b.text}` : b.text,
            );
      for (const t of texts) console.log(indentClip(t, 30));
      break;
    }
    case "tool.call":
      console.log(`  ${p.name}`);
      console.log(indentClip(JSON.stringify(p.input, null, 2) ?? "{}", 25));
      break;
    case "tool.result":
      if (p.isError === true) console.log("  (error)");
      console.log(indentClip(String(p.output ?? ""), 25));
      break;
    case "file.diff":
      console.log(`  ${p.kind} ${p.path}`);
      console.log(`  before ${short(p.beforeHash)}  after ${short(p.afterHash)}`);
      console.log(indentClip(String(p.diff ?? ""), 40));
      break;
    default:
      console.log(indentClip(JSON.stringify(p, null, 2), 25));
  }
}

function printStateAt(events: AgitEvent[], seq: number): void {
  const files = fileStateAt(events, seq);
  const u = usageTotals(events, seq);
  console.log(`\nstate after event ${seq}:`);
  console.log(`  tokens so far  in=${u.inputTokens} out=${u.outputTokens} (${u.apiMessages} API messages)`);
  if (files.size === 0) {
    console.log("  no structured file edits yet");
  } else {
    for (const f of files.values()) {
      const diverged =
        f.divergedAtSeq !== undefined && f.divergedAtSeq <= seq
          ? `  [DIVERGED at seq ${f.divergedAtSeq}]`
          : "";
      console.log(
        `  ${f.kind === "create" ? "A" : "M"} ${f.path}  (+${f.added} -${f.removed})  content sha256 ${f.afterHash.slice(0, 12)} @ seq ${f.lastSeq}${diverged}`,
      );
    }
    console.log(
      "  (lower bound: structured edits only — shell-driven changes are invisible here, SPEC §5.7)",
    );
  }
}

function indentClip(text: string, maxLines: number): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).map((l) => "  " + clipLine(l, 160));
  if (lines.length > maxLines) shown.push(`  … ${lines.length - maxLines} more lines`);
  return shown.join("\n");
}

/** Hashes render truncated in views; full values live in the log (agit export). */
function short(h: unknown): string {
  return typeof h === "string" ? h.slice(0, 12) : "∅";
}

function requireId(opts: Opts): string {
  const arg = opts.args[0];
  if (!arg) {
    console.error("missing <id> (agit ls to list sessions)");
    process.exit(2);
  }
  return resolveSessionId(opts.dir, arg);
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
