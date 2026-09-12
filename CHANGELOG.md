# Changelog

Notable changes to agit. The event format itself is versioned separately
(SPEC.md §11); a spec bump is always called out here in bold.

## Unreleased

### Added

- **OpenClaw's agent database imports directly.** OpenClaw persists a
  session's transcript in `<state dir>/agents/<agent>/agent/openclaw-agent.sqlite`
  (`transcript_events`: `session_id`, `seq`, `event_json`), which is where
  the one real-log validation so far (#46) had to extract JSONL from by
  hand. `agit import openclaw-agent.sqlite` now reads the rows the way
  OpenClaw's own reader does — one session's `event_json` in `seq` order —
  and hands them to the same mapping the JSONL goes through, so a session
  imported from the database has the same chain as one imported from its
  transcript file. `import --all` finds the database beside the sessions
  directory. A database holds sessions rather than a session: every one in
  it is imported, one line each, and `--thread <id>` names one (this
  applies to LangGraph databases too, which previously refused without
  `--thread`).
- **LangGraph adapter.** `agit import <checkpoints.sqlite>` reads the
  database `langgraph-checkpoint-sqlite` writes and imports one thread's
  current history — human, AI (with tool calls and usage), and tool messages
  from the `messages` channel — as an ordinary session. The file is read
  directly: a zero-dependency SQLite reader (`src/sqlite.ts`: header, table
  b-trees, overflow chains, the record format) and a MessagePack decoder
  (`src/msgpack.ts`) for the checkpointer's serialization, each derived from
  its format document and validated against fixtures the real runtime
  wrote. The history followed is the parent chain from the checkpoint the
  saver itself returns as current; abandoned branches, subgraph namespaces
  and other threads are counted. `--thread <id>` picks a thread when a
  database holds several (the import refuses and lists them otherwise), and
  a database whose `-wal` sidecar holds unapplied pages is refused rather
  than read stale. No `file.diff` — LangGraph has no file-edit construct —
  and messages are dated by the checkpoint that first held them, counted.
  Adapters may now be binary (`detectBytes` / `convertBytes` on the
  interface), and `ConvertOptions.select` names a session within a file;
  `meta.json`'s `source` records it, so two threads from one file are two
  sessions rather than one "already imported".

- **`agit share --steer`: teammates can redirect the agent, not just watch
  it.** The share prints a steer key next to the link; a viewer who enters it
  — on the page, or with `agit steer <link> "<text>" --steer-key K` from a
  terminal — sends a message to the agent rather than only to the sharing
  terminal. Nothing is injected mid-run: the message is queued under
  `.agit/steer/` and handed over by Claude Code's own documented hooks at the
  next turn boundary (`Stop`, so the agent continues instead of stopping;
  `UserPromptSubmit`, so it rides with the next prompt when the agent was
  idle), through `hookSpecificOutput.additionalContext`, under Claude Code's
  own eight-continuation loop guard. `agit hook` is the command those hooks
  run and `agit hook --config` prints the `settings.json` fragment. Every
  message is shown in the sharing terminal first; a wrong key is shown,
  labelled, and delivered to nowhere. The relay forwards a key to the writer
  inbox only — other viewers see that a claim was made, never the key — and
  cannot check it, because only the sharer holds it. Only Claude Code is
  wired; `--steer` on any other runtime is refused with the reason (no
  documented turn-boundary hook), and a relay that predates the flag is
  refused too rather than promising a channel it would not carry. Protocol
  v0 gains `steer` on share creation and `info`, and an optional `key` on
  `/message`, both ignored by older peers.

### Fixed

Six high-severity findings from an adversarial review of everything shipped
since 0.5.0. Each was reproduced against the real CLI before being fixed,
and each reproduction is now a test.

- **A hostile relay could choose a filename on the client.** The share id a
  relay returns became `.agit/shares/<id>.json` on write and on the `rmSync`
  that ends a share, so a relay answering `../../package` overwrote and then
  deleted `package.json`. The client now holds the relay to the same id
  alphabet the relay's own routes enforce, and refuses a writer token or link
  path it would not use.
- **A session id differing only in case could overwrite another session.** On
  NTFS and APFS the exact-match existence check let a log for `DEMO-x` land
  in the directory for `demo-x`, replacing its events under the old
  `meta.json` so the victim then failed verification. The id comes from the
  log, which on a pull comes from the relay. Refused on every platform now,
  in `writeSession` itself, since a store has to survive being copied to a
  case-insensitive filesystem.
- **One malformed session took down every store-wide search.** A chain built
  over `payload: null` verifies, because verification never looked at the
  payload, and a bundle or pulled share could land one. Rendering it threw
  out of `agit grep` and the MCP `agit_grep` loop, losing hits from every
  healthy session. Payloads are checked at the read, and both searches now
  isolate rendering per session as they already isolated parsing.
- **One failed push wedged a live share, silently, with exit 0.** The
  follower's `poll()` advances its own state, so events handed over during a
  push the relay refused were gone for good; the relay then answered 409 to
  every later push, the catch swallowed each, and the sharer saw nothing
  while viewers stopped receiving events. Undelivered events are now held and
  retried, each failure is reported, and giving up leaves the share open and
  its resume state on disk rather than ending it and deleting the one thing
  `--resume` needs. Tampering detected on the final push is no longer
  swallowed either.
- **A torn last line in the relay store was served as an event.** A crash
  mid-append left a partial line that loaded as `share.events[N]`, so the
  count and the head disagreed, the next push was glued onto the fragment,
  and the restart after that lost it. A torn tail is now dropped and the file
  truncated to its last complete line; a bad line anywhere else is left for
  verification to name.
- **A failed persist left the relay's in-memory head advanced.** Memory moved
  before the disk write, so a full disk or a locked file returned 500 while
  `/head` advertised events the disk did not hold, a retry was refused as a
  duplicate, and the next push landed after a gap. The store is written
  first now; if it throws, nothing has changed and the retry is right.

Forty-five medium and low findings from the same review, one fixer per
file group, each reproduced against the built CLI before being changed and
each now guarded by a test that fails without its fix. By area:

- **ATIF import.** Observation results with no `source_call_id`, results
  naming a call that is not on their step, non-object steps, wrong-typed
  `tool_calls` / `observation.results` / `metrics`, and
  `subagent_trajectory_ref` were all dropped without a count; every one is
  counted now, and `records` is the length of the raw `steps` array. Steps
  marked `is_copied_context` are another trajectory's work and are left out
  and counted, with `continued_trajectory_ref` kept on `session.start` so
  the other file can be found. An agent name with a space or slash broke
  the derived id (sanitised now), an empty-string `trajectory_id` shadowed a
  real `session_id`, several id-less calls on one step shared a fallback id
  (it carries the call's position now), and `cost_usd: null` was hashed in
  as `costUsd: 0` (left out unless a finite number).
- **Cline SDK import.** `convert()` ignored `live`, so a live share of a
  running Cline session broke on the first update; it honours it now, which
  also means `updated_at` no longer enters the chain — **the hash of every
  Cline import changes relative to 0.8.0** (a field that changes on every
  write cannot sit in a prefix-stable log). The invented `"(missing)"` tool
  id, which paired unrelated calls and results in exports, is gone: a block
  without an id is recorded with `toolUseId: null` and counted. Timestamps
  outside the ISO range no longer abort the import or emit extended years;
  non-object content entries and wrong-typed text blocks are counted;
  non-numeric `metrics.cost` is left out rather than recorded as 0.
- **Exports (`--otel`, `--atif`).** Results and edits are paired with their
  call by position, not by id alone, so a second call under a duplicate id
  no longer inherits the first one's result; a result that names no call is
  kept unpaired — ATIF as an observation result without `source_call_id`,
  OTLP by naming the events on the root span — instead of being guessed at
  or dropped. Edits no call claims stay in both exports (OTLP root gains
  `agit.files.recorded` and `agit.files.lower_bound`; ATIF steps gain
  `agitFileEditsWithoutCall`). A zone-less `ts` is read as the UTC the SPEC
  declares, so the same log exports the same trace on every machine. Token
  counts beyond int64 or non-integer are refused rather than emitted into
  documents both validators reject. `agitSigned` now means "present and
  every signature verifies", with `agitSignatures` listing each verdict.
  **The OTLP root span id is now `sha256("agit-root:" + firstHash)[0:16]`**
  rather than the first event's own prefix, which collided with that
  event's child span when seq 0 was not `session.start`; child span ids are
  unchanged. An ATIF export with zero steps, which Harbor rejects, is
  refused; `--otel` no longer crashes on an adopted `meta.json` without
  `adapter`.
- **MCP server.** `agit_diff` reports a file whose path sanitises to
  nothing instead of failing the whole call; `agit_grep` rejects an unknown
  `type` (and `path` with a non-file type) by name instead of answering "no
  hits"; `agit_list` carries `verified` like every other answer; an unknown
  tool is `-32602` as the MCP spec files it, not `-32601`; JSON-RPC batches
  are accepted under the 2025-03-26 revision the server negotiates.
- **CLI.** `pull` no longer reads the project's own `meta.json` as the
  pulled session's; a `remotes.json` that is not an object no longer crashes
  `push` after publishing; `push` to a second `--relay` publishes there
  instead of being a silent no-op; `verify` and `sign` report a malformed
  `signatures` field instead of a bare TypeError, and `sign` refuses to add a
  name next to junk; `share --detach` on a live target is refused before a
  share exists, not after the link and the writer token were written;
  `relay --store` says at startup where shares are written and that the
  directory holds writer tokens.
- **Live follower.** The (size, mtime) pair is remembered only once settled,
  so a rewrite in the same tick as the first read cannot slip past the
  digest; a UTF-8 BOM is stripped so a live share stays byte-identical to
  its import; stat is committed only after a successful read, so one
  transient error no longer hides an appended tail; `pull` reads a bounded
  body instead of whatever a hostile relay sends.
- **Signing.** The OpenSSH loader derives the public key from the seed
  instead of trusting the file's copy, so a mismatched key file cannot
  produce a signature that never verifies; the raw key length is checked
  (a padded key line used to verify under a different fingerprint);
  small-order public keys are refused; the encrypted-key message no longer
  suggests an `ssh-keygen` command that would strip the passphrase from the
  original in place; README's sample output matches what `verify` prints.
- **Relay.** The reaper can no longer delete a share while a push is still
  reading its body (the push then answered 200 and recreated an orphan file
  in the store); `maxShares` is enforced after the body is read, so
  concurrent creates cannot overshoot it; store metadata is validated on
  load, so a file without numeric `createdAt`/`ttlMs` no longer loads as a
  share that never expires and throws on every stream.

Four items those fixers flagged as outside their file groups:

- **Publishing verbs now refuse a signature `verify` rejects.** `export`,
  `pr`, `push` and `share` gated on the chain alone, so a rechained log still
  carrying its original signature — the forgery signing exists to catch, and
  the one `verify` exits 1 on — could be exported, bundled, pushed and shared
  as signed provenance. The gate now gives the same verdict `verify` does and
  names the signature that failed.
- **Dollar amounts are no longer stored in the log (SPEC §5.9).** The
  OpenClaw, ATIF and Cline SDK adapters carried `cost.total`, `cost_usd` and
  `metrics.cost` under `native` — a price is a display-time computation from
  a table, and one hashed into an event is a stale snapshot nobody can
  verify, which is why the SPEC forbids it. Each figure the source held is
  counted as `cost-usd-not-stored (SPEC §5.9)` so the import report names
  the drop. **The hash of an OpenClaw, ATIF or Cline import that carried a
  price changes**; stored sessions still verify as they are, and a fresh
  import of the same log now produces the SPEC's shape.
- **One unusable path costs one file, not the operation.** A hash-verified
  edit at `/`, `.` or a path of nothing but separators has no segments a
  tree can place. `fork`, `diff` and `merge` threw `unusable path in log`
  for the whole run; they now skip that file — `fork` names it in `SEED.md`,
  `diff` counts it with the files it could not reconstruct — and carry on,
  as the MCP `agit_diff` already did.
- **An adopted `meta.json` without an adapter no longer crashes `show` or
  the adoption summary**, which printed a TypeError where the origin line
  belonged; it reads `unknown adapter`.

## 0.8.0 — 2026-09-11

### Added

- **Cline SDK import** (#63), the second adapter after ATIF that reads a
  published contract rather than one runtime's private layout. `agit import
  <id>.messages.json` ingests the format new Cline sessions land in from 4.0,
  which Cline documents as "the canonical replay/export artifact" and ships
  with a golden fixture and contract tests. Every field name is from that
  document and checked against that fixture: conversation, thinking, tool
  calls matched to results by id, and per-turn metrics including cache reads
  and writes.

  **It emits no `file.diff`, for a reason more specific than ATIF's.** The
  `editor` tool's create path converts LF to CRLF when, and only when, the
  operating system Cline ran on is Windows, and the log does not record which
  OS that was. A hash over `new_text` would be right on Linux and wrong on
  Windows — a hash agit did not compute over bytes it holds. Edit results
  carry only a diff the runtime truncates at 200 lines. So `editor` and
  `apply_patch` calls are recorded as the tool calls they are and counted as
  edits agit cannot verify; `blame`, `why`, `fork`, `merge` and `diff` have
  nothing to work with, and everything else does.

  The contract says consumers should tolerate unknown keys; tolerated here
  means counted, so an unknown content block is named in the report rather
  than vanishing. A contract version other than 1 is refused, since the
  contract bumps it only for breaking changes and reading one would mean
  guessing at what broke. The system prompt is counted, since agit has no
  system-message event; messages without a timestamp inherit the last seen
  and are counted; a file with none anywhere is refused rather than dated
  from the clock. The older VS Code globalStorage layout is undocumented and
  unversioned and is deliberately not read.

## 0.7.1 — 2026-09-11

### Fixed

Two redaction gaps, both found by @thegoodengineer, both in paths that put a
log in front of other people.

- **A live share redacted by the built-in patterns alone** (#113). A live
  share re-converts from the native log rather than reading the store, so the
  follower did its own redaction and never saw `.agit/redact.json`. On the
  same log with the same config, `import` redacted a custom token and the
  live share published it verbatim. A custom pattern exists precisely because
  the built-ins cannot know an internal token format, and share is the path
  that shows the result to others — so that was the one place it had to apply
  and the one place it did not. The follower now takes the project's config,
  and `share --resume` passes the same one deliberately: resume regenerates
  the chain against the head the relay holds, so a different rule there would
  change the bytes and break the prefix match.
- **The allowlist was undone by a second redaction pass on import** (#114).
  Import ran `redactDeep` twice, and the second call took no config, so it was
  the built-in list. A documented example key survived the pass that honoured
  the allowlist and was rewritten by the pass that did not. A merge artifact:
  #79 guarded the original line for `--no-redact` and #98 added a
  config-aware call above it, and both survived. The guard was redundant too,
  since `--no-redact` already flows through the config. One pass now, and each
  redaction is counted once.

## 0.7.0 — 2026-09-10

### Fixed

- **The live follower's idle fast path could skip the tamper check entirely.**
  While sharing live, the follower recomputes a rolling digest over everything
  already streamed, so a rewrite of already-sent history stops the share —
  the guarantee PROTOCOL.md makes. The fast path returned early when `stat()`
  reported the same size and mtime, and filesystems report mtime at a coarse
  resolution (two seconds on FAT, and enough on a Windows CI runner). Two
  writes inside one tick therefore left both unchanged, so a same-size
  in-place rewrite took the fast path out and the digest never ran. CI caught
  it; it was read as flake first, and it was not. The gate now applies only to
  a file whose mtime has been stable longer than the coarsest resolution in
  common use, so a quiet session keeps its one-syscall tick and a file changed
  moments ago is re-read. An mtime deliberately backdated still takes the fast
  path, which is left alone deliberately: anyone able to rewrite the file and
  backdate it already controls the log being read.

### Changed

- The test suite's timeout ceiling is 30s rather than vitest's 5s default.
  Most suites drive the real CLI, so one test can spawn twenty processes, and
  a loaded machine was failing tests that were doing nothing wrong. A real
  hang still fails, just later.

### Added

- **ATIF import** (#64), the first adapter that reads a standard rather than
  one runtime's private log. `agit import <trajectory.json>` ingests Harbor's
  Agent Trajectory Interchange Format, so anything emitting ATIF — Harbor's
  own agents, Terminus-2, whatever its OpenHands adapter converts — can be
  verified, replayed, searched, signed and shared. It is the import half of
  the `--atif` export added in #69, and the two round-trip: the conversation,
  the tool calls and the exact token totals survive.

  **It emits no `file.diff`, and that is the point rather than a gap.** ATIF
  has no file-edit construct; a write is an ordinary tool call whose result is
  prose. agit's file hashes are over bytes it actually holds, and a trajectory
  does not carry them — not even one agit exported, which records only the
  hashes of its edits. Reconstructing file events from those would mean
  emitting a hash agit did not compute, which is exactly what every other
  adapter refuses to do. So `blame`, `why`, `fork`, `merge` and `diff` have
  nothing to work with on an ATIF session, and everything else works.

  Every difference is accounted for in the import report rather than passed
  over: file edits whose content is absent, system steps (SPEC §5 has no
  system-message event), subagent trajectories (linearizing one would
  attribute a subagent's work to its parent), steps that inherited a
  timestamp, and how many model calls a single per-step metrics object stood
  for. A trajectory with no timestamps anywhere is refused rather than dated
  from the clock, which would make two imports of the same bytes differ
  (SPEC §7). The exporter now also sets `llm_call_count`, so a reader can tell
  five steps from seven calls.

## 0.6.0 — 2026-09-10

### Added

- **`agit push`, `agit pull`, `relay --store` and `share --detach`** (#72)
  turn the relay into a remote without changing the local model: a remote is
  just a relay someone else runs. `push` publishes a verified session and
  exits with a link; `pull` adopts it elsewhere over HTTP. Pull is the same
  code path as adopting a `pr` bundle, deliberately — the chain is verified
  before anything is stored and the events land byte for byte with the hashes
  the origin published, so **nothing here trusts the relay**: one altered byte
  produces a log that fails verification, which is the whole reason the chain
  exists, and there is a test that alters one. Pushing twice reuses the same
  link unless `--force` says otherwise, and pushing a session that does not
  verify is refused like every other publishing verb. `agit relay --store
  <dir>` persists shares across a restart as two flat files each, metadata
  rewritten whole and events appended — not a database, because agit has no
  runtime dependencies and `node:sqlite` needs Node 22 against a package that
  supports 20. The TTL survives a restart rather than resetting, a corrupt
  share costs one share instead of the relay's startup, and the head is
  recomputed from the events that actually loaded so a truncated file cannot
  claim a head it can no longer serve. That directory holds writer tokens and
  is documented as a credential store. `share --static --detach` prints the
  link and exits for CI; detaching from a *live* share is refused, since
  nothing would be left tailing the log.

- **`agit export --otel` and `agit export --atif`** (#69) turn a verified
  session into the shapes other tools already ingest. `--otel` emits OTLP/JSON
  spans following the OpenTelemetry GenAI semantic conventions — an
  `invoke_agent` root, `chat` children carrying token counts, `execute_tool`
  children — and `--atif` emits a Harbor Agent Trajectory Interchange Format
  document (ATIF-v1.8), the format Harbor uses for evals and fine-tuning and
  the one its OpenHands adapter converts OpenHands event logs into. Both are
  pure views over stored events; SPEC is unchanged. Every ATIF model forbids
  unknown keys, so the field names are exact and agit's own additions sit in
  each object's `extra`.
  Span ids are the first eight bytes of the event hash they came from, so a
  trace points back at a line of a log that can be verified, with the full
  hash alongside as an attribute. Output is deterministic, and an unverified
  session is refused for the same reason `export` refuses one. The GenAI
  conventions are at Development stability, moved repositories during 2026 and
  have never cut a release, so the export targets the current names
  (`gen_ai.provider.name`, not the renamed-away `gen_ai.system`;
  `cache_write`, not `cache_creation`) and emits the only schema URL that
  exists, which ends in `-dev`. `file.diff` has no equivalent in either
  format, so edits ride in each one's own extension field rather than being
  dropped or bent into a shape that means something else, with the SPEC §5.7
  lower bound stated beside them.

- **`agit sign <id> --key <file>`** (#68) binds a head to an Ed25519 key, and
  **SPEC §12** documents the signed payload so other implementations can
  verify without agit. The chain proves a log was not modified after it was
  chained; it never proved *who* chained it, since anyone can rebuild a valid
  chain over edited content with a matching `headHash`. `verify` now catches
  precisely that: the chain reports intact and the signature reports a
  mismatch, and the exit code is 1. The payload covers session id, head hash,
  event count and time — the count because truncation leaves every remaining
  hash valid, the session id so a signature cannot be lifted onto another
  session sharing a head. Reads the `~/.ssh/id_ed25519` most people already
  have, or any PKCS#8 PEM; encrypted keys are refused with the `ssh-keygen`
  command to fix it rather than prompting, because agit never handles a
  passphrase. Signing a log whose chain does not verify is refused outright.
  Signatures live in `meta.json`, never in the chain, so a session can be
  signed after import and by several people without rewriting an event, and
  they travel in `pr` bundles. The stored fingerprint is recomputed on every
  check, so a doctored one cannot make an unrelated key look familiar. What
  it still does not prove is *when*: the timestamp is signed and so cannot be
  edited afterwards, but it is the signer's own claim, and only a third-party
  RFC 3161 time-stamp would make it evidence.

- **`agit mcp`** (#66) serves the store to an agent over MCP on stdio, so an
  agent can consult its own verified history rather than that being something
  only a human can do with `grep`. Six read-only tools — `agit_list`,
  `agit_grep`, `agit_show`, `agit_replay`, `agit_diff`, `agit_verify` — and
  one server covers every runtime agit imports from, since Claude Code,
  Codex, Cursor, Gemini and Cline all speak MCP. Read-only is enforced rather
  than promised: no tool writes, nothing on this transport reaches `import`,
  `tag`, `rm` or the redaction config, and a test asserts the tool list can
  never grow one. Every answer carries whether that session's chain verifies,
  and a session that fails verification is still answered from and flagged
  rather than hidden, because refusing to read it would lose information the
  log still holds. Session logs are untrusted input, so each payload is
  labelled as recorded data rather than instructions, in a field no session
  can shadow. The JSON-RPC is written by hand: agit still has zero runtime
  dependencies.

- **`agit blame`, `agit why` and `agit link`** (#65) connect a line of code
  back to the moment it was written. `blame` attributes each line to the
  session and event that last wrote it; `why <file>:<line>` adds the prompt
  that asked for it and what the assistant said. Attribution stops at the
  first edit whose content contradicts what the log holds — proof the file
  changed outside structured edits (SPEC §5.7) — and says so rather than
  guessing past it. `link` prints an `Agit-Session: <id>@<seq> <hash>`
  trailer for a commit message, naming a real hash-chained event that
  `agit verify` can check.
- **`agit import --base <git-ref | dir>`** (#85) closes the verification
  window on files that predate a session. Codex and OpenClaw record a diff
  rather than the file when they update one, so agit could only verify an
  update to a file the session itself created; pointing `--base` at the
  commit or tree the session started from supplies the missing content, and
  the update verifies against real bytes. A base that does not match is
  refused, not assumed: the diff simply fails to apply and the edit is
  skipped and counted exactly as before, so a wrong `--base` can never
  produce a hash. `meta.json` records which base was used, and `show`
  reports it.
- **Redaction controls** (#70): custom patterns and an allowlist in
  `.agit/redact.json` (or `--redact-patterns <file>`), and `agit redact
  --check <log>` as a dry run that says what would be removed — event type,
  field path, which pattern matched, and a truncated preview rather than the
  secret itself — before anything is stored. After redacting, agit re-scans
  its own output and reports anything still matching, so the count can never
  read lower than the truth. The allowlist is what keeps a documented example
  key or a test fixture from being rewritten on import. `meta.json` records
  the posture a session was imported under — whether redaction ran, and how
  many custom patterns and allow rules were in force.
- **Store management** (#71): `agit tag`, `agit note`, `agit gc
  --older-than`, and `ls --tag/--runtime/--project/--sort`. Tags and notes
  live in a sidecar beside the session, never in the chain — they annotate a
  session without changing what it says. `ls` now shows the shortest unique
  id prefix, git-style, and filters apply to `--json` as well as the table so
  a script narrowing by tag sees the same set a human would. `rm` and `gc`
  say what will be lost first — event counts, tags, and the fact that a fork
  of a deleted session loses its merge base — then ask; `--yes` answers for
  a script, and with no terminal to ask on they refuse rather than assume.
- **`agit merge --session <id>` honours deletions** (#88). Schema v2 gave the
  log `file.delete`; a fork's own session now tells `merge` which files it
  removed after the fork point, so a deletion survives the round trip instead
  of reading as "untouched". Each one is checked against the fork point's
  content hash before anything is removed, a path the target changed since
  the fork is kept and reported as a conflict rather than deleted, and
  without `--session` the old rule stands: absence means untouched.
- **`agit merge` no longer needs git on PATH** (#89). A built-in line-based
  three-way merge takes over when `git merge-file` is missing, and `--no-git`
  forces it. git is still preferred where present, because its output is what
  everyone's expectations are calibrated against — and the two are now pinned
  to each other by differential tests covering conflicts, deletions,
  adjacent edits, a missing trailing newline and CRLF files.
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
  in the output instead of silently narrowing the totals. `--since` windows
  the scan and `--price <file>` costs it against a rate table you supply —
  agit ships no prices, and a model missing from the table is left uncosted
  rather than counted as free, which also leaves the total uncosted rather
  than presenting a partial sum as a whole one. Groups by `day` (default),
  `model`, `runtime` or `project`.
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

### Fixed

- `agit stats` printed only three of its eight columns. Resolving conflicts
  across the merge queue, a de-duplication pass matched object properties by
  shape and removed most of the table's column headers; the tests asserted
  only that the first column appeared, so a silently narrower report passed
  them. The header is restored, and the tests now assert the whole row for
  `stats` and for `show --by-model`, with and without a rate table. The stats
  table's columns are now a declared list rather than the header object's own
  keys, so losing a header is a compile error instead of a quietly narrower
  report — the header object had been serving as its own schema, which is why
  nothing objected.
- `agit stats --by model` and `--by day` key each row off a cost event, so a
  session that records none (every Codex session today) reached the total
  while appearing in no row, leaving the columns quietly failing to add up.
  Those sessions are now counted and reported, with a pointer to `--by
  runtime`, which can always place them. `--json` carries the count as
  `unattributedSessions`.

### Changed

- vitest 3 → 4.1.11, clearing the two open advisories against `@vitest/mocker`
  (path traversal via redirect mocks, GHSA; no fix exists on the 3.x line).
  agit ships zero runtime dependencies, so no released version was ever
  affected and the suite uses no mocking at all — but a dev toolchain with a
  known hole is still one worth closing. vitest 4 accepts Node
  `^20 || ^22 || >=24`, so `engines: ">=20"` is unchanged and CI still tests
  Node 20 and 22 on Linux and Windows. The build moved off esbuild and rollup
  onto rolldown as a result, which is vitest's own change, not a config one.

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
