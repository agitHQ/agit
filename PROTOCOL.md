# agit share protocol — v0

Status: **unstable**. This protocol is an implementation detail between the
agit CLI, the agit relay, and the share page — all of which ship from this
repo. It will change without ceremony until it is declared v1. The event
format itself (SPEC.md) is the stable contract; this document is only about
moving those events around.

## Shape

```
 sharer's machine                relay (in-memory)              viewers
┌───────────────────┐          ┌─────────────────┐          ┌──────────────┐
│ native log        │  POST    │                 │   SSE    │ browser page │
│  └─ adapter(live) │ events──▶│  events buffer  │──stream─▶│  /s/<id>     │
│  agit share       │◀──SSE────│                 │◀──POST───│  message box │
└───────────────────┘  inbox   └─────────────────┘          └──────────────┘
```

Transport is **SSE + HTTP POST**, not WebSocket. Same relay mechanics, zero
dependencies on either end, survives ordinary proxies, and browsers
reconnect (with `Last-Event-ID` resume) for free. The CLAUDE-era sketch said
"websocket"; this is the same idea with less machinery.

## Live streams are prefix-stable — and sealed

While a session runs, the adapter converts in *live mode*: it emits nothing
that depends on where the file currently ends (the EOF cost flush, the
synthesized `session.end`). Every event streamed is therefore final, and the
CLI verifies on every poll that a re-conversion still extends what was
already sent — if it ever doesn't, the share stops loudly rather than
rewriting history viewers may have verified.

When the sharer ends the share, the CLI converts once more in normal mode
and pushes the tail. A completed live stream is **byte-identical to
`agit import` of the same native log** — download `events.jsonl` from the
relay and `agit verify` reproduces the same hashes.

## Endpoints

| method | path | auth | body / result |
|---|---|---|---|
| POST | `/api/shares` | — | `{ttlMs?}` → `{shareId, writerToken, ttlMs, path}` |
| POST | `/api/shares/:id/events` | writer | `{events: [AgitEvent…]}`; relay enforces `seq` contiguity and `prev` linkage, 409 on violation |
| POST | `/api/shares/:id/end` | writer | marks the share ended |
| GET | `/api/shares/:id/head` | writer | `{events, lastHash, ended}` — where the stored chain ends, for crash resume |
| GET | `/api/shares/:id/stream` | link | SSE for viewers (below) |
| GET | `/api/shares/:id/inbox` | writer | SSE: viewer messages + info |
| POST | `/api/shares/:id/message` | link | `{text, name?}` → broadcast to everyone incl. the sharer's terminal |
| GET | `/api/shares/:id/events.jsonl` | link | the buffered log, verbatim — feed it to `agit verify` |
| GET | `/s/:id` | link | the share page (inline HTML, CSP: no external resources) |

Writer auth is `Authorization: Bearer <writerToken>`, compared in constant
time. "link" auth is possession of the unguessable share id (128 random
bits, base64url).

## SSE frames

- `ev` — one agit event, `data` is the event's JSON verbatim, `id` is its
  `seq` (so `Last-Event-ID` reconnects resume without replaying).
- `info` — `{live, viewers, events, expiresAt}`; sent on connect and on any
  change.
- `msg` — `{name, text, ts}`; a viewer message, broadcast to all streams.
- comment frames (`:hb`) every 15s keep intermediaries from killing idle
  connections.

## Lifecycle and limits

Shares live in relay memory only; nothing touches disk. A share dies at its
TTL (default 24h, max 7d), or 30 minutes after the sharer ends it (grace for
late viewers), whichever comes first — the reaper closes all streams and
drops the buffer. Defaults: 200 concurrent shares, 200k events per share,
25MB per push, 4000-char messages, 30 messages/minute per share.

## Writer resume

A live share survives its CLI: the relay keeps the buffered chain until TTL,
and the sharer's machine keeps the share credentials under `.agit/shares/`
(written when a live share starts, deleted on a clean end — a surviving file
means "resumable"). `agit share --resume <share-id>` asks the relay for its
head, regenerates the chain from the native log — conversion is
deterministic, so the prefix is byte-identical — refuses to continue unless
its event at `events-1` carries the relay's `lastHash`, then pushes only the
tail and keeps tailing. A source file whose history changed since the
original share fails that check and is refused rather than papered over.

## What the relay does and does not check

It checks `seq` contiguity and `prev` linkage at the write boundary, so a
broken chain is refused before any viewer sees it. It does **not** recompute
hashes — the writer token holder is the only writer, and verification
belongs to the edges: any viewer can download `events.jsonl` and run
`agit verify` locally.

## Viewer messages are not injection

Messages go to the **sharing human's terminal**, clearly attributed, and are
never fed to the agent. Claude Code has no supported way to inject input
into a running interactive session; per the project rule — verify per
runtime before promising — agit does not pretend otherwise. If a runtime
ever offers a real injection path, it gets wired per-adapter, opt-in.

## Deployment notes

The relay binds loopback by default. Exposing it (`--host 0.0.0.0`) is your
call; put TLS in front (reverse proxy or tunnel) — share links are bearer
capabilities and deserve encrypted transport. There is no persistence, no
accounts, and no cross-share enumeration: `GET /api/shares` does not exist.
