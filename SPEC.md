# agit event format — v2

Status: draft. This document is normative for schema version `2`.

An agit session is an append-only JSONL event log: one JSON object per line,
UTF-8, `\n` line endings, never rewritten. Every event is hash-chained to the
previous one. The log is the artifact; every agit verb is a view over it.

The words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

## 1. File layout

```
.agit/
  sessions/
    <session-id>/
      events.jsonl   # the log (this spec)
      meta.json      # import metadata, OUTSIDE the hash chain
```

`<session-id>` is the runtime's native session identifier when it has one
(Claude Code uses a UUID), otherwise an adapter-generated UUID. It MUST be
safe as a directory name: `[A-Za-z0-9._-]+`.

`meta.json` records how the log got here — import time, source file, adapter
version, what was skipped, what was redacted, event count, and head hash. It
is deliberately outside the chain so that importing the same native log twice
produces byte-identical `events.jsonl` (see §7 Determinism).

## 2. Event envelope

Every line is a JSON object with exactly these top-level fields:

| field     | type            | meaning                                              |
|-----------|-----------------|------------------------------------------------------|
| `v`       | integer         | schema version. `2` for this spec.                   |
| `seq`     | integer         | 0-based, contiguous, strictly increasing by 1.       |
| `ts`      | string          | ISO-8601 UTC with milliseconds, e.g. `2026-09-06T10:00:00.000Z`. Sourced from the native record when available. |
| `session` | string          | the session id (same for every event in the file).   |
| `type`    | string          | one of the event types in §5.                        |
| `payload` | object          | type-specific, see §5.                               |
| `prev`    | string \| null  | `hash` of the previous event; `null` iff `seq` is 0. |
| `hash`    | string          | SHA-256 of this event's canonical form, §3–4.        |

`seq` is the ordering. `ts` SHOULD be non-decreasing but readers MUST NOT
rely on it: it is source data, and clocks are what they are.

Readers MUST reject a v2 event whose `type` is not listed in §5, and MUST
ignore unknown fields inside `payload` (forward compatibility lives there).

Readers MUST also accept schema version `1`. A v1 log is identical to v2
except that `file.delete` (§5.8) does not exist in it, so a v1 event of that
type MUST be rejected. Writers MUST write `2`. Existing v1 logs — stores,
`pr` bundles, share downloads — keep verifying unchanged: their hashes were
computed over `v: 1` and still recompute.

## 3. Canonical serialization

The canonical form of a JSON value, used only for hashing:

1. Objects: keys sorted by UTF-16 code unit (ECMAScript default string
   ordering), no insignificant whitespace.
2. Strings: escaped as by ECMAScript `JSON.stringify`.
3. Numbers: serialized per ECMAScript Number-to-string (RFC 8785 §3.2.2.3).
   Payload authors SHOULD stick to integers; adapters MUST NOT emit `NaN`
   or infinities.
4. Encoded as UTF-8.

This is RFC 8785 (JCS) restricted to what agit events actually contain. A
compliant implementation in Node is a recursive key-sort followed by
`JSON.stringify`.

## 4. Hashing and the chain

```
hash = hex(sha256(canonical(event minus the "hash" field)))
```

The hashed object includes `prev`, so each event commits to the entire
history before it. The first event has `prev: null`.

Verification walks the file in order and checks, for each event: `seq`
contiguity, `prev` equals the previous event's `hash`, and `hash` recomputes.
The first failing `seq` is reported. A verifier that also has `meta.json`
SHOULD additionally check `eventCount` and `headHash` to detect truncation,
which the internal chain alone cannot see.

The chain attests to the **agit log**, not to the runtime's native log:
redaction (§8) happens before hashing. Tamper-evidence begins at import.

## 5. Event types

Nine types. Payloads MAY carry a `native` object holding runtime-specific
identifiers (record UUIDs, parent pointers, API message ids); core verbs
MUST NOT require it.

### 5.1 `session.start` — first event, exactly once

```json
{ "runtime": "claude-code", "runtimeVersion": "2.1.260",
  "nativeSessionId": "...", "cwd": "...", "gitBranch": "...",
  "adapter": { "name": "claude-code", "version": "0.1.0" } }
```

`runtimeVersion`, `cwd`, `gitBranch` are `null` when the source doesn't say.
`ts` is the timestamp of the first native conversation record.

### 5.2 `session.end` — last event, exactly once

```json
{ "reason": "log-end", "synthesized": true }
```

Claude Code writes no end-of-session record; the adapter synthesizes this at
the last conversation timestamp and says so. `reason` MAY take other values
for runtimes that do record endings.

### 5.3 `message.user`

```json
{ "text": "...", "native": { "uuid": "...", "parentUuid": "..." } }
```

`text` is the user's message. Non-text content blocks are flattened to
`[image]`-style markers.

### 5.4 `message.assistant`

```json
{ "model": "claude-opus-5",
  "blocks": [ { "type": "thinking", "text": "..." },
              { "type": "text", "text": "..." } ],
  "stopReason": "tool_use",
  "native": { "uuid": "...", "parentUuid": "...", "messageId": "msg_...",
              "requestId": "req_..." } }
```

`blocks` carries only `text` and `thinking` blocks; tool invocations become
`tool.call` events. Thinking **signatures are dropped**: they are opaque
runtime-internal validation blobs, meaningless outside the original API
conversation. This is a documented loss, not an accident.

One native assistant record maps to at most one `message.assistant` event; a
single API message streamed as several records yields several events sharing
`native.messageId`.

### 5.5 `tool.call`

```json
{ "toolUseId": "toolu_...", "name": "Edit", "input": {},
  "native": { "uuid": "...", "parentUuid": "...", "messageId": "msg_..." } }
```

One event per tool invocation, in block order.

### 5.6 `tool.result`

```json
{ "toolUseId": "toolu_...", "isError": false, "output": "...",
  "structured": {},
  "native": { "uuid": "...", "parentUuid": "..." } }
```

`output` is the flattened text the model saw. `structured` is the runtime's
structured result object when it has one (Claude Code's `toolUseResult`),
carried verbatim after redaction; `null` otherwise.

### 5.7 `file.diff`

```json
{ "path": "C:\\repo\\src\\a.ts", "kind": "modify",
  "diff": "--- a/...\n+++ b/...\n@@ -9,10 +9,11 @@\n ...",
  "beforeHash": "hex sha-256 or null", "afterHash": "hex sha-256",
  "toolUseId": "toolu_...", "source": "Edit" }
```

Emitted immediately after the `tool.result` it derives from. `kind` is
`create` or `modify`. `diff` is a unified diff. `beforeHash`/`afterHash` are
SHA-256 over the UTF-8 bytes of the full file content before and after;
`beforeHash` is `null` for `create`. `path` is verbatim from the runtime
(absolute, OS-native separators).

**Coverage is partial and the format does not pretend otherwise.** Events
exist only where the runtime records structured edits (Claude Code: `Edit`
and `Write`). Files changed through shell commands leave no `file.diff`;
reconstructing "file state at event N" from these events is a lower bound on
what actually changed.

### 5.8 `file.delete`

```json
{ "path": "C:\\repo\\src\\a.ts",
  "beforeHash": "hex sha-256",
  "toolUseId": "toolu_...", "source": "apply_patch" }
```

Emitted when the runtime records a structured deletion. `beforeHash` is the
SHA-256 over the UTF-8 bytes of the full file content immediately before
deletion. `path` is verbatim from the runtime (absolute, OS-native
separators).

`file.delete` does not have an `afterHash`: the file does not exist after the
event. A deletion MUST only be emitted when the adapter can establish the
pre-deletion content and therefore `beforeHash`; adapters MUST skip and log
deletions whose prior content is unavailable rather than guessing the hash.

Coverage is partial. Files deleted through shell commands leave no
`file.delete`; agit MUST NOT infer deletions from shell commands.

### 5.9 `cost`

```json
{ "model": "claude-opus-5",
  "usage": { "inputTokens": 2, "outputTokens": 129,
             "cacheReadInputTokens": 27508,
             "cacheCreationInputTokens": 10521 },
  "native": { "messageId": "msg_...", "requestId": "req_..." } }
```

Tokens only, verbatim from the source. Dollar amounts are a display-time
computation from a pricing table and MUST NOT be stored in the log, where
they would be a stale, unverifiable snapshot. One `cost` event per API
message: runtimes that write one record per content block share `usage`
across records, and adapters MUST deduplicate by native message id.

## 6. Adapter requirements

- **Skip and log, never guess.** A native record that maps to no event type
  is skipped and counted in `meta.json` `skipped` by native type. Malformed
  lines are counted, not repaired.
- **Linearize in file order.** Claude Code records form a DAG
  (`uuid`/`parentUuid`: resumes, retries, edited prompts). agit `seq` follows
  native file append order — what happened, when it happened. The DAG stays
  reconstructable from `native.uuid`/`native.parentUuid`; the chain stays
  linear.
- **Preserve native identifiers** under `payload.native`.
- **Redact before hashing** (§8).

## 7. Determinism

Importing the same native log bytes with the same adapter name+version MUST
produce a byte-identical `events.jsonl`. Nothing time-of-import-dependent may
enter an event; that is what `meta.json` is for. Consequences: re-imports are
idempotent, fork points are stable, and two people importing the same session
get the same hashes.

## 8. Redaction

Session logs contain whatever the agent saw — file contents, command output,
environment. On import, every string in every payload is scanned and matches
are replaced with `[REDACTED:<label>]`. v1 patterns:

| label               | pattern (case-sensitive unless noted)                               |
|---------------------|---------------------------------------------------------------------|
| `anthropic-key`     | `sk-ant-` followed by 16+ of `[A-Za-z0-9_-]`                        |
| `openai-key`        | `sk-` (incl. `sk-proj-`) followed by 20+ of `[A-Za-z0-9_-]`         |
| `aws-access-key-id` | `AKIA` or `ASIA` + 16 uppercase alphanumerics                       |
| `github-token`      | `ghp_/gho_/ghu_/ghs_/ghr_` + 36+ alphanumerics; `github_pat_` + 22+ |
| `slack-token`       | `xoxb/xoxa/xoxp/xoxr/xoxs-` + 10+ of `[A-Za-z0-9-]`                 |
| `slack-webhook`     | `https://hooks.slack.com/services/<id>/<id>/<id>`                   |
| `google-api-key`    | `AIza` + 35 of `[0-9A-Za-z_-]`                                      |
| `stripe-key`        | `sk_/rk_` + `live_/test_` + 10+ alphanumerics                       |
| `npm-token`         | `npm_` + 36 alphanumerics                                           |
| `private-key`       | `-----BEGIN ... PRIVATE KEY-----` through the matching `END` block  |
| `bearer`            | `Bearer ` + 20+ token characters (case-insensitive)                 |
| `jwt`               | three `.`-joined base64url segments starting `eyJ`                  |
| `url-credentials`   | `scheme://user:` + 3+ password characters immediately before `@` (case-insensitive scheme; connection strings and API URLs) — only the password is redacted, `scheme://user:` and the following `@host` are kept |
| `assignment`        | an identifier ending in `api_key/apikey/client_secret/secret/access_token/refresh_token/auth_token/session_token/token/password/passwd/dsn/connection_string/authorization` — including prefixed forms like `DB_PASSWORD` or `stripe_secret` (the keyword only needs to end the identifier; `_`/`-` before it don't block a match) — then `=` or `:`, then a quoted-or-bare value of 16+ token characters (case-insensitive; the full key and separator are kept) |

Counts per label go to `meta.json` `redactions`.

**What is NOT redacted:** file contents and source code generally, prompts,
paths, usernames, hostnames, email addresses, IP addresses, bare URLs
without embedded credentials, and any secret that doesn't match the table.
Redaction is a seatbelt, not a guarantee. Sharing a session remains an
explicit, per-session decision, and tooling MUST treat log contents as
untrusted data — displayed, never executed.

## 9. Known losses (v1, Claude Code adapter)

- Thinking signatures: dropped (§5.4).
- Native metadata records (`queue-operation`, `ai-title`, `custom-title`,
  `last-prompt`, `mode`, `pr-link`, `attachment`, hook `system` records,
  etc.): skipped and counted.
- `file.diff` coverage: `Edit`/`Write` only (§5.7).
- Native branch structure: linearized; reconstructable via `native` ids (§6).

## 10. meta.json

```json
{ "agitSchema": 1, "sessionId": "...",
  "adapter": { "name": "claude-code", "version": "0.1.0" },
  "importedAt": "2026-09-06T12:00:00.000Z",
  "source": { "path": "...", "sha256": "...", "bytes": 123, "records": 456 },
  "skipped": { "queue-operation": 20 },
  "redactions": { "anthropic-key": 1 },
  "eventCount": 789, "headHash": "..." }
```

Informative, mutable, uncommitted to the chain. `verify` uses `eventCount`
and `headHash` to detect truncation when present.

## 11. Versioning

`v` is bumped only for changes that alter the meaning or hashing of existing
fields. Adding a new event type or a new payload field is also a `v` bump in
v2 (readers reject unknown types). Adapters carry their own versions;
`meta.json` says which one wrote the log.

## 12. Signatures

The chain proves a log was not modified after it was chained. It does not
prove *who* chained it: anyone can rebuild a valid chain over edited content
and a matching `headHash`. A signature binds a head to a key.

Signatures live in `meta.json`, never in the chain — signing happens to a
finished head, so a chain covering it would have to cover something that did
not exist when it was built. A session can therefore be signed after import,
and by more than one person, without rewriting an event.

```json
"signatures": [
  { "alg": "ed25519",
    "key": "ssh-ed25519 AAAAC3Nza...",
    "keyFingerprint": "SHA256:...",
    "sig": "<base64>",
    "at": "2026-09-10T10:25:30.029Z",
    "payloadVersion": 1 }
]
```

### The signed payload

Ed25519 over the canonical JSON (§7) of exactly:

```json
{ "agitSignature": 1, "sessionId": "...", "headHash": "...",
  "eventCount": 789, "at": "2026-..." }
```

`eventCount` is inside the payload because truncation leaves every remaining
hash valid; without it a signed log could be silently shortened. `sessionId`
is inside it so a signature cannot be lifted onto a different session that
happens to share a head.

An independent implementation can verify without agit: rebuild those five
fields, serialize canonically, check the Ed25519 signature against `key`.

### What a signature does not say

- **Not when.** `at` is signed, so it cannot be edited afterwards, but it is
  still a time the signer chose. Turning that claim into evidence needs a
  third-party RFC 3161 time-stamp, which agit does not issue.
- **Not that the content is true.** It binds an identity to bytes. A signed
  log of false statements is a signed log of false statements.
- **Not who ran the session.** It says who vouched for this head, which may
  be a different person at a different time.

`keyFingerprint` is a convenience for humans comparing keys and is recomputed
from `key` on every verification; a verifier must never trust the stored
value, or a doctored one could make an unrelated key look familiar.
