#!/usr/bin/env node
/** agit — git for running agents. Local verbs only (roadmap milestone 1). */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { openclawAdapter } from "./adapters/openclaw.js";
import type { Adapter } from "./adapters/adapter.js";
import { buildChain, sha256Hex, toJsonl } from "./format/hash.js";
import { verifyChain } from "./format/verify.js";
import {
  EVENT_TYPES,
  isEventType,
  type Json,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type AgitEvent,
  type SessionMeta,
} from "./format/events.js";
import { blameFile, sessionTrailer, whyLine, type LineOrigin } from "./blame.js";
import { writeFork } from "./fork.js";
import { renderSessionHtml } from "./html.js";
import { diffSessions, renderDiff, treeOnDisk } from "./diff.js";
import { discoverSessionLogs, parseSince } from "./discover.js";
import { buildMatcher, grepEvents, GrepPatternError, renderHit } from "./grep.js";
import { mergeFork, readForkInfo } from "./merge.js";
import { loadBaseTree, BaseTreeError, type BaseTree } from "./base.js";
import {
  builtinConfig,
  customPatternCount,
  disabledConfig,
  parseRedactionConfig,
  redactDeep,
  RedactionConfigError,
  scanValue,
  type RedactionConfig,
  type RedactionCounts,
} from "./redact.js";
import { toAtif, toOtlpJson } from "./interop.js";
import { serveMcp, setServerVersion } from "./mcp.js";
import { KeyError, loadPrivateKey, signHead, SIGNATURE_PAYLOAD_VERSION, verifySignature } from "./sign.js";
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
  agitDir,
  addTag,
  assertSafeSessionId,
  minimalPrefixes,
  readNotes,
  removeSession,
  removeTag,
  setNote,
  deleteShareState,
  listSessionIds,
  readSessionEvents,
  readSessionLines,
  readSessionMeta,
  writeSessionMeta,
  resolveSessionId,
  resolveShareState,
  sessionDir,
  type SessionNotes,
  type ShareState,
  writeSession,
  writeShareState,
} from "./store.js";
import { clipLine, fileStateAt, timelineLines, usageByModel, usageTotals } from "./state.js";
import {
  computeStats,
  GROUP_BY,
  isGroupBy,
  parsePriceTable,
  PriceTableError,
  type PriceTable,
  type StatsRow,
} from "./stats.js";

const ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter, openclawAdapter];
const DEFAULT_RELAY = process.env.AGIT_RELAY ?? "http://127.0.0.1:7717";

const USAGE = `agit — git for running agents

usage:
  agit import <session | bundle>       ingest a native session into .agit/, or
                       [--base REF]    adopt an agit log or pr bundle as-is;
                                       --base seeds pre-session file content
                                       adopt an agit log or pr bundle as-is
  agit import <session> --no-redact    skip credential scanning; share/pr later
                                       refuse this session without --allow-unredacted
  agit import --all [--since 7d]       find every session the supported runtimes
                                       have written and import what is new
  agit import --latest                 import the most recently written session
  agit ls [--tag T] [--runtime R]       list imported sessions; --sort orders by
         [--project P] [--sort KEY]     started (default), events, files or id
  agit tag <id> <tag>                  tag a session (--remove <tag> to drop one)
  agit note <id> "<text>"              attach a note (--clear to remove it)
  agit rm <id> [--yes]                 delete a session from the store
  agit gc --older-than 90d             delete sessions older than a cutoff;
         [--keep-tagged] [--yes]       --keep-tagged spares anything tagged
  agit ls                              list imported sessions
  agit rm <id> --yes                   permanently delete a session from the store
  agit stats [--by model|runtime]      usage across every imported session —
             [--json]                 tokens and API calls, grouped
  agit show <id> [--by-model]          summarize one session; --by-model splits
                                       cost and file edits per model
  agit verify <id | events.jsonl>      validate the hash chain — of a stored
                                       session, or any log file (pr bundles,
                                       downloaded share logs)
  agit replay <id> [--at N] [--state]  step through events; --at jumps to N,
                                       --state prints file state at that point
  agit replay <id> --timeline          print the whole timeline, one line per event
  agit blame <file>                    which session and event last wrote each
                                       line (structured edits only, SPEC 5.7)
  agit why <file>:<line>               that, plus the prompt that asked for it
  agit link [<session-id> | <file>]    print the Agit-Session commit trailer
                                       (default: the newest session)
  agit redact --check <session.jsonl>  dry run: what redaction would remove,
                                       masked, with a re-scan afterwards
  agit stats [--by day|model|runtime|project]
                                       store-wide usage across every session;
                                       --since narrows, --price <file> costs it
  agit grep <pattern>                  search every imported session; --type
                                       narrows to one event type, --path matches
                                       file paths only, --regex, -s case-sensitive
  agit export <id> [--json]            write the event log to stdout — JSONL, or a
                                       JSON array with --json — for other tools
  agit export-html <id> [--out FILE]   write a self-contained, offline HTML session
                       [--at N]        viewer; --at N exports the prefix up to event N
  agit fork <id> --at N [--out DIR]    branch at event N: reconstruct the file tree
                                       (hash-verified) and write a context seed
  agit diff <a> <b> | <fork-dir>       compare two sessions, or a fork against
                                       its parent from the fork point
  agit merge <fork-dir> [--into DIR]   three-way merge a fork's files back
                       [--session <id>] (base = fork point), via git merge-file;
                                       --session honours the fork's deletions
                                       (base = fork point). Uses git merge-file
                                       when present, a built-in merge otherwise
  agit pr <id> [--at N] [--out DIR]    handoff bundle for a colleague: log +
                                       meta + verified tree + context seed
  agit share <id | native.jsonl>       share a session through a relay — live if it
                                       is still running; viewer messages land here
  agit share --resume <share-id>       resume a live share after a crash (relay
                                       keeps the buffer; only the tail is pushed)
  agit relay [--cert P --key P]        run a relay (self-hosted, in-memory);
                                       serves HTTPS when given a cert and key
  agit export <id> --otel              OTLP/JSON spans (OpenTelemetry GenAI)
  agit export <id> --atif              an ATIF trajectory (Harbor / OpenHands)
  agit sign <id> --key <file>          sign this head with an ed25519 key, so
                                       the log proves who recorded it
  agit mcp                             serve the store to an agent over MCP
                                       (stdio, read-only: grep/show/replay/
                                       diff/verify/list)

options:
  --base <ref|dir> import: a git ref or directory holding the files as they
                   were before the session, so updates to files that predate
                   it can be verified instead of skipped
  --redact-patterns <file>  extra patterns + allowlist (default: .agit/redact.json)
  --no-redact      import: store the log unredacted (local-only stores)
  --allow-unredacted  share/pr: publish an unredacted session anyway
  --dir <path>     where .agit/ lives (default: current directory)
  --tag <t>        ls/grep: only sessions carrying this tag
  --runtime <r>    ls: only sessions from this runtime
  --project <p>    ls: only sessions whose cwd ends in this directory name
  --sort <key>     ls: started (default), events, files or id
  --older-than <d> gc: cutoff, e.g. 90d
  --keep-tagged    gc: never delete a tagged session
  --yes, -y        rm/gc: skip the confirmation prompt
  --out <dir>      fork/pr: where to write the fork or bundle
  --into <dir>     merge: target directory (default: current directory)
  --summary <txt>  merge: what the fork learned, recorded in merge.json
  --session <id>   merge: the fork's own imported session, so deletions it
                   recorded after the fork point are honoured
  --no-git         merge: use the built-in three-way merge, not git merge-file
  --since <dur>    import --all / stats: window of 7d / 24h / 30m
  --yes, -y        rm: confirm the deletion (there is no interactive prompt)
  --by <group>     stats: day (default), model, runtime or project
  --price <file>   stats: a local rate table; without it no money is shown
  --json           ls/show/verify/grep/diff/export: machine-readable output
                   instead of the human-formatted default (grep: one JSON
                   object per line, NDJSON; everything else: one document)
  --no-redact      import: store the session verbatim, skipping credential
                   scanning (SPEC §8) — meta.json remembers this
  --allow-unredacted  share/pr: proceed anyway on a --no-redact session
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
  --cert <pem>     relay: TLS certificate; with --key, serve HTTPS
  --key <pem>      relay: TLS private key
  --insecure       relay: allow binding beyond loopback without TLS

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
  yes: boolean;
  noRedact: boolean;
  allowUnredacted: boolean;
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
  base?: string;
  redactPatterns?: string;
  check: boolean;
  tag?: string;
  runtime?: string;
  project?: string;
  sort?: string;
  olderThan?: number;
  keepTagged: boolean;
  by?: string;
  price?: string;
  session?: string;
  noGit: boolean;
  cert?: string;
  key?: string;
  otel?: boolean;
  atif?: boolean;
  insecure: boolean;
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
    yes: false,
    noRedact: false,
    allowUnredacted: false,
    grepPath: false,
    grepRegex: false,
    caseSensitive: false,
    relay: DEFAULT_RELAY,
    static: false,
    resume: false,
    trustedProxies: [],
    check: false,
    keepTagged: false,
    noGit: false,
    insecure: false,
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
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--no-redact") opts.noRedact = true;
    else if (a === "--allow-unredacted") opts.allowUnredacted = true;
    else if (a === "--relay") opts.relay = argv[++i] ?? opts.relay;
    else if (a === "--ttl") opts.ttlHours = Number(argv[++i]);
    else if (a === "--static") opts.static = true;
    else if (a === "--resume") opts.resume = true;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--host") opts.host = argv[++i];
    else if (a === "--trusted-proxy") opts.trustedProxies.push(argv[++i] ?? "");
    else if (a === "--base") opts.base = argv[++i];
    else if (a === "--redact-patterns") opts.redactPatterns = argv[++i];
    else if (a === "--check") opts.check = true;
    else if (a === "--tag") opts.tag = argv[++i];
    else if (a === "--runtime") opts.runtime = argv[++i];
    else if (a === "--project") opts.project = argv[++i];
    else if (a === "--sort") opts.sort = argv[++i];
    else if (a === "--keep-tagged") opts.keepTagged = true;
    else if (a === "--older-than") {
      const ms = parseSince(argv[++i] ?? "");
      if (ms === null) {
        console.error("--older-than takes a duration like 90d, 24h or 30m");
        process.exit(2);
      }
      opts.olderThan = ms;
    } else if (a === "--by") opts.by = argv[++i];
    else if (a === "--price") opts.price = argv[++i];
    else if (a === "--session") opts.session = argv[++i];
    else if (a === "--no-git") opts.noGit = true;
    else if (a === "--cert") opts.cert = argv[++i];
    else if (a === "--key") opts.key = argv[++i];
    else if (a === "--insecure") opts.insecure = true;
    else if (a === "--otel") opts.otel = true;
    else if (a === "--atif") opts.atif = true;
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
    case "tag":
      return cmdTag(opts);
    case "note":
      return cmdNote(opts);
    case "rm":
      return cmdRm(opts);
    case "gc":
      return cmdGc(opts);
    case "ls":
      return cmdLs(opts);
    case "stats":
      return cmdStats(opts);
    case "show":
      return cmdShow(opts);
    case "verify":
      return cmdVerify(opts);
    case "sign":
      return cmdSign(opts);
    case "replay":
      return cmdReplay(opts);
    case "blame":
      return cmdBlame(opts);
    case "why":
      return cmdWhy(opts);
    case "link":
      return cmdLink(opts);
    case "redact":
      return cmdRedact(opts);
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
    case "mcp":
      return cmdMcp(opts);
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
    typeof e.v === "number" &&
    SUPPORTED_SCHEMA_VERSIONS.includes(e.v) &&
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
/**
 * A session imported with --no-redact never went through SPEC §8, so its log
 * may hold live credentials verbatim. Publishing one is a decision, not a
 * default: `share` and `pr` refuse unless the caller says so explicitly.
 */
function refuseUnredacted(opts: Opts, id: string, verb: string): boolean {
  const meta = readSessionMeta(opts.dir, id);
  if (meta?.redaction?.enabled !== false) return true;
  if (opts.allowUnredacted) {
    console.error(`warning: ${id} was imported with --no-redact; publishing it unredacted as asked.`);
    return true;
  }
  console.error(
    `refusing to ${verb} ${id}: it was imported with --no-redact, so its log never went through\n` +
      "credential redaction (SPEC §8) and may contain live secrets verbatim.\n" +
      "Re-import it without --no-redact, or pass --allow-unredacted to publish it as it is.",
  );
  return false;
}

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

/** A session already in the store, and the redaction mode it was imported under. */
interface KnownSource {
  id: string;
  noRedact: boolean;
}

interface ImportOutcome {
  status: "imported" | "updated" | "unchanged" | "unrecognized";
  id?: string;
  adapter?: Adapter;
  events?: number;
  previousEvents?: number;
  /** True when this re-import flipped --no-redact on or off for an already-stored session. */
  modeChanged?: boolean;
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
function knownSources(dir: string): Map<string, KnownSource> {
  const known = new Map<string, KnownSource>();
  for (const id of listSessionIds(dir)) {
    const meta = readSessionMeta(dir, id);
    if (meta?.source?.sha256) {
      known.set(meta.source.sha256, { id, noRedact: meta.redaction?.enabled === false });
    }
  }
  return known;
}

/** The cwd the session recorded, which is what a supplied base was resolved against. */
function cwdOf(events: AgitEvent[]): string | null {
  const cwd = (events[0]?.payload as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : null;
}

/**
 * Resolve --base once per run. Returns undefined when the flag is absent and
 * null when it was given but could not be read, so the caller can stop.
 */
function baseTreeFor(opts: Opts): BaseTree | null | undefined {
  if (opts.base === undefined) return undefined;
  try {
    const tree = loadBaseTree(opts.base, opts.dir);
    if (tree.files.size === 0) {
      console.error(`--base ${opts.base}: resolved to an empty tree; nothing to verify updates against`);
      return null;
    }
    return tree;
  } catch (err) {
    console.error(
      err instanceof BaseTreeError
        ? `--base ${opts.base}: ${err.message}`
        : `--base ${opts.base}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Convert one native log into the store. Prints nothing; callers decide how much to say. */
function importNativeLog(
  opts: Opts,
  path: string,
  raw: string,
  lines: string[],
  known: Map<string, KnownSource>,
  redactCfg: RedactionConfig,
  base?: BaseTree,
): ImportOutcome {
  const sha256 = sha256Hex(raw);
  const hit = known.get(sha256);
  // The source bytes alone stopped being a complete identity the moment
  // --no-redact made the stored output depend on a flag too. Re-import when
  // the requested mode differs from the stored one, so that re-importing
  // without the flag is the cure for an accidental --no-redact rather than a
  // no-op that reports success.
  if (hit !== undefined && hit.noRedact === opts.noRedact) {
    return { status: "unchanged", id: hit.id };
  }

  const adapter = ADAPTERS.find((a) => a.detect(lines));
  if (!adapter) return { status: "unrecognized" };

  const converted = adapter.convert(lines, base ? { base } : undefined);
  const redactions: RedactionCounts = {};
  for (const d of converted.drafts) d.payload = redactDeep(d.payload, redactions, redactCfg);
  if (!opts.noRedact) {
    for (const d of converted.drafts) d.payload = redactDeep(d.payload, redactions);
  }
  const events = buildChain(converted.sessionId, converted.drafts);
  // Same id already stored means the source grew (a resumed session) or changed.
  const previous = listSessionIds(opts.dir).includes(converted.sessionId)
    ? readSessionMeta(opts.dir, converted.sessionId)
    : null;
  // Same bytes, different mode: the user is switching redaction on or off,
  // which is the one case where "updated N -> N events" would read as a
  // no-op when it is in fact a full rewrite of the stored payloads.
  const modeChanged = previous !== null && (previous.redaction?.enabled === false) !== opts.noRedact;

  const meta: SessionMeta = {
    agitSchema: SCHEMA_VERSION,
    sessionId: converted.sessionId,
    adapter: { name: adapter.name, version: adapter.version },
    importedAt: new Date().toISOString(),
    source: { path, sha256, bytes: statSync(path).size, records: converted.records },
    skipped: converted.skipped,
    redactions,
    ...(base
      ? {
          base: {
            kind: base.kind,
            ref: base.ref,
            cwd: cwdOf(events),
            files: base.files.size,
          },
        }
      : {}),
    // What redaction actually did here, so `share` and `pr` do not have to
    // guess whether a log has been through it.
    redaction: {
      enabled: redactCfg.enabled,
      customPatterns: customPatternCount(redactCfg),
      allowRules: redactCfg.allowLiterals.size + redactCfg.allowRegexes.length,
    },
    eventCount: events.length,
    headHash: events[events.length - 1]!.hash,
  };
  writeSession(opts.dir, converted.sessionId, toJsonl(events), meta);
  known.set(sha256, { id: converted.sessionId, noRedact: opts.noRedact });
  return {
    status: previous ? "updated" : "imported",
    id: converted.sessionId,
    modeChanged,
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
  if (outcome.modeChanged === true) {
    console.log(
      opts.noRedact
        ? "  re-imported  redaction was ON for the stored copy; it is now OFF (--no-redact)"
        : "  re-imported  redaction was OFF (--no-redact) for the stored copy; it is now ON",
    );
  }
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) {
    const detail = Object.entries(skipped)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    console.log(`  skipped     ${skippedTotal} native records with no mapping: ${detail}`);
  }
  const redactedTotal = Object.values(redactions).reduce((a, b) => a + b, 0);
  // "nothing matched" and "nothing was looked for" are very different claims
  // about a stored log, and only one of them is reassuring.
  if (opts.noRedact) {
    console.log("  redacted    DISABLED (--no-redact): this log was stored exactly as the runtime wrote it");
    console.log("              share and pr will refuse it without --allow-unredacted");
  } else {
    console.log(
      redactedTotal > 0
        ? `  redacted    ${redactedTotal}: ${Object.entries(redactions)
            .map(([k, v]) => `${k}×${v}`)
            .join(", ")}`
        : `  redacted    nothing matched the credential patterns (SPEC §8 — a seatbelt, not a guarantee)`,
    );
  }
  console.log(`  head        ${outcome.headHash!.slice(0, 12)}`);
  console.log(`  wrote       ${sessionDir(opts.dir, id)}`);
  return 0;
}

/**
 * The redaction config for this run: `--redact-patterns`, else
 * `.agit/redact.json` in the store, else the built-ins. `--no-redact`
 * overrides both.
 *
 * A project's own token formats are exactly what the built-in list cannot
 * know about, and its documented example keys are exactly what the built-in
 * list should not rewrite.
 */
function redactionConfigFor(opts: Opts): RedactionConfig | null {
  if (opts.noRedact) return disabledConfig();
  const explicit = opts.redactPatterns !== undefined ? resolve(opts.redactPatterns) : null;
  const conventional = join(agitDir(opts.dir), "redact.json");
  const path = explicit ?? (existsSync(conventional) ? conventional : null);
  if (path === null) return builtinConfig();
  try {
    return parseRedactionConfig(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(
      err instanceof RedactionConfigError
        ? `${path}: ${err.message}`
        : `${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * `agit redact --check <native-log>` — what redaction would do, before it is
 * hashed into anything.
 *
 * Reports per event type and payload path, with every sample masked: a report
 * that printed the credentials it found would be a worse leak than the log.
 * After redacting, it re-scans the result and reports anything still
 * matching, so the count can never quietly under-report.
 */
function cmdRedact(opts: Opts): number {
  const src = opts.args[0];
  if (!opts.check || !src) {
    console.error("usage: agit redact --check <native-session.jsonl>");
    return 2;
  }
  const cfg = redactionConfigFor(opts);
  if (cfg === null) return 2;
  const path = resolve(src);
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const adapter = ADAPTERS.find((a) => a.detect(lines));
  if (!adapter) {
    console.error("no adapter recognizes this file");
    return 1;
  }
  const converted = adapter.convert(lines);

  const byLabel = new Map<string, number>();
  let total = 0;
  console.log(`redaction dry run: ${path}`);
  console.log(
    `  config      ${customPatternCount(cfg)} custom pattern(s), ${cfg.allowLiterals.size + cfg.allowRegexes.length} allow rule(s)`,
  );
  for (const d of converted.drafts) {
    for (const f of scanValue(d.payload, cfg)) {
      byLabel.set(f.label, (byLabel.get(f.label) ?? 0) + 1);
      total++;
      console.log(`  ${d.type.padEnd(18)} ${f.at.padEnd(28)} ${f.label}  ${f.sample}`);
    }
  }
  if (total === 0) {
    console.log("  nothing matched the credential patterns (SPEC §8 — a seatbelt, not a guarantee)");
    return 0;
  }
  console.log(`  would redact ${total}: ${[...byLabel.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);

  // Re-scan after redaction. A pattern whose replacement still matches
  // something would leave a credential in the log while reporting a count, so
  // this is the check that the count is the truth.
  const counts: RedactionCounts = {};
  const residue: string[] = [];
  for (const d of converted.drafts) {
    const after = redactDeep(d.payload, counts, cfg);
    for (const f of scanValue(after, cfg)) residue.push(`${d.type} ${f.at} ${f.label} ${f.sample}`);
  }
  if (residue.length > 0) {
    console.error(`\n${residue.length} match(es) STILL PRESENT after redaction — this is a bug:`);
    for (const r of residue) console.error(`  ${r}`);
    return 1;
  }
  console.log("  re-scan after redaction: clean");
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

  const base = baseTreeFor(opts);
  if (base === null) return 2;
  const redactCfg = redactionConfigFor(opts);
  if (redactCfg === null) return 2;
  return printImportReport(
    opts,
    importNativeLog(opts, path, raw, lines, knownSources(opts.dir), redactCfg, base),
  );
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
  const discoveredBase = baseTreeFor(opts);
  if (discoveredBase === null) return 2;
  const redactCfg = redactionConfigFor(opts);
  if (redactCfg === null) return 2;
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
        : importNativeLog(opts, log.path, raw, lines, known, redactCfg, discoveredBase);
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
    // The recipient has the least context about how this log was produced,
    // and adoption is the one moment agit speaks to them. A --no-redact
    // origin leaves `redactions` empty, so silence here would read as
    // "scanned, nothing found" — the opposite of what happened.
    if (meta.redaction?.enabled === false) {
      console.log(
        "  redactions  NONE — the origin imported with --no-redact, so this log was never scanned for credentials (agit did not re-scan either)",
      );
    } else {
      const redacted = Object.entries(meta.redactions);
      if (redacted.length > 0) {
        console.log(
          `  redactions  ${redacted.map(([k, v]) => `${k}×${v}`).join(", ")} (applied at the origin; agit did not re-scan)`,
        );
      }
    }
  } else {
    console.log("  meta        none in the bundle — truncation is not checkable for this session");
  }
  console.log(`  head        ${(JSON.parse(head) as AgitEvent).hash.slice(0, 12)}`);
  console.log(`  wrote       ${sessionDir(opts.dir, id)}`);
  return 0;
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error(`${question} — refusing without a terminal to ask; pass --yes to mean it.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

function cmdTag(opts: Opts): number {
  const [idArg, tag] = opts.args;
  if (!idArg || !tag) {
    console.error("usage: agit tag <id> <tag>   |   agit tag <id> --remove <tag>");
    return 2;
  }
  const id = resolveSessionId(opts.dir, idArg);
  // `agit tag x --remove y` parses as args [x, --remove?]; keep it explicit.
  const remove = opts.args.includes("--remove");
  const value = remove ? opts.args[opts.args.indexOf("--remove") + 1] : tag;
  if (remove && !value) {
    console.error("usage: agit tag <id> --remove <tag>");
    return 2;
  }
  const notes = remove ? removeTag(opts.dir, id, value!) : addTag(opts.dir, id, value!);
  console.log(`${id}: tags ${notes.tags.length > 0 ? notes.tags.join(", ") : "(none)"}`);
  return 0;
}

function cmdNote(opts: Opts): number {
  const idArg = opts.args[0];
  if (!idArg) {
    console.error('usage: agit note <id> "<text>"   |   agit note <id> --clear');
    return 2;
  }
  const id = resolveSessionId(opts.dir, idArg);
  if (opts.args.includes("--clear")) {
    setNote(opts.dir, id, null);
    console.log(`${id}: note cleared`);
    return 0;
  }
  const text = opts.args.slice(1).join(" ").trim();
  if (text === "") {
    const current = readNotes(opts.dir, id).note;
    console.log(current ?? "(no note)");
    return 0;
  }
  setNote(opts.dir, id, text);
  console.log(`${id}: note saved`);
  return 0;
}

async function cmdRm(opts: Opts): Promise<number> {
  const idArg = opts.args[0];
  if (!idArg) {
    console.error("usage: agit rm <id> [--yes]");
    return 2;
  }
  const id = resolveSessionId(opts.dir, idArg);
  const events = (() => {
    try {
      return readSessionEvents(opts.dir, id);
    } catch {
      return [];
    }
  })();
  console.log(`${id}: ${events.length} events${events[0] ? `, started ${events[0].ts}` : ""}`);
  const notes = readNotes(opts.dir, id);
  if (notes.tags.length > 0) console.log(`  tagged ${notes.tags.join(", ")}`);
  if (notes.note) console.log(`  note: ${notes.note}`);
  // A fork made from this session lives outside the store and keeps only the
  // session id in fork.json; deleting the log leaves it with no merge base.
  console.log("  any fork of this session loses its merge base — `agit merge` needs the log.");
  if (!(await confirm(`delete ${id} permanently?`, opts.yes))) {
    console.log("nothing deleted.");
    return 1;
  }
  removeSession(opts.dir, id);
  console.log(`deleted ${id}`);
  return 0;
}

async function cmdGc(opts: Opts): Promise<number> {
  if (opts.olderThan === undefined) {
    console.error("usage: agit gc --older-than 90d [--keep-tagged] [--yes]");
    return 2;
  }
  const cutoff = Date.now() - opts.olderThan;
  const doomed: { id: string; last: string; tags: string[] }[] = [];
  for (const id of listSessionIds(opts.dir)) {
    let events;
    try {
      events = readSessionEvents(opts.dir, id);
    } catch {
      continue; // unreadable: leave it alone rather than delete what we cannot read
    }
    if (events.length === 0) continue;
    const last = events[events.length - 1]!.ts;
    if (Date.parse(last) >= cutoff) continue;
    const tags = readNotes(opts.dir, id).tags;
    if (opts.keepTagged && tags.length > 0) continue;
    doomed.push({ id, last, tags });
  }
  if (doomed.length === 0) {
    console.log("nothing older than the cutoff.");
    return 0;
  }
  console.log(`${doomed.length} session(s) older than the cutoff:`);
  for (const d of doomed) {
    console.log(
      `  ${d.id}  last event ${d.last.slice(0, 16).replace("T", " ")}${d.tags.length > 0 ? `  [${d.tags.join(", ")}]` : ""}`,
    );
  }
  if (!(await confirm(`delete all ${doomed.length} permanently?`, opts.yes))) {
    console.log("nothing deleted.");
    return 1;
  }
  for (const d of doomed) removeSession(opts.dir, d.id);
  console.log(`deleted ${doomed.length} session(s)`);
  return 0;
}

interface LsRow {
  /**
   * Whether the stored log parses back into events — nothing more. `ls` does
   * not verify the hash chain (`agit verify` does), so a tampered log that
   * still parses is `readable: true`. Named for what it measures: a field
   * called `corrupt: false` would read as an integrity claim this never makes.
   */
  readable: boolean;
  /** Why the log could not be read, when readable is false. */
  reason?: string;
  id: string;
  started?: string;
  durationMs?: number;
  events?: number;
  files?: number;
  runtime?: string;
  /** Tags attached locally; they annotate a session and never touch its chain. */
  tags: string[];
}

function cmdLs(opts: Opts): number {
  if (!existsSync(opts.dir)) {
    console.error(`no such directory: ${opts.dir}`);
    return 1;
  }
  const ids = listSessionIds(opts.dir);
  if (ids.length === 0) {
    if (opts.json) process.stdout.write("[]\n");
    else console.log("no sessions imported yet (agit import <file>)");
    return 0;
  }
  const sortBy = opts.sort ?? "started";
  if (!["started", "events", "files", "id"].includes(sortBy)) {
    console.error(`unknown --sort ${JSON.stringify(sortBy)}; one of: started, events, files, id`);
    return 2;
  }
  // Show the shortest id prefix that is still unique here, the way git does.
  const prefixes = minimalPrefixes(ids);

  const built = ids.map((id) => {
    // One corrupt session must not take down the whole listing.
    let events;
    try {
      events = readSessionEvents(opts.dir, id);
      if (events.length === 0) throw new Error("empty log");
    } catch (err) {
      const row: LsRow = {
        id,
        readable: false,
        reason: err instanceof Error ? err.message : String(err),
        tags: [],
      };
      return { sortKey: 0, runtimeRaw: "", projectRaw: "", tags: [] as string[], row };
    }
    const first = events[0]!;
    const last = events[events.length - 1]!;
    const start = first.payload as { runtime?: unknown; cwd?: unknown };
    const runtimeRaw = typeof start.runtime === "string" ? start.runtime : "?";
    const cwd = typeof start.cwd === "string" ? start.cwd : "";
    const projectRaw =
      cwd === ""
        ? ""
        : (cwd
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() ?? "");
    const tags = readNotes(opts.dir, id).tags;
    const row: LsRow = {
      id,
      readable: true,
      started: first.ts,
      durationMs: Date.parse(last.ts) - Date.parse(first.ts),
      events: events.length,
      files: fileStateAt(events).size,
      runtime: runtimeRaw,
      tags,
    };
    return { sortKey: Date.parse(first.ts), runtimeRaw, projectRaw, tags, row };
  });

  // Filters apply to both renderings: a script narrowing by tag wants the same
  // set a human would see, not the whole store.
  const filtered = built.filter(
    (b) =>
      (opts.tag === undefined || b.tags.includes(opts.tag)) &&
      (opts.runtime === undefined || b.runtimeRaw === opts.runtime) &&
      (opts.project === undefined || b.projectRaw === opts.project),
  );
  filtered.sort((a, b) => {
    if (sortBy === "events") return (b.row.events ?? 0) - (a.row.events ?? 0);
    if (sortBy === "files") return (b.row.files ?? 0) - (a.row.files ?? 0);
    if (sortBy === "id") return a.row.id.localeCompare(b.row.id);
    return a.sortKey - b.sortKey;
  });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        filtered.map((b) => b.row),
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (filtered.length === 0) {
    console.log("no sessions match those filters.");
    return 0;
  }

  const displayRows = filtered.map((b) => {
    const short = prefixes.get(b.row.id)!;
    return !b.row.readable
      ? {
          id: short,
          started: "(corrupt — run `agit verify " + short + "`)",
          dur: "",
          events: "",
          files: "",
          runtime: "",
          tags: "",
        }
      : {
          id: short,
          started: b.row.started!.slice(0, 16).replace("T", " "),
          dur: humanDuration(b.row.durationMs!),
          events: String(b.row.events),
          files: String(b.row.files),
          runtime: b.row.runtime!,
          tags: b.tags.join(","),
        };
  });
  const anyTags = displayRows.some((r) => r.tags !== "");
  const cols = (
    anyTags
      ? ["id", "started", "dur", "events", "files", "runtime", "tags"]
      : ["id", "started", "dur", "events", "files", "runtime"]
  ) as readonly ("id" | "started" | "dur" | "events" | "files" | "runtime" | "tags")[];
  const widths = cols.map((c) => Math.max(c.length, ...displayRows.map((r) => r[c].length)));
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(widths[i]!)).join("  "));
  for (const r of displayRows) console.log(cols.map((c, i) => r[c].padEnd(widths[i]!)).join("  "));
  console.log("(files = lower bound: structured edits only — shell-driven changes are not tracked)");
  return 0;
}

/**
 * Remove a session from the store (issue #71). Requires --yes: there is no
 * interactive prompt to confirm against, so the flag itself is the
 * confirmation, the same way `docker rm -f` or `kubectl delete` ask for an
 * explicit flag rather than a y/n prompt a script can't answer.
 *
 * Does not check whether a fork elsewhere in the filesystem still points at
 * this session (fork.json names its source by id) — forks live in whatever
 * directory `--out` named, with no central registry agit could scan. That
 * would need one; it does not exist yet, and this command does not guess
 * at where forks might be.
 */
function cmdShow(opts: Opts): number {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);
  const meta = readSessionMeta(opts.dir, id);
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const start = first.payload as { [k: string]: unknown };

  const notes: SessionNotes = readNotes(opts.dir, id);

  const byType = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    if (e.type === "tool.call") {
      const name = (e.payload as { name?: unknown }).name;
      if (typeof name === "string") tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  const u = usageTotals(events);

  if (opts.json) {
    if (opts.byModel) {
      process.stdout.write(JSON.stringify(usageByModelJson(events), null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      JSON.stringify(
        {
          id,
          runtime: typeof start.runtime === "string" ? start.runtime : null,
          runtimeVersion: typeof start.runtimeVersion === "string" ? start.runtimeVersion : null,
          cwd: typeof start.cwd === "string" ? start.cwd : null,
          gitBranch: typeof start.gitBranch === "string" ? start.gitBranch : null,
          startedAt: first.ts,
          durationMs: Date.parse(last.ts) - Date.parse(first.ts),
          imported: meta ? { at: meta.importedAt, adapter: meta.adapter } : null,
          // Where an update to a pre-session file got its verified base, when
          // one was supplied (#85). null means none was.
          base: meta?.base ?? null,
          events: events.length,
          byType: Object.fromEntries(byType),
          tools: Object.fromEntries(tools),
          usage: { ...u, models: [...u.models] },
          files: [...fileStateAt(events).values()],
          redactions: meta?.redactions ?? {},
          // {} alone is ambiguous: a --no-redact import (#79) also leaves it
          // empty, so a consumer gating on redaction needs this to tell
          // "scanned, found nothing" from "never scanned".
          redactionSkipped: meta?.redaction?.enabled === false,
          // Local annotations: they describe a session without touching its
          // chain, and a script filtering `ls --json` by tag wants them here too.
          tags: notes.tags,
          note: notes.note ?? null,
        },
        null,
        2,
      ) + "\n",
    );
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
  if (meta?.base) {
    console.log(
      `  base        ${meta.base.kind} ${meta.base.ref} (${meta.base.files} files) — updates to files predating the session were verified against it`,
    );
  }
  if (notes.tags.length > 0) console.log(`  tags        ${notes.tags.join(", ")}`);
  if (notes.note) console.log(`  note        ${notes.note}`);

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
        `    ${f.deletedAtSeq !== undefined ? "D" : f.kind === "create" ? "A" : "M"} ${f.path}  (+${f.added} -${f.removed}, ${f.edits} edit${f.edits === 1 ? "" : "s"})${f.deletedAtSeq !== undefined ? ` [deleted at seq ${f.deletedAtSeq}]` : ""}${diverged}`,
      );
    }
  }
  if (meta?.redaction?.enabled === false) {
    console.log("  redactions  SKIPPED at import (--no-redact) — share/pr need --allow-unredacted");
  } else if (meta && Object.keys(meta.redactions).length > 0) {
    console.log(
      `  redactions  ${Object.entries(meta.redactions)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ")}`,
    );
  }
  return 0;
}

/** usageByModel's ModelUsage carries a Set — swap it for an array/count so JSON.stringify needs no help. */
function usageByModelJson(events: AgitEvent[]): {
  model: string;
  apiMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  files: string[];
}[] {
  return usageByModel(events).map((r) => ({
    model: r.model,
    apiMessages: r.apiMessages,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadInputTokens: r.cacheReadInputTokens,
    cacheCreationInputTokens: r.cacheCreationInputTokens,
    files: [...r.files],
  }));
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
  const calls = rows.reduce((n, r) => n + r.apiMessages, 0);
  if (calls === 0) {
    // No tokens to split; say what is known instead of printing a row of zeros.
    const touched = rows.reduce((n, r) => n + r.files.size, 0);
    const credited = rows.map((r) => r.model).filter((m) => m !== "(unattributed)");
    console.log(
      `\nno cost events in this session — ${touched} file${touched === 1 ? "" : "s"} touched` +
        (credited.length > 0
          ? `, credited to ${credited.join(", ")} (the only model named)`
          : ", no model to credit"),
    );
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

/**
 * `agit sign <id> --key <file>` (#68) — bind a head to a key someone holds.
 *
 * The chain proves a log was not modified after it was chained; it says
 * nothing about who chained it, since anyone can build a fresh valid chain
 * over edited content. A signature over (session, head, count, time) is the
 * missing half.
 *
 * Refuses to sign a log that does not verify. Signing a broken chain would
 * put a real identity behind bytes agit itself cannot vouch for, which is
 * worse than leaving it unsigned.
 */
function cmdSign(opts: Opts): number {
  const id = requireId(opts);
  if (opts.key === undefined) {
    console.error("usage: agit sign <id> --key <path-to-ed25519-key>");
    console.error("no key? ssh-keygen -t ed25519 -N '' -f agit-signing-key");
    return 2;
  }

  const meta = readSessionMeta(opts.dir, id);
  if (meta === null) {
    console.error(`${id} has no meta.json, so there is no recorded head to sign`);
    return 1;
  }
  const res = verifyChain(readSessionLines(opts.dir, id), meta);
  if (!res.ok) {
    console.error(`refusing to sign ${id}: its chain does not verify`);
    console.error(`BROKEN at seq ${res.firstBroken!.seq}: ${res.firstBroken!.reason}`);
    console.error("A signature over a log agit cannot vouch for puts your name behind bytes nobody checked.");
    return 1;
  }

  let key;
  try {
    key = loadPrivateKey(readFileSync(resolve(opts.key), "utf8"));
  } catch (e) {
    console.error(e instanceof KeyError ? e.message : `cannot read ${opts.key}: ${String(e)}`);
    return 1;
  }

  const at = new Date().toISOString();
  const signature = signHead(key, {
    agitSignature: SIGNATURE_PAYLOAD_VERSION,
    sessionId: id,
    headHash: meta.headHash,
    eventCount: meta.eventCount,
    at,
  });

  // Re-signing with the same key replaces that key's signature rather than
  // stacking duplicates; a different key appends, because two people signing
  // the same head is the point.
  const kept = (meta.signatures ?? []).filter((s) => s.keyFingerprint !== signature.keyFingerprint);
  writeSessionMeta(opts.dir, id, { ...meta, signatures: [...kept, signature] });

  console.log(`signed ${id} with ${signature.keyFingerprint}`);
  console.log(`  head  ${meta.headHash.slice(0, 16)}… over ${meta.eventCount} events`);
  console.log(`  at    ${at} (the time you claim, signed so it cannot be edited — not proof of when)`);
  if (kept.length > 0) console.log(`  ${kept.length} other signature(s) on this head kept`);
  return 0;
}

/** Report every signature on a head, for `verify`. */
function signatureLines(meta: SessionMeta | undefined, sessionId: string): string[] {
  const sigs = meta?.signatures ?? [];
  if (meta === undefined || sigs.length === 0)
    return ["unsigned (agit sign <id> --key <file> binds this head to a key)"];
  return sigs.map((s) => {
    const v = verifySignature(s, {
      sessionId,
      headHash: meta.headHash,
      eventCount: meta.eventCount,
    });
    return v.ok
      ? `signed by ${v.fingerprint} at ${v.at}`
      : `SIGNATURE DOES NOT MATCH (${s.keyFingerprint}): ${v.reason}`;
  });
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
  // A signature is checked against the head agit holds, so it is only
  // meaningful alongside the chain result — never instead of it.
  const head = {
    sessionId: meta?.sessionId ?? "",
    headHash: meta?.headHash ?? "",
    eventCount: meta?.eventCount ?? 0,
  };
  const sigs = (meta?.signatures ?? []).map((s) => ({
    keyFingerprint: s.keyFingerprint,
    at: s.at,
    ...verifySignature(s, head),
  }));

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ...res,
          hasMeta: meta !== undefined,
          signed: sigs.length > 0,
          signatures: sigs,
        },
        null,
        2,
      ) + "\n",
    );
    // A signature that does not match is a failure even when the chain is
    // intact: something claimed this head and the claim does not hold.
    return res.ok && sigs.every((s) => s.ok) ? 0 : 1;
  }
  if (res.ok) {
    console.log(
      `ok: ${res.events} events, chain intact${meta ? ", matches meta.json head" : " (no meta.json — truncation not checkable)"}`,
    );
    for (const line of signatureLines(meta, meta?.sessionId ?? "")) {
      if (line.startsWith("SIGNATURE DOES NOT MATCH")) console.error(line);
      else console.log(line);
    }
    return sigs.every((s) => s.ok) ? 0 : 1;
  }
  console.error(`BROKEN at seq ${res.firstBroken!.seq}: ${res.firstBroken!.reason}`);
  console.error(`${res.events} events verified before the break`);
  for (const line of signatureLines(meta, meta?.sessionId ?? "")) console.error(line);
  return 1;
}

async function cmdReplay(opts: Opts): Promise<number> {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);

  if (opts.timeline || (opts.at === undefined && !process.stdin.isTTY)) {
    for (const line of timelineLines(events)) console.log(line);
    return 0;
  }

  if (opts.at !== undefined && (!Number.isInteger(opts.at) || opts.at < 0 || opts.at >= events.length)) {
    console.error(`--at ${opts.at} is outside this session (0..${events.length - 1})`);
    return 2;
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
    printDiff(
      opts,
      diffSessions({
        a: { events: parent, label: info.sourceSession.slice(0, 8) },
        b: forkSide,
        from: { seq: info.atSeq, hash: info.atHash },
      }),
    );
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
  printDiff(
    opts,
    diffSessions({
      a: { events: readSessionEvents(opts.dir, idA), label: idA.slice(0, 8) },
      b: { events: readSessionEvents(opts.dir, idB), label: idB.slice(0, 8) },
    }),
  );
  return 0;
}

function printDiff(opts: Opts, diff: ReturnType<typeof diffSessions>): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
    return;
  }
  for (const line of renderDiff(diff)) console.log(line);
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
  // The fork's own session, when the user names it: only its file.delete
  // events can make a merge remove anything.
  let forkEvents: AgitEvent[] | undefined;
  if (opts.session !== undefined) {
    try {
      forkEvents = readSessionEvents(opts.dir, resolveSessionId(opts.dir, opts.session));
    } catch (err) {
      console.error(`--session ${opts.session}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const { results, conflicts, deleted, engines } = mergeFork({
    forkDir,
    intoDir,
    sourceEvents: events,
    summary: opts.summary,
    forkEvents,
    noGit: opts.noGit,
  });

  console.log(`merging fork of ${info.sourceSession} (at event ${info.atSeq}) into ${intoDir}`);
  for (const r of results) console.log(`  ${r.outcome.padEnd(18)} ${r.rel}`);
  if (deleted > 0) {
    console.log(
      `${deleted} file${deleted === 1 ? "" : "s"} deleted, as ${opts.session} recorded after the fork point.`,
    );
  }
  if (forkEvents === undefined) {
    console.log("  (no --session: a file absent from the fork tree counts as untouched, never deleted)");
  }
  if (engines.includes("builtin")) {
    // Say which engine ran: the results are a merge someone will act on, and
    // git's are what their expectations are calibrated against.
    console.log(
      opts.noGit
        ? "  (content merges used agit's built-in three-way merge, as --no-git asked)"
        : "  (git merge-file was not on PATH; content merges used agit's built-in three-way merge)",
    );
  }
  console.log(
    conflicts > 0
      ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} — standard markers are in the files, and files the fork deleted but the target had changed were left in place; finish by hand.`
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
  if (!refuseUnredacted(opts, id, "hand off")) return 1;
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

/**
 * Token and API-call totals across the whole store (issue #67).
 *
 * A fold over the `cost` events sessions already carry, so nothing new is
 * recorded. Money is only ever shown against a rate table the user supplies
 * (`--price`): prices change and vary by account, and a wrong number here
 * would be worse than no number.
 */
function cmdStats(opts: Opts): number {
  if (!existsSync(opts.dir)) {
    console.error(`no such directory: ${opts.dir}`);
    return 1;
  }
  const by = opts.by ?? "day";
  if (!isGroupBy(by)) {
    console.error(`unknown --by ${JSON.stringify(by)}; one of: ${GROUP_BY.join(", ")}`);
    return 2;
  }
  let prices: PriceTable | undefined;
  if (opts.price !== undefined) {
    try {
      prices = parsePriceTable(readFileSync(resolve(opts.price), "utf8"));
    } catch (err) {
      console.error(
        err instanceof PriceTableError
          ? `--price ${opts.price}: ${err.message}`
          : `--price ${opts.price}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }
  }

  const sessions = [];
  for (const id of listSessionIds(opts.dir)) {
    try {
      sessions.push({ id, events: readSessionEvents(opts.dir, id) });
    } catch {
      // One corrupt session must not take down the whole report.
      console.error(`skipping ${id.slice(0, 8)}: unreadable (agit verify it)`);
    }
  }
  if (sessions.length === 0) {
    if (opts.json) process.stdout.write(JSON.stringify({ by, rows: [], totals: null }, null, 2) + "\n");
    else console.log("no sessions imported yet (agit import <file>)");
    return 0;
  }

  const res = computeStats(sessions, { by, sinceMs: opts.since, prices });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ by, since: opts.since ?? null, ...res }, null, 2) + "\n");
    return 0;
  }

  const money = (r: StatsRow): string =>
    prices === undefined ? "" : r.cost === undefined ? "—" : r.cost.toFixed(2);
  const n = (x: number): string => x.toLocaleString("en-US");
  const cell = (r: StatsRow): Record<string, string> => ({
    key: r.key,
    calls: r.costRecorded ? n(r.apiCalls) : "—",
    in: r.costRecorded ? n(r.inputTokens) : "—",
    out: r.costRecorded ? n(r.outputTokens) : "—",
    cacheRead: r.costRecorded ? n(r.cacheReadInputTokens) : "—",
    cacheWrite: r.costRecorded ? n(r.cacheCreationInputTokens) : "—",
    sessions: n(r.sessions),
    files: n(r.files),
    ...(prices ? { cost: money(r) } : {}),
  });

  // The column list is declared, not read back off the header object. Deriving
  // it from the object made the object its own schema, so losing a property
  // lost a column with nothing to complain — which is how five of these went
  // missing once. `Record<StatsCol, string>` makes that a compile error.
  const STATS_COLS = ["key", "calls", "in", "out", "cacheRead", "cacheWrite", "sessions", "files"] as const;
  type StatsCol = (typeof STATS_COLS)[number] | "cost";
  const head: Record<(typeof STATS_COLS)[number], string> & { cost?: string } = {
    key: by.toUpperCase(),
    calls: "CALLS",
    in: "IN",
    out: "OUT",
    cacheRead: "CACHE READ",
    cacheWrite: "CACHE WRITE",
    sessions: "SESSIONS",
    files: "FILES",
    ...(prices ? { cost: prices.currency ? `COST (${prices.currency})` : "COST" } : {}),
  };
  const cols: StatsCol[] = prices ? [...STATS_COLS, "cost"] : [...STATS_COLS];
  const table = [...res.rows.map(cell), cell(res.totals)];
  table[table.length - 1]!.key = "total";
  const widths = cols.map((c) => Math.max(head[c]!.length, ...table.map((r) => r[c]!.length)));
  const line = (r: Record<string, string>): string =>
    cols.map((c, i) => (c === "key" ? r[c]!.padEnd(widths[i]!) : r[c]!.padStart(widths[i]!))).join("  ");

  console.log(line(head));
  for (const r of table.slice(0, -1)) console.log(line(r));
  console.log(line(table[table.length - 1]!));

  // A dash is not a zero: say which it is.
  if (res.rows.some((r) => !r.costRecorded)) {
    console.log("\n— = no cost events recorded for that group; its token counts are unknown, not zero.");
  }
  // Grouping by model or day keys off the cost event, so a session that
  // records none is in the total and in no row. Say so, or the columns look
  // like they simply fail to add up.
  if (res.unattributedSessions > 0) {
    const n = res.unattributedSessions;
    console.log(
      `\n${n} session(s) recorded no cost events, so they appear in the total but in no ${by} row.` +
        `\nUse --by runtime or --by project to see them.`,
    );
  }
  const unpriced = res.totals.unpriced ?? [];
  if (unpriced.length > 0) {
    console.log(`no rate in the price table for: ${unpriced.join(", ")} — those rows are uncosted.`);
  }
  if (prices === undefined) {
    console.log("\n(no money shown: pass --price <file> with your own rate table. See README.)");
  }
  if (res.skippedBySince > 0) {
    console.log(`${res.skippedBySince} session(s) outside --since were not counted.`);
  }
  console.log("(files = lower bound: structured edits only — shell-driven changes are not tracked)");
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
/** Every readable session in the store, for the folds that span all of them. */
function allSessions(opts: Opts): { id: string; events: AgitEvent[] }[] {
  const out: { id: string; events: AgitEvent[] }[] = [];
  for (const id of listSessionIds(opts.dir)) {
    try {
      out.push({ id, events: readSessionEvents(opts.dir, id) });
    } catch {
      console.error(`skipping ${id.slice(0, 8)}: unreadable (agit verify it)`);
    }
  }
  return out;
}

/**
 * Match a file argument against the paths the logs recorded.
 *
 * Logs hold absolute paths from whatever machine ran the session, so an exact
 * match is the exception. A suffix match on path segments is what actually
 * works, and an ambiguous one is reported rather than picked.
 */
function resolveLoggedPath(
  sessions: { id: string; events: AgitEvent[] }[],
  arg: string,
): { path: string } | { error: string } {
  const wanted = arg.replace(/\\/g, "/").replace(/^\.\//, "");
  const seen = new Set<string>();
  for (const { events } of sessions) {
    for (const e of events) {
      if (e.type !== "file.diff" && e.type !== "file.delete") continue;
      const p = (e.payload as { path?: Json }).path;
      if (typeof p === "string") seen.add(p);
    }
  }
  if (seen.has(arg)) return { path: arg };
  const matches = [...seen].filter((p) => {
    const norm = p.replace(/\\/g, "/");
    return norm === wanted || norm.endsWith("/" + wanted);
  });
  if (matches.length === 1) return { path: matches[0]! };
  if (matches.length === 0) {
    return { error: `no structured edit to ${JSON.stringify(arg)} in any imported session` };
  }
  return { error: `${JSON.stringify(arg)} is ambiguous:\n  ${matches.join("\n  ")}` };
}

function cmdBlame(opts: Opts): number {
  const arg = opts.args[0];
  if (!arg) {
    console.error("usage: agit blame <file>");
    return 2;
  }
  const sessions = allSessions(opts);
  const found = resolveLoggedPath(sessions, arg);
  if ("error" in found) {
    console.error(found.error);
    return 1;
  }
  const res = blameFile(sessions, found.path);
  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return 0;
  }
  const width = 8;
  console.log(`${found.path}  (${res.sessions.length} session(s) touched it)`);
  for (const l of res.lines) {
    const who =
      l.session === null
        ? "(no structured edit)".padEnd(width + 7)
        : `${l.session.slice(0, width).padEnd(width)} @${String(l.seq).padStart(5)}`;
    console.log(`${who}  ${String(l.line).padStart(4)}  ${clipLine(l.text, 120)}`);
  }
  if (res.divergedAtSeq !== undefined) {
    console.log(
      `\nblame stops at seq ${res.divergedAtSeq} of ${res.divergedIn?.slice(0, 8)}: that edit did not fit the content agit held,\n` +
        "which is proof the file changed outside structured edits (SPEC §5.7). Lines above are still verified;\n" +
        "everything after is not knowable from the log, so it is not guessed at.",
    );
  }
  console.log("(lines a shell command wrote left no structured edit and carry no attribution)");
  return 0;
}

function cmdWhy(opts: Opts): number {
  const arg = opts.args[0];
  const m = /^(.*):(\d+)$/.exec(arg ?? "");
  if (!m) {
    console.error("usage: agit why <file>:<line>");
    return 2;
  }
  const [, fileArg, lineArg] = m;
  const sessions = allSessions(opts);
  const found = resolveLoggedPath(sessions, fileArg!);
  if ("error" in found) {
    console.error(found.error);
    return 1;
  }
  const res = blameFile(sessions, found.path);
  const origin: LineOrigin | undefined = res.lines[Number(lineArg) - 1];
  if (origin === undefined) {
    console.error(`${found.path} has ${res.lines.length} line(s); ${lineArg} is outside it`);
    return 1;
  }
  if (origin.session === null) {
    console.log(`${found.path}:${lineArg}  ${clipLine(origin.text, 120)}`);
    console.log("\n(no structured edit) — nothing in the store wrote this line; a shell command may have.");
    return 0;
  }
  const events = sessions.find((s) => s.id === origin.session)!.events;
  const why = whyLine(events, origin);
  if (opts.json) {
    process.stdout.write(JSON.stringify(why, null, 2) + "\n");
    return 0;
  }
  console.log(`${found.path}:${origin.line}  ${clipLine(origin.text, 120)}`);
  console.log(`\nwritten by  ${origin.session} @${origin.seq}  (${origin.ts})`);
  console.log(`\nasked for by:\n${indentClip(why.prompt ?? "(no user message before it)", 20)}`);
  if (why.rationale) console.log(`\nthe assistant said:\n${indentClip(why.rationale, 12)}`);
  console.log(
    `\nverify it: agit verify ${origin.session} && agit replay ${origin.session} --at ${origin.seq}`,
  );
  return 0;
}

/**
 * The commit trailer that anchors a commit to a session.
 *
 * Printed rather than written: which commit this belongs to, and whether it
 * goes through a hook or an editor, is the user's business — and a verb that
 * silently rewrites a commit message is a surprise nobody asked for.
 */
function cmdLink(opts: Opts): number {
  const sessions = allSessions(opts);
  if (sessions.length === 0) {
    console.error("no sessions imported yet (agit import <file>)");
    return 1;
  }
  let chosen: { id: string; events: AgitEvent[] } | undefined;
  const target = opts.args[0];
  // A bare argument is a session id if one matches, and a file otherwise.
  const asSession = (() => {
    if (target === undefined) return undefined;
    try {
      return resolveSessionId(opts.dir, target);
    } catch {
      return undefined;
    }
  })();
  if (asSession !== undefined) {
    chosen = sessions.find((s) => s.id === asSession);
  } else if (target !== undefined) {
    // A file: the session whose latest structured edit to it is most recent.
    const found = resolveLoggedPath(sessions, target);
    if ("error" in found) {
      console.error(found.error);
      return 1;
    }
    let best: { s: { id: string; events: AgitEvent[] }; ts: string } | null = null;
    for (const s of sessions) {
      for (const e of s.events) {
        if (e.type !== "file.diff" && e.type !== "file.delete") continue;
        if ((e.payload as { path?: Json }).path !== found.path) continue;
        if (best === null || e.ts > best.ts) best = { s, ts: e.ts };
      }
    }
    chosen = best?.s;
  } else {
    // Nothing named: the most recently started session in the store.
    chosen = [...sessions].sort((a, b) => a.events[0]!.ts.localeCompare(b.events[0]!.ts)).pop();
  }
  if (chosen === undefined) {
    console.error("no session matched; name a session id or a file one of them edited");
    return 1;
  }
  const last = chosen.events[chosen.events.length - 1]!;
  console.log(sessionTrailer(chosen.id, last.seq, last.hash));
  return 0;
}

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
  if (opts.grepType !== undefined && !isEventType(opts.grepType)) {
    console.error(`unknown event type ${JSON.stringify(opts.grepType)}; one of: ${EVENT_TYPES.join(", ")}`);
    return 2;
  }
  if (opts.grepPath && opts.grepType !== undefined && !["file.diff", "file.delete"].includes(opts.grepType)) {
    console.error(
      `--path searches file.diff and file.delete paths; it cannot combine with --type ${opts.grepType}`,
    );
    return 2;
  }

  let ids = listSessionIds(opts.dir);
  if (opts.tag !== undefined) ids = ids.filter((id) => readNotes(opts.dir, id).tags.includes(opts.tag!));
  if (ids.length === 0) {
    console.log(
      opts.tag !== undefined
        ? `no sessions tagged ${JSON.stringify(opts.tag)}`
        : "no sessions imported yet (agit import <file>)",
    );
    if (opts.json) return 0; // NDJSON: zero lines is zero results, nothing more to say.
    console.log("no sessions imported yet (agit import <file>)");
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
      if (opts.json) process.stdout.write(JSON.stringify(hit) + "\n");
      else console.log(renderHit(hit, idWidth));
      total++;
    }
  }
  if (opts.json) return total === 0 ? 1 : 0;
  if (total === 0) {
    console.error(`no matches in ${searched} session${searched === 1 ? "" : "s"}`);
    return 1;
  }
  return 0;
}

function cmdExport(opts: Opts): number {
  const id = requireId(opts);
  if (!refuseUnlessVerified(opts, id, "export", "nothing was written")) return 1;

  // Interop views (#69). Both are folds over the events already stored, and
  // both refuse an unverified session for the same reason `export` does:
  // feeding an eval or a dashboard from a log agit cannot vouch for is how a
  // verified pipeline quietly stops being one.
  if (opts.otel || opts.atif) {
    if (opts.otel && opts.atif) {
      console.error("--otel and --atif are different formats; pick one");
      return 2;
    }
    const events = readSessionEvents(opts.dir, id);
    const meta = readSessionMeta(opts.dir, id);
    const doc = opts.otel ? toOtlpJson(events, meta) : toAtif(events, meta);
    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    return 0;
  }

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
  // A self-contained page exists to be handed to someone else, the same as a
  // `pr` bundle — so it takes the same gate. `export` to stdout deliberately
  // does not: it is how you read a session to decide whether it is safe, and
  // the refusal itself tells you to go and check.
  if (!refuseUnredacted(opts, id, "export")) return 1;

  const all = readSessionEvents(opts.dir, id);
  if (opts.at !== undefined && (!Number.isInteger(opts.at) || opts.at < 0 || opts.at >= all.length)) {
    console.error(`--at ${opts.at} is outside this session (0..${all.length - 1})`);
    return 2;
  }
  const at = opts.at;
  const events = at === undefined ? all : all.filter((e) => e.seq <= at);
  const outPath = resolve(opts.out ?? `agit-${id.slice(0, 8)}${at === undefined ? "" : `-at${at}`}.html`);

  if (existsSync(outPath)) {
    console.error(`refusing to overwrite existing ${outPath} — pass a fresh --out`);
    return 1;
  }

  // meta.json describes the whole log; a prefix must not claim its head.
  const html = renderSessionHtml(events, at === undefined ? meta : null);
  writeFileSync(outPath, html, "utf8");
  const bytes = Buffer.byteLength(html, "utf8");

  console.log(`exported session ${id} to:`);
  console.log(`  ${outPath}`);
  console.log(
    `  ${events.length} events${at === undefined ? "" : ` (of ${all.length}, up to --at ${at})`}, ${(bytes / 1e6).toFixed(1)} MB`,
  );
  if (bytes > 10e6) console.log("  large page — the viewer renders every event; --at N exports a prefix");
  console.log("  self-contained HTML — no network or external resources");

  return 0;
}

/** Loopback needs no transport security; anything else carries share traffic over a network. */
function isLoopback(host: string): boolean {
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1 — binding
  // 127.0.0.2 is as private as the default, and calling it "beyond loopback"
  // in the warning would be untrue.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Serve the store to an agent over MCP (issue #66), stdio, read-only.
 *
 * Every human-facing word goes to stderr: stdout is the protocol frame
 * stream, and one stray line on it is a parse error at the client.
 */
async function cmdMcp(opts: Opts): Promise<number> {
  if (!existsSync(agitDir(opts.dir))) {
    // Not fatal. A client may start the server before anything is imported,
    // and the tools answer "no sessions" perfectly well from an empty store.
    console.error(`no .agit/ in ${opts.dir} yet — the tools will report an empty store until you import one`);
  }
  setServerVersion(packageVersion());
  console.error(`agit mcp: read-only over ${agitDir(opts.dir)} — waiting for a client on stdio`);
  await serveMcp(opts.dir, process.stdin, process.stdout);
  return 0;
}

/** The published version, for MCP's serverInfo. Falls back rather than throwing. */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli.js -> the package root is one level up; running from src, two.
    for (const rel of ["../package.json", "../../package.json"]) {
      const p = resolve(here, rel);
      if (!existsSync(p)) continue;
      const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
      if (typeof v === "string") return v;
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

async function cmdRelay(opts: Opts): Promise<number> {
  const host = opts.host ?? "127.0.0.1";

  if ((opts.cert === undefined) !== (opts.key === undefined)) {
    console.error("--cert and --key go together: a relay is HTTPS or it is HTTP, not half of one");
    return 2;
  }
  let tls: { cert: string; key: string } | undefined;
  if (opts.cert !== undefined && opts.key !== undefined) {
    try {
      tls = { cert: readFileSync(opts.cert, "utf8"), key: readFileSync(opts.key, "utf8") };
    } catch (err) {
      console.error(`cannot read the TLS material: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  // Exposing a plaintext relay should be a deliberate act, not a default. The
  // link is the only secret a viewer holds, and without TLS it crosses the
  // network in the clear along with every event the share carries.
  if (tls === undefined && !isLoopback(host) && !opts.insecure) {
    console.error(
      `refusing to bind ${host} without TLS: share links and every event would cross the network in the clear.\n` +
        "Pass --cert and --key to serve HTTPS, put a TLS proxy in front and keep the relay on loopback,\n" +
        "or pass --insecure if the network is genuinely trusted.",
    );
    return 2;
  }

  let handle;
  try {
    handle = await startRelay({
      port: opts.port,
      host: opts.host,
      trustedProxies: opts.trustedProxies,
      tls,
    });
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      console.error(
        `port ${opts.port ?? 7717} is already in use (another relay?) — pass --port <n> to use a different one`,
      );
      return 1;
    }
    throw err;
  }
  console.log(`agit relay listening on ${handle.scheme}://${host}:${handle.port}`);
  console.log("shares are held in memory only; nothing is written to disk. Ctrl+C to stop.");
  if (!isLoopback(host)) {
    console.log(
      handle.scheme === "https"
        ? "NOTE: bound beyond loopback over TLS — anyone who can reach this port can view shares they have links for."
        : "NOTE: bound beyond loopback WITHOUT TLS (--insecure) — share links and events are readable by anyone on the path.",
    );
  }
  if (handle.scheme === "https") {
    console.log(`  share against it with: agit share <id> --relay https://${host}:${handle.port}`);
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
  const shareCfg = redactionConfigFor(opts);
  if (shareCfg === null) return 2;
  if (!shareCfg.enabled && !opts.allowUnredacted) {
    console.error("refusing to share with --no-redact; pass --allow-unredacted to mean it.");
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
      // the one that must never publish a chain that does not verify — or
      // one that was imported with --no-redact and never scanned.
      if (!refuseUnlessVerified(opts, id, "share", "nothing was published")) return 1;
      if (!refuseUnredacted(opts, id, "share")) return 1;
      if (!refuseUnredacted(opts, id, "share")) return 1;
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
    for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts, shareCfg);
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
        `  ${f.deletedAtSeq !== undefined ? "D" : f.kind === "create" ? "A" : "M"} ${f.path}  (+${f.added} -${f.removed})  ${f.deletedAtSeq !== undefined ? "no content" : `content sha256 ${f.afterHash.slice(0, 12)}`} @ seq ${f.lastSeq}${f.deletedAtSeq !== undefined ? ` [deleted at seq ${f.deletedAtSeq}]` : ""}${diverged}`,
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
  if (!existsSync(opts.dir)) {
    console.error(`no such directory: ${opts.dir}`);
    process.exit(1);
  }
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
