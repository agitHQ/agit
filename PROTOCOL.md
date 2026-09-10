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

Shares live in relay memory by default; nothing touches disk. `agit relay
--store <dir>` changes that: two flat files per share, metadata rewritten
whole and events appended, so a restart keeps every link working. Not a
database — agit has no runtime dependencies, and `node:sqlite` needs Node 22
while the package supports 20. The TTL applies across a restart: a share that
expired while the relay was down stays gone rather than getting a fresh
clock, and the head is recomputed from the events that actually loaded so a
truncated file cannot claim a head it can no longer serve. **The writer token
is stored in that directory**, so it is a credential store: created `0700`,
files `0600`, and on Windows those modes are advisory, which makes the choice
of directory the real protection.

A share dies at its
TTL (default 24h, max 7d), or 30 minutes after the sharer ends it (grace for
late viewers), whichever comes first — the reaper closes all streams and
drops the buffer. Defaults: 200 concurrent shares, 200k events per share,
25MB per push, 4000-char messages, 30 messages/minute per sender per share (the message endpoint is unauthenticated, so the budget must isolate senders).

Sender identity is the connecting socket address by default. Behind a
reverse proxy every viewer therefore looks like the proxy, and the
per-sender budget collapses into one shared bucket — start the relay with
`--trusted-proxy <addr>` (repeatable) to trust `X-Forwarded-For` from that
address instead. The header is walked right to left, skipping trusted hops,
and is ignored entirely from any address not on that list, so a viewer
cannot spoof its way into someone else'''s budget.

Slow consumers are shed, not accumulated: an SSE connection whose outbound
buffer passes 8MB is destroyed. A healthy-but-slow browser reconnects with
`Last-Event-ID` and replays what it missed from the relay's buffer; a dead
connection stops costing memory. The sharer's CLI polls its native log with
an idle fast path — an unchanged file costs one stat() per tick, and any
change still triggers the full re-read + prefix-digest verification
(byte-offset tailing was rejected: reading only appended bytes cannot see
in-place prefix rewrites, which is exactly what the digest exists to catch).

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

The relay binds loopback by default. Share links and writer tokens are bearer
capabilities, so on a plaintext link anyone on the path can read the session
and hijack the writer role — which is why binding beyond loopback without TLS
is **refused** unless you pass `--insecure` and mean it. Three shapes:

- **Native TLS** — `agit relay --cert <pem> --key <pem>` serves HTTPS
  directly (`node:https`). Same routes, same tokens, same SSE framing; only
  the socket changes. Share against it with
  `agit share <id> --relay https://host:7717`.
- **Tunnel** — keep the relay on loopback and put `cloudflared tunnel`,
  `tailscale funnel`, or an SSH forward in front. Zero relay configuration.
- **Reverse proxy** — Caddy (`caddy reverse-proxy --from share.example.com
  --to localhost:7717`) or nginx with proxied SSE (`proxy_buffering off`).
  Terminating TLS elsewhere stays perfectly good; native TLS is for when
  there is nowhere else to put it.

`--cert` and `--key` go together: a relay is HTTPS or it is HTTP, never half
of one.

There is no persistence, no accounts, and no cross-share enumeration:
`GET /api/shares` does not exist.

## v1 freeze criteria

This protocol stays v0 until all of the following hold, and is then frozen
as v1 — after which changes version rather than mutate:

1. **Resume semantics are normative** — `Last-Event-ID` viewer resume and
   writer `/head` resume are specified precisely enough to reimplement from
   this document alone, including every error code they can return.
2. **Error codes are enumerated** — each endpoint's non-2xx responses are
   listed here and covered by tests, not discovered in source.
3. **Limits are contractual** — the numbers above stop being "defaults" and
   become guarantees a client may rely on, with 413/429 behavior specified.
4. **A second independent client exists** — something that is not this
   repo's CLI (a viewer, a bridge, an importer) speaks the protocol from the
   spec, proving the document is sufficient.
5. **One release cycle of stability** — no wire-visible change needed for a
   full release while the above hold.
