# Investigation: viewer message injection path for OpenClaw (#90)

Status: **investigation only** — no code changes, no feature implementation.

## Summary

OpenClaw's gateway-based, multi-agent architecture exposes real primitives
for delivering messages into a running session — unlike Claude Code, which
has no supported path at all. Two gateway RPC methods are relevant:
`chat.send` (triggers an agent turn) and `chat.inject` (appends to the
transcript without triggering a turn). Inter-session messaging tools
(`sessions_send`, `conversations_turn`) provide agent-to-agent routing.
The transcript schema carries a `provenance` metadata field that can
distinguish external/inter-session messages from direct user input.

However, using any of these paths from agit requires **operator-level
gateway authentication**, the agent treats delivered messages
indistinguishably from user input at the LLM level (the `[Inter-session
message]` text prefix is a soft signal, not a hard trust boundary), and
prompt injection via this channel is a known, documented, and unsolved
risk in the OpenClaw ecosystem.

**Recommendation: path exists but needs upstream changes before it is
safe.** Do not implement today. See [§ Recommendation](#recommendation)
for specifics.

---

## API & Auth Model

### Gateway RPC methods

OpenClaw runs a central **Gateway** process (Node.js) that manages all
session state, routing, and tool execution. Clients (Control UI, CLI,
WebChat, messaging bridges) communicate over a WebSocket protocol
(currently **Protocol v4**, JSON-RPC-style framing).

Two RPC methods can deliver content into a running session:

| method | effect | triggers agent turn? |
|---|---|---|
| `chat.send` | Admits a message into the session's active run, or starts a new turn if idle. Returns a `runId` and status. | **Yes** |
| `chat.inject` | Appends a note/message directly to the transcript without triggering an agent run or channel delivery. | **No** |

Both methods target a session identified by a **session key** formatted as
`agent:{agentId}:{channel}:{accountId}:{chatType}:{peerId}`, resolved via
`src/routing/session-key.ts` in the OpenClaw source.

### Agent-internal tools

OpenClaw also exposes session-management tools to the agent itself:

- **`sessions_send`** — sends a message to another session on the same
  gateway (inter-agent delegation).
- **`conversations_turn`** — sends to an external conversation and awaits
  a correlated reply.
- **`sessions_spawn`** — creates an isolated sub-agent session.

These are **agent-to-agent** primitives, not external injection points.
They are relevant because they define how inter-session messages appear in
the transcript (see below), but they are not directly callable by an
external viewer.

### Authentication

Gateway auth is configured via `gateway.auth.mode` in
`~/.openclaw/openclaw.json`. Four modes:

| mode | mechanism | scope granted |
|---|---|---|
| `token` | Bearer token (`OPENCLAW_GATEWAY_TOKEN` env or config) | Full operator (admin/read/write) |
| `password` | Shared secret (legacy) | Full operator |
| `trusted-proxy` | Identity headers from a reverse proxy | Per-user, proxy-determined |
| `none` | No auth (loopback dev only) | Full operator |

**Critical finding:** In `token` and `password` modes, authentication is
treated as **full operator access** — there is no way to issue a
narrow-scope credential that can only send viewer messages but not, for
example, read secrets, spawn sessions, or invoke tools. A viewer holding
the gateway token has the same authority as the session owner.

This means agit cannot safely hand a gateway credential to a viewer.
The `trusted-proxy` mode theoretically supports per-user scopes, but
would require the viewer to authenticate through the proxy — a deployment
topology agit cannot assume or enforce.

---

## Behavior on Delivered Message

### How it appears in the transcript

Messages delivered via `chat.send` are appended to the session's JSONL
transcript as entries with `role: "user"` — the same role as direct human
input. The transcript maintains `role: "user"` for LLM API compatibility.

Messages originating from inter-session communication (`sessions_send`)
are tagged with additional metadata:

- **`message.provenance.kind`** — set to `"inter_session"` for messages
  from other agents or external processes.
- **Text prefix** — the runtime prepends `[Inter-session message]` to the
  message body and sets `isUser=false` in the provenance metadata.

Messages delivered via `chat.inject` appear in the transcript but are
**not** forwarded to the LLM and do not trigger an agent turn. They serve
as UI-only annotations (status updates, notes).

### How the agent treats delivered content

This is the critical question: does the LLM distinguish an externally
delivered message from a human's direct input?

- **`chat.send`**: the message enters the agent's context window as a
  `role: "user"` turn. The agent processes it identically to a direct
  human message. There is **no hard trust boundary** at the LLM level.
- **`chat.inject`**: the message is transcript-only and does not enter the
  LLM context. Safe from prompt injection but also cannot influence the
  agent's behavior — it is effectively a log annotation.
- **Inter-session (`sessions_send`)**: the `[Inter-session message]` text
  prefix is a soft, in-band signal. The LLM can read it, but nothing
  prevents the LLM from treating the content as instructions. Security
  researchers have documented that this prefix is insufficient to prevent
  prompt injection.

### Rate limiting, validation, sanitization

- **Gateway-level**: authentication is all-or-nothing (see above). No
  per-method rate limiting is documented for `chat.send` or `chat.inject`.
- **Redaction**: OpenClaw applies `logging.redactPatterns` to transcript
  content before persistence, similar to agit's own redaction pipeline.
- **Sandbox**: OpenClaw has optional sandboxing for tool execution, but
  the message delivery path itself has no input sanitization beyond what
  the LLM provider enforces.

---

## Safety Analysis

### 1. Prompt injection

**Risk: HIGH.** A viewer message delivered via `chat.send` enters the LLM
context as `role: "user"` content. A malicious viewer can craft a message
that instructs the agent to:

- Execute arbitrary shell commands (if the agent has `exec` tool access)
- Read and exfiltrate file contents
- Modify files in the workspace
- Call external APIs via tool use

The `[Inter-session message]` prefix (only present on `sessions_send`
messages, not on `chat.send`) is a text-level hint that the LLM can
choose to ignore. It is not a security boundary.

This is not a theoretical risk — it is a **documented, known vulnerability
class** in the OpenClaw ecosystem, with published security research
confirming that adversarial prompts delivered via external channels can
drive unauthorized tool calls.

### 2. Existing isolation/tagging

OpenClaw provides two mechanisms that could theoretically help:

- **`provenance.kind = "inter_session"`**: present on `sessions_send`
  messages, absent on `chat.send`. Could be used by agit's adapter to tag
  viewer-originated messages differently in the agit event log. However,
  this tag is set by the *sender's* gateway, not enforced at the receiving
  end — an attacker with gateway access can forge it.
- **`chat.inject`**: does not enter the LLM context at all. Safe from
  prompt injection, but cannot influence the running session in any way
  the agent would respond to. This is "safe but useless" for the
  viewer-message use case.

Neither mechanism provides a **hard, verifiable trust boundary** between
viewer input and user input at the LLM level.

### 3. Blast radius

If a malicious viewer gains the ability to `chat.send` into a running
OpenClaw session:

| vector | impact |
|---|---|
| Arbitrary tool calls | Full local code execution via `exec`, `apply_patch`, etc. |
| File exfiltration | Agent reads files and includes content in its response, visible to the viewer |
| Workspace modification | Agent writes/deletes files as instructed |
| Credential exposure | Agent may echo environment variables or file contents containing secrets |
| Session hijacking | Viewer messages are indistinguishable from user input — the agent follows them |

The blast radius is **equivalent to giving the viewer a shell on the
operator's machine**, constrained only by whatever tool policy the
OpenClaw instance enforces (and tool policies are LLM-interpreted, not
mechanically enforced).

### 4. agit-specific concerns

Even if OpenClaw upstream eventually provides a safe injection path, agit
has its own constraints:

- **Viewer messages through the relay are unauthenticated** (any viewer
  with the share link can post). Bridging these to a gateway `chat.send`
  would give every anonymous share-link holder the ability to prompt-
  inject the running agent.
- **The relay's message rate limiting (30/min/sender)** is a DoS
  mitigation, not a security boundary — a single injected message is
  enough to compromise a session.
- **agit's event format has no event type for viewer-injected messages.**
  Adding one is a SPEC change (the most expensive kind of change per
  CONTRIBUTING.md).

---

## Recommendation

**Path exists but needs upstream changes before it is safe.**

Do not implement viewer message injection for OpenClaw today. The
specific blockers:

1. **No narrow-scope credential.** The gateway's auth model grants full
   operator access to any authenticated client. There is no way to issue a
   "viewer-only, can-send-messages" token. Until OpenClaw supports scoped
   credentials (or a dedicated, narrow message-injection endpoint), agit
   cannot safely bridge relay viewer messages to the gateway.

2. **No hard trust boundary at the LLM level.** Messages delivered via
   `chat.send` are indistinguishable from user input in the LLM context.
   The `provenance` metadata and `[Inter-session message]` prefix are
   soft, in-band signals that do not prevent prompt injection. Until
   OpenClaw (or the LLM providers it uses) offers a mechanism to present
   content as explicitly untrusted/viewer-originated at the model level,
   every delivered message is a prompt injection vector.

3. **agit's relay messages are unauthenticated.** Even if the gateway
   problem were solved, bridging unauthenticated relay messages to the
   agent requires a design for how the sharer opts in, how viewer identity
   flows through, and what the agent sees. This is feature design work
   that depends on upstream resolution of points 1 and 2.

### What would change this recommendation

Any **one** of the following would reopen the question:

- OpenClaw ships a dedicated, scoped "message injection" endpoint that
  does not grant operator access and tags messages with
  cryptographically-verified provenance (not just a text prefix).
- OpenClaw (or a supported LLM provider) introduces a hard trust level
  for context-window content — e.g., a role like `viewer` or `external`
  that models are trained to treat as untrusted data rather than
  instructions.
- The OpenClaw community reaches consensus on a safe injection pattern
  and documents it as a supported, stable API with a security model.

### Proposed README wording (no change today)

The existing claim is accurate and should **not** be changed:

> Claude Code has no supported way to inject input into a live
> interactive session, and agit does not pretend otherwise; if a runtime
> ever offers a real path, it gets wired per-adapter, opt-in.

If and when this recommendation changes, the proposed updated wording
would be:

> Claude Code has no supported way to inject input into a live
> interactive session. OpenClaw's gateway exposes messaging primitives
> (`chat.send`, `sessions_send`) that *can* deliver content into a
> running session, but these grant operator-level access and do not
> provide a hard trust boundary between viewer input and user input —
> agit does not wire them until a safe, scoped path exists upstream. If a
> runtime ever offers a real path, it gets wired per-adapter, opt-in.

---

## Appendix: source references

All OpenClaw paths cited in this report were verified against the
references already embedded in agit's adapter code and public
documentation:

- Session transcript schema: `src/agents/sessions/session-manager-types.ts`
  (referenced in [openclaw.ts L10–16](../../src/adapters/openclaw.ts))
- Transcript header: `src/config/sessions/transcript-header.ts`
  (referenced in [openclaw.ts L10](../../src/adapters/openclaw.ts))
- Session state dir: `src/config/state-dir.ts`
  (referenced in [discover.ts L11](../../src/discover.ts))
- Gateway protocol schema: `packages/gateway-protocol/src/schema.ts`
  (public, documented at docs.openclaw.ai)
- Gateway auth configuration: `gateway.auth.mode` in `openclaw.json`
  (documented at docs.openclaw.ai)
- CVE-2026-25253: WebSocket auth bypass in the Control UI
  (public advisory, patched in 2026.1.29+)
