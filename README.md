# agit — git for running agents

[![ci](https://github.com/thegoodengineers/agit/actions/workflows/ci.yml/badge.svg)](https://github.com/thegoodengineers/agit/actions/workflows/ci.yml)
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

```
npm install -g agitsh
```

Or, for contributors, from source:

```
git clone https://github.com/thegoodengineers/agit && cd agit
npm ci && npm run build && npm link   # `agit` is now on your PATH
```

## What works today

- **`agit import <session.jsonl>`** — ingest a native session into
  `.agit/sessions/<id>/events.jsonl`. Two adapters, auto-detected:
  **Claude Code** (`~/.claude/projects/<project>/<uuid>.jsonl`) and
  **Codex CLI** (`~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`) — the
  same event log, the same verbs, whichever agent produced the session.
  Deterministic: the same input always produces byte-identical output.
  Credential-looking strings are redacted on the way in (see
  [SPEC.md section 8](SPEC.md) for exactly what is and isn't caught).
- **`agit ls`** — list imported sessions: start, duration, events, files touched.
- **`agit show <id>`** — one-session summary: model, tools, token totals,
  per-file diffstat.
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
- **`agit merge <fork-dir>`** — bring a fork's files back: ordinary git
  three-way merge per file with the fork point as base (`git merge-file`
  does the merging). Trivial cases fast-forward, real conflicts get
  standard markers and a nonzero exit, and the merge — outcomes plus your
  `--summary` of what the fork learned — is recorded in the fork's
  `merge.json`. Not a merge of two minds; file-level, as promised.
- **`agit pr <id>`** — hand a session to a colleague as a directory: the
  full event log (they run `agit verify` on it directly), `meta.json`, the
  reconstructed hash-verified tree, `SEED.md` context, and provenance.
  Working context, not a read-only transcript.
- **`agit share <id | native.jsonl>`** — share a session through a relay,
  **live while the agent is still running**: the CLI tails the native log
  and streams events; teammates watch in a browser (timeline, diffs, token
  meter) and can send messages that land in your terminal. **Watching is
  read-only**: viewer messages reach the human at the keyboard, never the
  agent (see below). A completed live stream is byte-identical to a full
  import — viewers can download `events.jsonl` and `agit verify` what they
  watched. If the sharing CLI dies, `agit share --resume <share-id>`
  reattaches to the same link and pushes only the missing tail. Links
  expire (24h default) and sharing is opt-in per session, always.
- **`agit relay`** — the self-hosted relay behind `share`: in-memory only,
  loopback by default, nothing persisted. [PROTOCOL.md](PROTOCOL.md)
  documents the (v0, unstable) wire protocol.

Session ids accept unique prefixes, git-style. The inspection verbs are
fully local: no server, no network calls, no telemetry. Only `share` talks
to a relay — one you run.

## The format

[SPEC.md](SPEC.md) is the most important artifact in this repo. Eight event
types (`session.start`, `session.end`, `message.user`, `message.assistant`,
`tool.call`, `tool.result`, `file.diff`, `cost`), each carrying a canonical
SHA-256 hash and the hash of the previous event. Tamper-evidence, stable fork
points, and independent verification of what an agent claims it did — all
fall out of that chain.

## What does not work yet

Said plainly:

- **Two adapters, unevenly deep.** Claude Code is the reference. The Codex
  adapter maps structured `apply_patch` edits to hash-verified `file.diff`
  events, with real limits: Codex records the full content of a file it
  *creates*, but only a diff when it *updates*, so agit can verify an update
  only while it already holds that file's content from earlier in the same
  session — an edit to a file that predates the session is skipped and
  counted, never hashed on a guess. Deletions and renames are skipped too
  (no event type says either). Codex reasoning arrives encrypted and is
  dropped, counted. OpenClaw is next.
- **`file.diff` coverage is partial.** Diffs come from structured edit tools
  (`Edit`/`Write`). Files changed through shell commands leave no diff event;
  file state from replay is a lower bound on what changed. Fork trees
  inherit this blind spot: a file the log never structurally edited is
  absent from the tree entirely, and — since there are no deletion events —
  a file deleted mid-session still appears at its last logged content.
- **No message injection into a running session.** Sharing is watch-only:
  viewer messages reach the sharing human's terminal, clearly attributed —
  they are never fed to the agent. Claude Code has no supported way to
  inject input into a live interactive session, and agit does not pretend
  otherwise; if a runtime ever offers a real path, it gets wired
  per-adapter, opt-in.
- **No TLS in the relay.** It binds loopback by default; exposing it to a
  network means putting a TLS proxy or tunnel in front (PROTOCOL.md).
- **A `pr` bundle cannot be imported into a store yet.** `agit verify`
  reads its `events.jsonl` directly, but replaying or forking the bundled
  log on another machine still requires importing the source's native log.
- **Merge is file-level and needs git.** Three-way content merge only:
  deletions in a fork are invisible (the fork tree records what the log
  could reconstruct, so absence means untouched, not deleted), renames are
  two files, and `git merge-file` must be on PATH. Fork/pr context seeding
  is a summary by design; you cannot inject history into a running agent.
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
