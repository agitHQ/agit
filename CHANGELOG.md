# Changelog

Notable changes to agit. The event format itself is versioned separately
(SPEC.md §11); a spec bump is always called out here in bold.

## Unreleased

### Fixed

- **`share` and `export` no longer publish a chain that does not verify**
  (#54). Every verb that publishes or hands off a stored session — `share`,
  `export`, `export-html`, `fork`, `pr` — now goes through one gate that
  refuses outright and names the failing check and the event it failed at:
  `refusing to share: chain verification failed — event 1: hash does not
  recompute`. The gate reads `meta.json` too, so a truncated log is caught
  everywhere, not only by `verify`. Live shares are unaffected: they build
  their chain as they tail the native log.

### Added

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
