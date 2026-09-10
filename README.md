# agit — git for running agents

[![ci](https://github.com/agitHQ/agit/actions/workflows/ci.yml/badge.svg)](https://github.com/agitHQ/agit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agitsh)](https://www.npmjs.com/package/agitsh)

An AI coding session is trapped: one terminal, one machine, a proprietary log
format, one pair of eyes. When it ends you're left with changed files and a
scrollback buffer.

agit turns the session itself into an open artifact. It imports a runtime's
native log into an append-only, hash-chained JSONL event log — and every
feature is a view over that log. agit does not build an agent; it sits above
every agent, the way git sits above every editor.

<!-- demo.png is GIF bytes: the .png name keeps GitHub from wrapping the demo in its play-button control -->
![agit replay showing a diverged file](docs/demo.png)

*(a synthetic fixture session — real ones look the same, only longer)*

agit is not an observability platform. Those ask you to instrument your
agents with an SDK, and they show you what that instrumentation captured.
agit reads the logs your runtime already wrote, on your own machine, with
nothing to adopt in advance. And because every event carries content
hashes, agit can prove when a log is incomplete rather than quietly
presenting a partial picture as the whole story.

```
npm install -g agitsh
```

Or, for contributors, from source:

```
git clone https://github.com/agitHQ/agit && cd agit
npm ci && npm run build && npm link   # `agit` is now on your PATH
```

## What works today

- **`agit import <session | bundle>`** — ingest a native session into
  `.agit/sessions/<id>/events.jsonl`, or **adopt** an agit log someone sent
  you (a `pr` bundle, a downloaded share log) — auto-detected, verified
  before it is stored, and kept byte for byte so the sender's hashes still
  check out. Two adapters for native logs, also auto-detected:
  **Claude Code** (`~/.claude/projects/<project>/<uuid>.jsonl`) and
  **Codex CLI** (`~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`) — the
  same event log, the same verbs, whichever agent produced the session.
  `agit import --all` finds every session those runtimes have written on
  this machine (`~/.claude/projects`, `~/.codex/sessions`,
  `~/.openclaw/agents/*/sessions`) and imports what is new; `--latest`
  takes just the most recent one; `--since 7d` bounds the scan. A directory
  listing plus the ordinary import — no daemon, no hooks — and last month's
  sessions are found the same way as today's.
  Deterministic: the same input always produces byte-identical output.
  Credential-looking strings are redacted on the way in (see
  [SPEC.md section 8](SPEC.md) for exactly what is and isn't caught).
  `--no-redact` stores a session verbatim when redaction would mangle it;
  `share`, `pr` and `export-html` then refuse that session until you pass
  `--allow-unredacted`, and re-importing without the flag puts redaction back.
- **`agit ls`** — list imported sessions: start, duration, events, files touched.
- **`agit show <id>`** — one-session summary: model, tools, token totals,
  per-file diffstat. `--by-model` splits it: what each model cost and how
  many files its edits touched. Tokens are exact; file attribution credits
  an edit to the model named by the nearest preceding event, and says so.
- **`agit rm <id> --yes`** — delete a session from the store. `--yes` is the
  confirmation: there is no interactive prompt for a script to answer, so the
  flag is it. Without it, `rm` says what it would remove and stops. It does
  not know whether a fork somewhere still points at the session — forks live
  wherever `--out` put them, with no registry to consult — and says so rather
  than guessing.
- **`agit stats`** — token and API-call totals across every imported
  session, grouped `--by model` (default) or `--by runtime`. A fold over the
  `cost` events each session already carries, so it needs no new data — and
  it says how many sessions it could not read rather than quietly leaving
  them out. `--json` for scripts.
- **`agit grep <pattern>`** — search every imported session at once:
  "which session touched auth.py" (`--path`), "where did I run pytest"
  (`--type tool.call`). Matches the same one-line rendering `replay
  --timeline` prints, so what you search is what you saw, and outputs one
  flat row per hit for piping onward.
- **`agit verify <id>`** — validate the hash chain; reports the first broken
  link, and detects truncation via `meta.json`.
- **`agit replay <id>`** — step through events (`n`/`p`/`g N`), inspect any
  event, and show cumulative file state at any point (`s`, or `--at N
  --state` non-interactively). `--at N` jumps straight to event N;
  `--timeline` prints the whole session one line per event.
- **`agit fork <id> --at N`** — branch a session at event N. The file tree
  is reconstructed from the log and **verified**: every replayed diff must
  reproduce its event's content hash, broken chains recover from
  runtime-recorded pre-edit content where it exists, and whatever cannot be
  verified is listed instead of written. Context is honestly lossy: the
  fork gets `SEED.md`, a deterministic mechanical summary (provenance,
  the task, last exchanges, file state) — not a transplant of the agent's
  mind. `fork.json` records the source session and fork-point hash, so
  provenance is checkable with `agit verify`.
- **`agit diff <a> <b>`** — what two sessions did differently: files each
  side touched, which ones converged on identical content, which diverged
  (with both hashes), and the work each spent getting there. `agit diff
  <fork-dir>` compares a fork against the parent it came from, starting at
  the fork point recorded in `fork.json`. Comparison is by reconstructed
  content, so it inherits replay's blind spot and says so.
- **`agit merge <fork-dir>` — bring a fork's files back: ordinary git
  three-way merge per file with the fork point as base (`git merge-file`
  does the merging). Trivial cases fast-forward, real conflicts get
  standard markers and a nonzero exit, and the merge — outcomes plus your
  `--summary` of what the fork learned — is recorded in the fork's
  `merge.json`. Not a merge of two minds; file-level, as promised.
- **`agit pr <id>`** — hand a session to a colleague as a directory: the
  full event log, `meta.json`, the reconstructed hash-verified tree,
  `SEED.md` context, and provenance. They run `agit import` on the
  directory and get a session they can replay, fork and verify like any
  other — working context, not a read-only transcript.
- **`agit share <id | native.jsonl>`** — share a session through a relay,
  **live while the agent is still running**: the CLI tails the native log
  and streams events; teammates watch in a browser (timeline, diffs, token
  meter) and can send messages that land in your terminal. **Watching is
  read-only**: viewer messages reach the human at the keyboard, never the
  agent (see below). A completed live stream is byte-identical to a full
  import — viewers can download `events.jsonl` and `agit verify` what they
  watched. If the sharing CLI dies, `agit share --resume <share-id>`
  reattaches to the same link and pushes only the missing tail. Links
  expire (24h default) and sharing is opt-in per session, always. A stored
  session whose chain does not verify is refused — `share`, `export`, `fork`
  and `pr` all name the failing event rather than publishing it.
- **`agit relay`** — the self-hosted relay behind `share`: in-memory only,
  loopback by default, nothing persisted. [PROTOCOL.md](PROTOCOL.md)
  documents the (v0, unstable) wire protocol.

**`--json`** on `ls`, `show`, `show --by-model`, `verify`, `grep`, `diff`
and `export` emits the structures agit already builds, so a script reads
the same numbers the table renders — full ids, ISO timestamps, real
integers. `grep --json` is one object per line (NDJSON); everything else
is one document. Errors stay on stderr, so a pipe into `jq` is always clean.

Session ids accept unique prefixes, git-style. The inspection verbs are
fully local: no server, no network calls, no telemetry. Only `share` talks
to a relay — one you run.

## The format

[SPEC.md](SPEC.md) is the most important artifact in this repo. Nine event
types (`session.start`, `session.end`, `message.user`, `message.assistant`,
`tool.call`, `tool.result`, `file.diff`, `file.delete`, `cost`), each
carrying a canonical
SHA-256 hash and the hash of the previous event. Tamper-evidence, stable fork
points, and independent verification of what an agent claims it did — all
fall out of that chain.

## What does not work yet

Said plainly:

- **Three adapters, with different limits.** Claude Code is the reference;
  Codex is mapped from its own structured edit records. OpenClaw is mapped from the `apply_patch` text it records, replayed
  with OpenClaw's own matching rules.
- **Codex updates have a verification window.** Codex records a file's full
  content when it *creates* one, but only a diff when it *updates* one — so
  agit can verify an update only while it already holds that file's content
  from earlier in the same session. An edit to a file that predates the
  session is skipped and counted, never hashed on a guess.
- **OpenClaw has the same window**: `apply_patch` records the patch, not
  the file, so an update is verifiable only for a file the session created.
- **Codex renames are recorded as a delete plus a create** — schema v2 gives
  a rename an honest encoding, so the log says what the filesystem saw: the
  old path gone, the new one created with the updated content. A rename
  whose base predates the session is still skipped and counted, because
  neither path has content agit could hash. Deletions are recorded
  (`file.delete`) whenever Codex logged the file's content.
- **Codex reasoning arrives encrypted** and is dropped, counted.
- **`file.diff` coverage is partial.** Diffs come from structured edit tools
  (`Edit`/`Write`). Files changed through shell commands leave no diff event;
  file state from replay is a lower bound on what changed. Fork trees
  inherit this blind spot: a file the log never structurally edited is
  absent from the tree entirely, and a file deleted by a shell command
  still appears at its last logged content — only a structured deletion
  (`file.delete`) removes it.
- **No message injection into a running session.** Sharing is watch-only:
  viewer messages reach the sharing human's terminal, clearly attributed —
  they are never fed to the agent. Claude Code has no supported way to
  inject input into a live interactive session, and agit does not pretend
  otherwise; if a runtime ever offers a real path, it gets wired
  per-adapter, opt-in.
- **The relay speaks TLS only when you give it a certificate.**
  `agit relay --cert <pem> --key <pem>` serves HTTPS; otherwise it is plain
  HTTP on loopback, and binding beyond loopback without TLS is refused
  unless `--insecure` is passed. A tunnel or TLS-terminating proxy remains a
  perfectly good alternative (PROTOCOL.md).
- **Merge is file-level.** Three-way content merge only: deletions in a fork
  are invisible (the fork tree records what the log could reconstruct, so
  absence means untouched, not deleted) and renames are two files. It uses
  `git merge-file` when git is on PATH and a built-in three-way merge
  otherwise (`--no-git` forces the built-in one); git is preferred because
  its results are what everyone's expectations are calibrated against.
  Fork/pr context seeding  is a summary by design; you cannot inject history into a running agent.
- **Redaction is a seatbelt, not a guarantee.** Session logs contain whatever
  the agent saw. Before sharing one anywhere, read it.

## Security posture

Session logs are untrusted input: they may contain adversarial content and
are never executed, only displayed — the share page builds its DOM from
`textContent` exclusively and ships a CSP that forbids external resources.
Known credential patterns are redacted before events leave your machine
(at import and during live shares alike) and counted in `meta.json`. Share
links are unguessable 128-bit capabilities with TTLs; the relay holds
everything in memory, binds loopback by default, and persists nothing. Never
commit real session logs to this repo — tests run against synthetic
fixtures.

## Development

Node 20+, TypeScript, ESM, zero runtime dependencies.

```
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

Conventional Commits, small and focused. If a real session breaks an adapter,
fix the adapter, not the fixture. [CONTRIBUTING.md](CONTRIBUTING.md) has the
full onboarding path — repo map, adapter-writing guide, and the rules that
are not suggestions. CI runs build + tests on Linux and Windows, Node 20/22.

## License

Apache-2.0
