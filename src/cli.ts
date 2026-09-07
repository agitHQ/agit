#!/usr/bin/env node
/** agit — git for running agents. Local verbs only (roadmap milestone 1). */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import type { Adapter } from "./adapters/adapter.js";
import { buildChain, sha256Hex, toJsonl } from "./format/hash.js";
import { verifyChain } from "./format/verify.js";
import type { AgitEvent, SessionMeta } from "./format/events.js";
import { writeFork } from "./fork.js";
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
import { clipLine, fileStateAt, timelineLines, usageTotals } from "./state.js";

const ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter];
const DEFAULT_RELAY = process.env.AGIT_RELAY ?? "http://127.0.0.1:7717";

const USAGE = `agit — git for running agents

usage:
  agit import <native-session.jsonl>   ingest a native session into .agit/
  agit ls                              list imported sessions
  agit show <id>                       summarize one session
  agit verify <id | events.jsonl>      validate the hash chain — of a stored
                                       session, or any log file (pr bundles,
                                       downloaded share logs)
  agit replay <id> [--at N] [--state]  step through events; --at jumps to N,
                                       --state prints file state at that point
  agit replay <id> --timeline          print the whole timeline, one line per event
  agit export <id> [--json]            write the event log to stdout — JSONL, or a
                                       JSON array with --json — for other tools
  agit fork <id> --at N [--out DIR]    branch at event N: reconstruct the file tree
                                       (hash-verified) and write a context seed
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
  --relay <url>    relay to share through (default: $AGIT_RELAY or http://127.0.0.1:7717)
  --ttl <hours>    how long the share link lives (default 24h, max 168h)
  --static         share the log as it is now; do not tail for growth
  --port <n>       relay: port to listen on (default 7717)
  --host <addr>    relay: address to bind (default 127.0.0.1; 0.0.0.0 exposes it)

<id> accepts any unique prefix. See SPEC.md for the format, PROTOCOL.md for the relay.`;

interface Opts {
  dir: string;
  at?: number;
  timeline: boolean;
  state: boolean;
  json: boolean;
  out?: string;
  into?: string;
  summary?: string;
  relay: string;
  ttlHours?: number;
  static: boolean;
  resume: boolean;
  port?: number;
  host?: string;
  args: string[];
}

function parseArgs(argv: string[]): { verb: string; opts: Opts } {
  const opts: Opts = {
    dir: process.cwd(),
    timeline: false,
    state: false,
    json: false,
    relay: DEFAULT_RELAY,
    static: false,
    resume: false,
    args: [],
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dir") opts.dir = resolve(argv[++i] ?? ".");
    else if (a === "--at") opts.at = Number(argv[++i]);
    else if (a === "--timeline") opts.timeline = true;
    else if (a === "--state") opts.state = true;
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
    case "export":
      return cmdExport(opts);
    case "fork":
      return cmdFork(opts);
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

function cmdImport(opts: Opts): number {
  const src = opts.args[0];
  if (!src) {
    console.error("usage: agit import <native-session.jsonl>");
    return 2;
  }
  const path = resolve(src);
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");

  const adapter = ADAPTERS.find((a) => a.detect(lines));
  if (!adapter) {
    console.error(
      "no adapter recognizes this file (adapters available: " + ADAPTERS.map((a) => a.name).join(", ") + ")",
    );
    return 1;
  }

  const converted = adapter.convert(lines);
  const redactions: RedactionCounts = {};
  for (const d of converted.drafts) d.payload = redactDeep(d.payload, redactions);
  const events = buildChain(converted.sessionId, converted.drafts);
  const jsonl = toJsonl(events);

  const meta: SessionMeta = {
    agitSchema: 1,
    sessionId: converted.sessionId,
    adapter: { name: adapter.name, version: adapter.version },
    importedAt: new Date().toISOString(),
    source: { path, sha256: sha256Hex(raw), bytes: statSync(path).size, records: converted.records },
    skipped: converted.skipped,
    redactions,
    eventCount: events.length,
    headHash: events[events.length - 1]!.hash,
  };
  writeSession(opts.dir, converted.sessionId, jsonl, meta);

  console.log(`imported ${converted.sessionId}`);
  console.log(`  adapter     ${adapter.name}@${adapter.version}`);
  console.log(`  events      ${events.length} (from ${converted.records} native records)`);
  const skippedTotal = Object.values(converted.skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) {
    const detail = Object.entries(converted.skipped)
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
  console.log(`  head        ${meta.headHash.slice(0, 12)}`);
  console.log(`  wrote       ${sessionDir(opts.dir, converted.sessionId)}`);
  return 0;
}

function cmdLs(opts: Opts): number {
  const ids = listSessionIds(opts.dir);
  if (ids.length === 0) {
    console.log("no sessions imported yet (agit import <file>)");
    return 0;
  }
  const rows = ids.map((id) => {
    const events = readSessionEvents(opts.dir, id);
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
  const check = verifyChain(readSessionLines(opts.dir, id));
  if (!check.ok) {
    const why = check.firstBroken
      ? `event ${check.firstBroken.seq}: ${check.firstBroken.reason}`
      : "broken chain";
    console.error(`refusing to fork: chain verification failed — ${why}`);
    return 1;
  }

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
  const check = verifyChain(readSessionLines(opts.dir, id));
  if (!check.ok) {
    console.error("refusing to hand off an unverifiable session (agit verify it first)");
    return 1;
  }
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
function cmdExport(opts: Opts): number {
  const id = requireId(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(readSessionEvents(opts.dir, id), null, 2) + "\n");
  } else {
    // JSONL: the stored log verbatim, hash chain intact — pipe it anywhere.
    for (const line of readSessionLines(opts.dir, id)) process.stdout.write(line + "\n");
  }
  return 0;
}

async function cmdRelay(opts: Opts): Promise<number> {
  const handle = await startRelay({ port: opts.port, host: opts.host });
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
      staticEvents = readSessionEvents(opts.dir, id);
    }
  }
  if (opts.static && nativePath !== null && staticEvents === null) {
    // --static on a path: one full (non-live) conversion, pushed once.
    const lines = readFileSync(nativePath, "utf8")
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
  const lines = readFileSync(path, "utf8")
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
