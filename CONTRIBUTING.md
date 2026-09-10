# Contributing to agit

Welcome. This document is the onboarding path: how the project thinks, how to
get running, and what makes a change land smoothly.

## The one idea

**The session is data.** An AI coding session becomes an append-only,
hash-chained JSONL log, and every agit feature — inspect, replay, share,
fork — is a view over that log. agit does not build an agent; it sits above
every agent, the way git sits above every editor.

Two documents outrank all code:

- [SPEC.md](SPEC.md) — the event format. The stable contract. **Changing it
  is the most expensive thing you can do here**: open an issue and get
  agreement before writing code. Every adapter and every verb depends on it.
- [PROTOCOL.md](PROTOCOL.md) — the share relay protocol. Explicitly v0 and
  unstable; improvements are cheap while all three components live in this
  repo.

## Getting running

Node 20+. TypeScript, ESM, **zero runtime dependencies** — keep it that way,
and justify any dev dependency you add.

```
npm ci
npm run build     # tsc -> dist/
npm test          # vitest — same suite CI runs
```

`npm ci` installs straight from the lockfile and needs no flags. Changing a
dependency is where it gets awkward: npm 10's resolver crashes with `Cannot
read properties of null (reading 'edgesOut')` on vitest's optional peers,
which peer-depend back on vitest. Regenerate the lock with `npm install
--legacy-peer-deps` when that happens. The flag only affects generating the
lock — installing from it, which is all CI ever does, stays plain `npm ci`.

Try it on your own data (Claude Code writes session logs under
`~/.claude/projects/<project-slug>/*.jsonl`):

```
node dist/cli.js import <path-to-a-session>.jsonl
node dist/cli.js ls
node dist/cli.js show <id>
node dist/cli.js verify <id>
node dist/cli.js replay <id> --timeline
```

Two terminals for the share demo:

```
node dist/cli.js relay
node dist/cli.js share <id>        # prints a link; open it in a browser
```

## Repo map

```
SPEC.md                  the event format (normative)
PROTOCOL.md              the share relay protocol (v0, unstable)
src/format/              events, canonical JSON, hashing, chain verification
src/adapters/            runtime adapters (claude-code today; yours next?)
src/redact.ts            credential redaction, runs at import before hashing
src/store.ts             the .agit/ directory
src/state.ts             folds over event logs (file state, usage, rendering)
src/share.ts             live follower + relay client
src/relay/               the relay server and the share page
src/mcp.ts               read-only MCP server over the store (stdio JSON-RPC)
src/cli.ts               the verbs
fixtures/                synthetic session logs for tests
test/                    vitest suites
```

## Rules that are not suggestions

- **Never commit a real session log.** Fixtures are synthetic, always. Real
  logs contain real file contents, paths, and whatever secrets an agent
  happened to see.
- **Session logs are untrusted input.** They may contain adversarial
  content. Display it, never execute it; in the browser page, log-derived
  text goes through `textContent`, never `innerHTML`.
- **Adapters skip and log, never guess.** A record you cannot map gets
  counted in `meta.json`, not repaired. If a real session breaks an adapter,
  fix the adapter, not the fixture.
- **Imports are deterministic** (SPEC §7). Nothing time-of-import-dependent
  goes into an event. If your change makes two imports of the same bytes
  differ, it is wrong.
- **Live streams are prefix-stable** (PROTOCOL.md). Anything the adapter
  emits in live mode must never change on a longer read of the same file —
  the follower verifies this and will stop the share loudly if you break it.
- **Honesty in docs.** README says plainly what does not work. Keep it true
  in both directions.

## Writing an adapter

The most valuable contribution. The interface is three members
([src/adapters/adapter.ts](src/adapters/adapter.ts)): `detect`, `convert`,
and a name/version. Study the Claude Code adapter — its shape (per-message
cost dedupe, native ids under `payload.native`, skip counters) is the
template. A good adapter PR has:

1. A synthetic fixture exercising every mapping path — messages, tool
   calls/results, structured edits, something skippable, a fake credential.
2. Tests asserting the exact event sequence, cost dedupe, file.diff hashes,
   and byte-identical re-imports.
3. Prefix stability under `{live: true}` if the runtime's log grows in place
   (the property test in [test/live.test.ts](test/live.test.ts) is reusable).
4. Notes in the PR on what the runtime records that you chose to skip, and
   why.

When the runtime's real log format is ambiguous, show raw (sanitized!) data
in the issue and ask — don't pick silently.

## Commits and PRs

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `docs:`, `test:`, `chore:`. Small and focused; a PR that does one
  thing reviews in minutes.
- CI must be green: build + tests on Linux and Windows, Node 20 and 22.
  Windows is a first-class platform here — mind path separators and line
  endings (the repo enforces LF via `.gitattributes`).
- Match the surrounding code's style; there is no formatter to argue with.

## Security

Redaction (SPEC §8) is a seatbelt, not a guarantee — improvements to
patterns are welcome, with tests for both matches and non-matches (false
positives on ordinary code are bugs too). If you find a vulnerability —
especially anything that lets a crafted session log escape "displayed, never
executed", or leak data through the relay — please report it privately via
GitHub security advisories rather than a public issue.

## Non-goals

Building an agent or model, replacing observability dashboards, supporting
every runtime before the format is proven, or claiming lossless context
fork/merge. PRs in those directions will be declined kindly.
