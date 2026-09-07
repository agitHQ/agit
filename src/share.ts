/**
 * Client side of `agit share` (PROTOCOL.md v0).
 *
 * SessionFollower turns a growing native log into a growing agit event
 * chain. The adapter's live mode guarantees prefix stability, and the
 * follower verifies that guarantee on every poll rather than trusting it: if
 * a re-convert ever fails to extend what was already streamed, that is an
 * adapter bug and the share stops loudly instead of silently rewriting
 * history that viewers may already have verified.
 *
 * finish() converts once more in non-live mode, appending the tail a final
 * import would produce (EOF cost flush + session.end) — so a completed live
 * stream is byte-identical to `agit import` of the same file.
 */

import { readFileSync, statSync } from "node:fs";
import type { Adapter } from "./adapters/adapter.js";
import { canonicalJson } from "./format/canonical.js";
import { buildChain, sha256Hex } from "./format/hash.js";
import type { AgitEvent, DraftEvent } from "./format/events.js";
import { redactDeep, type RedactionCounts } from "./redact.js";

export class StabilityError extends Error {
  constructor(detail: string) {
    super(
      "live conversion no longer extends what was already streamed — this is an adapter bug " +
        "(prefix stability is a documented guarantee). Stopping the share rather than rewriting " +
        `streamed history. Detail: ${detail}`,
    );
  }
}

export class SessionFollower {
  readonly redactions: RedactionCounts = {};
  sessionId: string | null = null;
  private sentDrafts = 0;
  private nextSeq = 0;
  private lastHash: string | null = null;
  /** Rolling digest over the canonical form of every draft streamed so far. */
  private prefixDigest = "";
  private finished = false;
  /** stat() of the file when last converted; idle polls stop here. */
  private lastSize = -1;
  private lastMtimeMs = -1;

  constructor(
    private readonly path: string,
    private readonly adapter: Adapter,
  ) {}

  /** Convert the file as it stands and return newly chained (redacted) events. */
  poll(): AgitEvent[] {
    return this.step(true);
  }

  /** Append the tail a final import would add. Call once, when the share ends. */
  finish(): AgitEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return this.step(false);
  }

  private step(live: boolean): AgitEvent[] {
    if (this.finished && live) throw new Error("follower already finished");
    // Idle fast path: a poll where the file has not changed does one stat()
    // and nothing else — no read, no convert, no digest work. Long quiet
    // sessions cost O(1) per tick instead of a full re-read (#4).
    //
    // Growth (or any change) still re-reads and re-converts the WHOLE file:
    // byte-offset tailing was considered and rejected, because reading only
    // appended bytes is blind to in-place prefix rewrites — exactly the
    // history tampering the full-prefix digest below exists to catch.
    if (live) {
      const st = statSync(this.path);
      if (st.size === this.lastSize && st.mtimeMs === this.lastMtimeMs) return [];
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;
    }
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    let drafts: DraftEvent[];
    let sessionId: string;
    try {
      const res = this.adapter.convert(lines, { live });
      drafts = res.drafts;
      sessionId = res.sessionId;
    } catch {
      return []; // nothing convertible yet (e.g. no conversation records so far)
    }
    if (this.sessionId === null) this.sessionId = sessionId;
    else if (this.sessionId !== sessionId)
      throw new StabilityError(`session id changed from ${this.sessionId} to ${sessionId}`);

    if (drafts.length < this.sentDrafts) {
      throw new StabilityError(
        `re-convert produced ${drafts.length} drafts, fewer than the ${this.sentDrafts} already streamed`,
      );
    }
    // Full-prefix verification, not a boundary spot-check: recompute the
    // rolling digest over everything already streamed. Any rewrite of any
    // streamed draft — not just the last one — stops the share.
    let digest = "";
    for (let i = 0; i < this.sentDrafts; i++) digest = sha256Hex(digest + canonicalJson(drafts[i]));
    if (digest !== this.prefixDigest) {
      throw new StabilityError("previously streamed drafts changed content between polls");
    }

    const fresh = drafts.slice(this.sentDrafts);
    if (fresh.length === 0) return [];

    for (const d of fresh) digest = sha256Hex(digest + canonicalJson(d));
    this.prefixDigest = digest;
    this.sentDrafts = drafts.length;

    const redacted = fresh.map((d) => ({ ...d, payload: redactDeep(d.payload, this.redactions) }));
    const events = buildChain(this.sessionId, redacted, { seq: this.nextSeq, prev: this.lastHash });
    this.nextSeq += events.length;
    this.lastHash = events.length > 0 ? events[events.length - 1]!.hash : this.lastHash;
    return events;
  }
}

// ---------------------------------------------------------------------------
// Relay client
// ---------------------------------------------------------------------------

export interface ShareInfo {
  shareId: string;
  writerToken: string;
  ttlMs: number;
  viewUrl: string;
}

export async function createShare(relayUrl: string, ttlMs?: number): Promise<ShareInfo> {
  const res = await fetch(new URL("/api/shares", relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ttlMs ? { ttlMs } : {}),
  });
  if (!res.ok) throw new Error(`relay refused share creation: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { shareId: string; writerToken: string; ttlMs: number; path: string };
  return { ...body, viewUrl: new URL(body.path, relayUrl).toString() };
}

export async function pushEvents(relayUrl: string, share: ShareInfo, events: AgitEvent[]): Promise<void> {
  if (events.length === 0) return;
  const res = await fetch(new URL(`/api/shares/${share.shareId}/events`, relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${share.writerToken}` },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`relay refused events: ${res.status} ${await res.text()}`);
}

export interface ShareHead {
  events: number;
  lastHash: string | null;
  ended: boolean;
}

/** Where the relay's stored chain ends — the anchor for writer resume. */
export async function getShareHead(relayUrl: string, share: ShareInfo): Promise<ShareHead> {
  const res = await fetch(new URL(`/api/shares/${share.shareId}/head`, relayUrl), {
    headers: { authorization: `Bearer ${share.writerToken}` },
  });
  if (!res.ok) throw new Error(`relay refused head: ${res.status} ${await res.text()}`);
  return (await res.json()) as ShareHead;
}

export async function endShare(relayUrl: string, share: ShareInfo): Promise<void> {
  await fetch(new URL(`/api/shares/${share.shareId}/end`, relayUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${share.writerToken}` },
  }).catch(() => undefined); // best effort — TTL reaps it regardless
}

export interface InboxHandlers {
  onMessage?: (msg: { name: string; text: string; ts: string }) => void;
  onInfo?: (info: { live: boolean; viewers: number; events: number }) => void;
}

/**
 * Subscribe to the writer inbox (viewer messages + share info) over SSE.
 * Reconnects until aborted via the returned controller.
 */
export function openInbox(relayUrl: string, share: ShareInfo, handlers: InboxHandlers): AbortController {
  const ctl = new AbortController();
  void (async () => {
    while (!ctl.signal.aborted) {
      try {
        const res = await fetch(new URL(`/api/shares/${share.shareId}/inbox`, relayUrl), {
          headers: { authorization: `Bearer ${share.writerToken}`, accept: "text/event-stream" },
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`inbox: ${res.status}`);
        await readSse(
          res.body,
          (event, data) => {
            try {
              if (event === "msg") handlers.onMessage?.(JSON.parse(data));
              else if (event === "info") handlers.onInfo?.(JSON.parse(data));
            } catch {
              /* malformed frame from relay: ignore */
            }
          },
          ctl.signal,
        );
      } catch {
        if (ctl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  return ctl;
}

/** Minimal SSE parser: enough for the relay's own frames (event: + one data: line). */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string, data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) return;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data !== "") onFrame(event, data);
    }
  }
}
