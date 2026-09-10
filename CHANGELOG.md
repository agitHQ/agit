# Changelog

Notable changes to agit. The event format itself is versioned separately
(SPEC.md §11); a spec bump is always called out here in bold.

## Unreleased

### Added

- **Relay TLS** (#87): `agit relay --cert <pem> --key <pem>` serves HTTPS,
  and share links carry `https://` accordingly. Binding beyond loopback
  without TLS is refused unless `--insecure` says the network is trusted,
  and that case prints what it costs rather than passing silently. The
  whole `127.0.0.0/8` block counts as loopback, so a relay on `127.0.0.2`
  is treated as privately as the default.
- **Codex renames are recorded** (#86) as a `file.delete` of the old path
  plus a `file.diff` create of the new one — what the filesystem saw, and
  the same shape the OpenClaw adapter emits, so no view needs a
  Codex-specific case. A rename whose base content is not in the log is
  still skipped and counted rather than hashed on a guess.
- **`agit rm <id> --yes`** (#71) removes a session from the store. The flag
  is the confirmation — there is no prompt a script could answer — and
  without it `rm` reports what it would delete, including when the log is
  too corrupt to summarize, and exits 2. It does not attempt to find forks
  that point at the session: they live in whatever directory `--out` named
  and there is no registry to scan, so the command says so instead of
  guessing.
- **`agit stats`** (#67) — usage across the whole store, grouped `--by
  model` (default) or `--by runtime`, with `--json`. A fold over the `cost`
  events sessions already carry: no new event types, nothing recorded that
  was not already there. A runtime that logs no cost events shows as zeros
  rather than being dropped, and unreadable sessions are counted and named
  in the output instead of silently narrowing the totals. No `--since`
  window and no price table yet; both are still open on #67.
- **`--json` on every read verb** (#73): `ls`, `show`, `show --by-model`,
  `verify`, `grep` and `diff` emit the structures the code already builds —
  full session ids, ISO timestamps and real numbers rather than the padded
  display strings — so what a script reads is what the table renders.
  `grep --json` is NDJSON, one hit per line; everything else is one
  document. Exit codes and human output are unchanged, and errors stay on
  stderr so a pipe into `jq` is always clean. `ls --json` reports
  `readable` rather than a `corrupt` flag that never consults the hash
  chain, and carries the reason when a log cannot be read; `show --json`
  reports `redactionSkipped`, because a `--no-redact` import also leaves
  `redactions` empty and a consumer gating on it needs to tell the two
  apart.
- **`agit import --no-redact`** (#70) stores a session verbatim when the
  credential patterns would mangle content you need intact. `meta.json`
  records that the scan was skipped, and `share`, `pr` and `export-html`
  refuse such a session until `--allow-unredacted` says you have read it
  yourself. Adopting a bundle from a `--no-redact` origin says so plainly —
  the recipient has the least context and adoption is the one moment agit
  speaks to them. Re-importing the same file with the mode flipped now
  actually re-imports: the "already imported" check compares redaction mode
  as well as the source bytes, so re-importing without the flag is the cure
  for an accidental `--no-redact` rather than a no-op that reports success.

## 0.5.0 — 2026-09-09

### Changed

- **Schema v2: `file.delete`** (#30, #51). A ninth event type records a
  structured deletion with the SHA-256 of the content removed, so `fork` and
  `diff` no longer write a deleted file back, `replay --state` and `show`
  mark it `D`, and `grep --path` finds it. The Codex adapter emits it from
  `apply_patch` deletions, preferring the content Codex recorded at deletion
  over agit's own reconstruction. **Every existing v1 log keeps working**:
  readers accept v1 and v2, a v1 log simply cannot contain `file.delete`,
  and nothing is rewritten — v1 hashes still recompute. New logs are
  written as v2.

### Fixed

- **Redaction no longer misses a key glued to a preceding identifier**
  (#53). Patterns with a distinctive prefix (`sk-ant-`, `sk-proj-`, `ghp_`,
  `github_pat_`, `AKIA`, `xoxb-`, `AIza`, `sk_live_`, `npm_`) drop their
  leading word-boundary anchor — the prefix is the boundary. The generic
  `sk-` shape keeps its anchor so ordinary hyphenated words survive.
- **`fork` says why a file could not be rebuilt, in words that are true**
  (#55): it distinguishes "no recorded originalFile" from "the recorded
  originalFile does not hash to beforeHash", and when the payload carries a
  redaction marker it says so — a redacted diff can never reproduce a hash
  recorded before redaction.
- **`show --by-model` attributes Codex edits** (#56). Codex names the model
  on the assistant message that ends a turn, after its tool calls; an edit
  with nothing before it now looks forward to the end of its turn, and a
  session naming exactly one model credits everything to it. A session with
  no cost events prints a sentence instead of a row of zeros.
- **`grep --type` rejects unknown event types** with the list of real ones,
  and `--path` refuses a contradicting `--type` (#57).
- **CLI hygiene** (#58): `replay --at` outside the session is refused like
  `fork` instead of silently clamped; a `--dir` that does not exist is named
  instead of reading as an empty store; `agit diff <fork-dir>` counts work
  since the fork point, as its header says; the `grep` help line fits its
  column.
- **`export-html --at N`** exports the prefix up to event N, and the command
  reports the page size with a hint above 10 MB (#59).
- **`share` and `export` no longer publish a chain that does not verify**
  (#54). Every verb that publishes or hands off a stored session — `share`,
  `export`, `export-html`, `fork`, `pr` — now goes through one gate that
  refuses outright and names the failing check and the event it failed at:
  `refusing to share: chain verification failed — event 1: hash does not
  recompute`. The gate reads `meta.json` too, so a truncated log is caught
  everywhere, not only by `verify`. Live shares are unaffected: they build
  their chain as they tail the native log.

### Added

- **OpenClaw file edits** (#6, #52). The adapter now emits `file.diff` and
  `file.delete` from the `apply_patch` text OpenClaw records, parsed with the
  runtime's own grammar and applied with its own matching rules, so the
  hashes are over the bytes the runtime wrote. Only files the tool's result
  confirms are emitted; updates to files that predate the session, failed
  patches, no-ops and unparseable input are skipped and counted. A rename is
  recorded as a delete plus a create.
- **`agit import --all` and `--latest`** (#60). Discovery of the supported
  runtimes' own log directories — Claude Code, Codex, OpenClaw — importing
  what is new and reporting what grew (`updated 22 → 40 events`). A
  directory listing plus the ordinary import: no daemon, no hooks, no
  watcher, and retroactive import stays the default. `--since 7d` bounds
  the scan. "New" is exact, not heuristic: each stored session's `meta.json`
  records the sha256 of its source, so a second `agit import <file>` now
  says `unchanged` instead of silently re-importing, and a missing file is
  named instead of surfacing as a raw ENOENT.

- **`agit import` adopts agit bundles**, closing the receiving half of
  `agit pr` (#28): hand someone a bundle directory or a bare `events.jsonl`
  and they can replay, fork and verify it like any other session. The log
  is verified before it is stored and kept byte for byte, so the sender's
  hashes stay valid; a tampered, truncated or malformed log is refused, and
  a session id that already exists with different content is never
  overwritten. Re-adopting the same bundle is a no-op. Redaction is not
  re-run — that would change bytes and break every hash downstream — so the
  output says plainly that redaction was the origin's. A bundle without
  `meta.json` gets none invented for it.

## 0.4.1 — 2026-09-08

### Changed

- README: the Codex limits are four scannable bullets instead of one long
  paragraph — the verification window on updates, skipped deletions and
  renames, and encrypted reasoning each stand alone. The heading no longer
  says the Codex adapter is shallower than the Claude Code one; it emits
  hash-verified diffs and is constrained differently.
- README: states plainly how agit differs from observability platforms —
  those instrument agents with an SDK and show what that instrumentation
  captured; agit reads logs the runtime already wrote and can prove when
  they are incomplete.

## 0.4.0 — 2026-09-08

### Added

- **Codex file edits become real `file.diff` events.** The adapter maps
  structured `apply_patch` data on both paths Codex persists it
  (`patch_apply_end` in Legacy history mode, `item_completed` ->
  `TurnItem::FileChange` in Paginated), so `replay --state` and `fork` work
  on Codex sessions instead of producing nothing. Adds are hashed exactly
  from their recorded content; updates are hashed only while agit already
  holds the file from earlier in the same session. Updates to files that
  predate the session, deletions, renames, and failed or declined patches
  are skipped and counted — Codex records no base content for them, and
  agit does not guess. Multi-file patches emit sorted by path so imports
  stay byte-identical.
- Corrects the earlier claim that Codex records no structured edits: that
  described one sampled rollout, not the format.

## 0.3.1 — 2026-09-07

### Fixed

Pre-launch adversarial testing (hostile inputs, corrupted stores, 200-round
adapter fuzzing; verify held against every tamper class tested):

- Adapters skip-count JSON lines that parse to null/scalar/array instead of
  crashing the import on the first property read.
- UTF-8 BOMs no longer break imports (codex lost session_meta entirely;
  claude dropped its first record).
- One corrupt stored session no longer crashes all of agit ls; verbs on it
  say re-import instead of throwing a bare TypeError.
- share without a running relay explains itself (start agit relay / pass
  --relay) instead of printing fetch failed; relay on a busy port hints
  --port instead of raw EADDRINUSE.

## 0.3.0 — 2026-09-07

### Added

- **Codex adapter** — the second runtime, making runtime-agnostic empirical
  rather than aspirational: OpenAI Codex CLI rollouts import into the same
  event log with auto-detection. Built against a real 297-record rollout;
  every mapping ambiguity (duplicate assistant channels, scaffolding
  messages, per-response token deltas, encrypted reasoning) was resolved
  with data and is documented in the adapter. Known gaps stated plainly:
  no file.diff yet (no structured edit records observed), encrypted
  reasoning dropped and counted.

- Share hardening (#4 closed): idle tailing polls cost one stat() call
  (byte-offset tailing rejected with a test — it cannot see prefix
  rewrites); the relay sheds SSE connections buffering past 8MB
  (Last-Event-ID reconnects catch up losslessly); PROTOCOL.md gains
  concrete TLS deployment shapes and a normative five-point v1 freeze
  checklist.

### Fixed (community PRs #19–#23)

- The verifier reports a valid-JSON-but-not-an-object line (null, a scalar,
  an array) as a broken chain instead of crashing on it; display verbs name
  the offending line instead of throwing a bare TypeError.
- Detail views no longer collapse the indentation out of diffs and
  pretty-printed tool input (new clipLine beside the one-line excerpt).
- SEED.md quotes messages verbatim — truncated, never reflowed — as its own
  header promises.
- Adapter detect() scans the first 25 lines for a native record instead of
  judging the file by its first line, so logs opening with a summary or
  snapshot record import instead of being refused.
- agit merge survives files over 1 MB: git merge-file now writes in place
  instead of piping through execFileSync's capped stdout (ENOBUFS).

### Fixed (community PRs #15–#18, first outside contributions)

- Session ids from native logs are rejected unless directory-safe — a
  crafted log can no longer path-traverse out of .agit/sessions on import.
- The unified-diff applier treats a bare empty context line strictly: it
  must match an empty base line (was silently skipped on mismatch), and
  hunk-trailing empty lines are no longer dropped by value.
- The relay chat rate limit is per sender per share, so one viewer can no
  longer silence everyone else's messages.
- Redaction covers Stripe keys, npm tokens, Slack webhooks, URL-embedded
  credentials, and — the big one — prefixed/SCREAMING_SNAKE_CASE assignment
  keys like DB_PASSWORD, which word-boundary matching always missed
  (SPEC section 8 table updated to match).

- **Writer resume** (share protocol v0): a live share survives its CLI.
  Credentials persist under `.agit/shares/` while a live share runs; the
  relay's new `/head` endpoint reports where its chain ends; and
  `agit share --resume <share-id>` re-derives the (deterministic) chain,
  verifies it carries the relay's head hash, and pushes only the tail.
  A source file whose history changed is refused, never papered over.

## 0.2.1 — 2026-09-06

Version bump republish of 0.2.0 (no code changes).

## 0.2.0 — 2026-09-06

### Added

- **`agit fork <id> --at N`** (milestone 3, part 1): branch a session at any
  event. Hash-verified file-tree reconstruction (diff replay + recovery from
  runtime-recorded pre-edit content), a deterministic `SEED.md` context
  summary, and `fork.json` provenance. Honestly lossy by design.
- `agit replay --state` prints file state non-interactively; timelines show
  date separators on multi-day sessions; file counts everywhere are labeled
  as the lower bounds they are, and `[DIVERGED at seq N]` marks files
  provably modified outside structured edits.
- **`agit merge <fork-dir>`** (milestone 3, part 2): file-level three-way
  merge back from a fork — fork point as base, `git merge-file` as the
  engine, conflicts as standard markers, outcomes and summary recorded in
  the fork's `merge.json`.
- **`agit pr <id>`**: a verifiable handoff bundle — event log + meta +
  hash-verified tree + `SEED.md` + provenance.
- `agit verify` accepts a path to any events.jsonl (pr bundles, downloaded
  share logs), not just store ids.
- `agit export` (JSONL or `--json`).

## 0.1.0 — 2026-09-06

Initial release: the format, one adapter, local inspection, live sharing.

### Added

- **SPEC.md** — the v1 event format: append-only JSONL, eight event types,
  JCS-style canonical serialization, SHA-256 hash chain, deterministic
  imports, documented redaction patterns and known losses.
- **Claude Code adapter** — maps native `~/.claude/projects` logs in file
  order; preserves the native `uuid`/`parentUuid` DAG under
  `payload.native`; dedupes per-API-message token usage into `cost` events;
  derives `file.diff` with before/after content hashes from structured
  `Edit`/`Write` results; skips and counts everything it cannot map.
- **CLI** — `import`, `ls`, `show`, `verify` (first broken link, truncation
  via meta), `replay` (interactive stepping, `--at`, `--timeline`,
  cumulative file state), `export` (JSONL or `--json` to stdout).
- **`share` + `relay`** (protocol v0, PROTOCOL.md) — live session sharing:
  the CLI tails a running session's native log and streams prefix-stable,
  hash-chained events through a self-hosted in-memory relay; teammates
  watch a browser replay (timeline, diffs, token meter) and send messages
  that land in the sharer's terminal. Watch-only: nothing is injected into
  the running agent. A completed live stream is byte-identical to a full
  import. Unguessable expiring links, chain-checked writes, strict-CSP
  share page.
- **Redaction** — ten credential patterns applied to every payload string at
  import, before hashing; counts recorded in `meta.json`.
- **Golden-fixture guarantee** — the committed golden log pins canonical
  serialization, hashing, redaction, and the adapter mapping byte for byte,
  in the test suite and again in CI through the real CLI.
- Tooling: TypeScript/ESM, zero runtime dependencies; vitest suite over
  synthetic fixtures; ESLint (flat, typescript-eslint strict) + Prettier;
  CI on Linux and Windows, Node 20/22, with least-privilege workflow
  permissions.

### Known limitations (documented, not hidden)

- One adapter (Claude Code). `file.diff` covers structured edits only —
  shell-driven changes are invisible to replay. No `fork`/`merge`/`pr` yet.
  Share has no writer resume and no built-in TLS. Redaction is a seatbelt,
  not a guarantee.
