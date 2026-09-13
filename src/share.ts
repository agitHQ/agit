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
import { builtinConfig, redactDeep, type RedactionConfig, type RedactionCounts } from "./redact.js";

export class StabilityError extends Error {
  constructor(detail: string) {
    super(
      "live conversion no longer extends what was already streamed — this is an adapter bug " +
        "(prefix stability is a documented guarantee). Stopping the share rather than rewriting " +
        `streamed history. Detail: ${detail}`,
    );
  }
}

/**
 * How long a file's mtime must have been stable before the idle fast path
 * will trust it. Two seconds is FAT's granularity, the coarsest in common
 * use; anything finer is covered by it. The comparison is strict, so an
 * mtime that counts as settled names a tick that is already over, and no
 * later write can land inside it. Exported for the tests that sit a poll
 * on either side of the window.
 */
export const MTIME_SETTLE_MS = 2000;

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

  /**
   * `redaction` is the project's config, not the built-in list.
   *
   * A live share re-converts from the native log rather than reading the
   * store, so it did its own redaction with the built-ins alone and never saw
   * `.agit/redact.json`. A custom pattern exists precisely because the
   * built-ins cannot know an internal token format, and share is the path
   * that puts the result in front of other people, so that was the one place
   * it had to apply and did not.
   */
  constructor(
    private readonly path: string,
    private readonly adapter: Adapter,
    private readonly redaction: RedactionConfig = builtinConfig(),
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
    //
    // The stat this poll may remember, once the content behind it has been
    // read and checked.
    let seen: { size: number; mtimeMs: number } | null = null;
    if (live) {
      const st = statSync(this.path);
      // ...but only once the file's mtime has had time to settle. Filesystems
      // report mtime at a coarse resolution — two seconds on FAT, and in
      // practice enough on Windows that CI caught this — so two writes inside
      // one tick leave size and mtime both unchanged. A same-size in-place
      // rewrite in that window would take the fast path out and never reach
      // the digest below, which is the one check that catches history being
      // rewritten. That is precisely the tampering PROTOCOL.md promises to
      // stop loudly, so the gate only applies to a file nothing has touched
      // recently. A long quiet session still costs one stat() per tick, which
      // is what the fast path was for; a file changed moments ago is re-read,
      // which is exactly when it matters.
      const settled = Date.now() - st.mtimeMs > MTIME_SETTLE_MS;
      if (settled && st.size === this.lastSize && st.mtimeMs === this.lastMtimeMs) return [];
      // And the pair is only worth remembering once it is settled. Remembering
      // it earlier left the hole open from the other side: a poll inside the
      // tick read the file and recorded (size, mtime), a same-size rewrite
      // later in that tick moved neither, and the first poll after the tick
      // found the file settled and matching, so the rewrite was never read
      // and the digest never ran. How long after does not matter, because a
      // slow push skips ticks and the gap between two polls is unbounded. A
      // settled stat names a tick that is already over, so any later write
      // has to move the mtime. The fast path is reached one poll later than
      // before, which a quiet session does not notice. What this still leans
      // on is the sharer's clock agreeing with the filesystem's to within the
      // window; a file server whose clock runs behind by more than that is
      // the same boundary as a backdated mtime, which the tests document.
      if (settled) seen = { size: st.size, mtimeMs: st.mtimeMs };
    }
    // A leading BOM is stripped here as at every other native-log read site.
    // Left in place it glues to the first record, the adapter skips that
    // record as unparseable, and a live share of the file is no longer the
    // chain an import of it produces. An editor re-save of the source before
    // `agit share <id>` is enough to get there.
    const lines = readFileSync(this.path, "utf8")
      .replace(/^\uFEFF/, "")
      .split("\n")
      .filter((l) => l.trim() !== "");
    let drafts: DraftEvent[];
    let sessionId: string;
    try {
      const res = this.adapter.convert(lines, { live, path: this.path });
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
    // Committed only now, with the content read, converted and checked.
    // Recording the stat before the read meant a read that failed (EBUSY
    // from a scanner holding the file on Windows, a stale handle on NFS)
    // still counted as processed: the next poll found the same settled
    // stat, took the fast path, and an appended tail sat unread until the
    // runtime wrote again or the share ended. Waiting for the checks as well
    // keeps a follower that just stopped on a rewrite from ever gating on
    // the rewritten bytes.
    if (seen !== null) {
      this.lastSize = seen.size;
      this.lastMtimeMs = seen.mtimeMs;
    }

    const fresh = drafts.slice(this.sentDrafts);
    if (fresh.length === 0) return [];

    for (const d of fresh) digest = sha256Hex(digest + canonicalJson(d));
    this.prefixDigest = digest;
    this.sentDrafts = drafts.length;

    const redacted = fresh.map((d) => ({
      ...d,
      payload: redactDeep(d.payload, this.redactions, this.redaction),
    }));
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
  /** The relay accepted steering for this share (see src/steer.ts). */
  steer?: boolean;
}

/** fetch() that turns "fetch failed" into an actionable first-run message. */
async function relayFetch(relayUrl: string, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(new URL(path, relayUrl), init);
  } catch (err) {
    throw new Error(
      `cannot reach the relay at ${relayUrl} — start one with \`agit relay\` (in another terminal), or pass --relay <url>`,
      { cause: err },
    );
  }
}

/**
 * The shape of a share id the relay is allowed to hand us. This is the same
 * alphabet the relay's own routes and store enforce, and it matters on the
 * client for a reason the relay's copy does not cover: the id becomes a
 * filename under .agit/shares/, both on write and on the rmSync that ends a
 * share. A relay answering with "../../package" would have overwritten, and
 * then deleted, a file outside the store. Anything from a relay is untrusted.
 */
const SHARE_ID = /^[A-Za-z0-9_-]{10,64}$/;

export async function createShare(
  relayUrl: string,
  ttlMs?: number,
  opts: { steer?: boolean } = {},
): Promise<ShareInfo> {
  const res = await relayFetch(relayUrl, "/api/shares", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(ttlMs ? { ttlMs } : {}), ...(opts.steer ? { steer: true } : {}) }),
  });
  if (!res.ok) throw new Error(`relay refused share creation: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    shareId?: unknown;
    writerToken?: unknown;
    ttlMs?: unknown;
    path?: unknown;
    steer?: unknown;
  };
  if (typeof body.shareId !== "string" || !SHARE_ID.test(body.shareId)) {
    throw new Error(
      `relay returned a share id agit will not use as a filename: ${JSON.stringify(body.shareId)}`,
    );
  }
  if (typeof body.writerToken !== "string" || body.writerToken === "") {
    throw new Error("relay returned no writer token");
  }
  if (typeof body.path !== "string" || !/^\/s\/[A-Za-z0-9_-]{10,64}$/.test(body.path)) {
    throw new Error(`relay returned a share path agit will not link to: ${JSON.stringify(body.path)}`);
  }
  const ttl =
    typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs) && body.ttlMs > 0 ? body.ttlMs : 0;
  // Steering was asked for and the relay did not echo it back: an older
  // relay that ignored the flag would forward no keys, and a share that
  // promised steering without it would be a lie — the caller refuses.
  if (opts.steer && body.steer !== true) {
    throw new Error("this relay does not support steering (it predates --steer); upgrade it or drop --steer");
  }
  return {
    shareId: body.shareId,
    writerToken: body.writerToken,
    ttlMs: ttl,
    viewUrl: new URL(body.path, relayUrl).toString(),
    steer: body.steer === true,
  };
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
  const res = await relayFetch(relayUrl, `/api/shares/${share.shareId}/head`, {
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

export interface InboxMessage {
  name: string;
  text: string;
  ts: string;
  /** The viewer claimed to steer; `key` is what they offered (writer inbox only). */
  steer?: boolean;
  key?: string;
}

export interface InboxHandlers {
  onMessage?: (msg: InboxMessage) => void;
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

/**
 * The most `agit pull` will buffer from a relay. A relay is untrusted, and
 * an unbounded res.text() let one that streams forever grow the process
 * until the OS killed it, and one that stops just past V8's string limit
 * fail with a bare "Cannot create a string longer than ..." after every
 * byte was already held. The relay caps its own inbound side at 25MB per
 * push and 200k events per share, so a real share sits far below this and
 * a body that passes it is the relay misbehaving; the pull refuses and
 * says so.
 */
export const PULL_BODY_LIMIT = 256 * 1024 * 1024;

/**
 * Read a response body with a byte budget, so the relay does not decide how
 * much memory the client spends. Cancelling the reader closes the socket,
 * which is what ends a stream that was never going to.
 */
async function readBounded(res: Response, limit: number): Promise<string> {
  const refuse = (): never => {
    throw new Error(
      `the relay sent more than ${Math.round(limit / (1024 * 1024))}MB for that share; agit pull ` +
        "will not buffer it (a share on a well-behaved relay is far smaller)",
    );
  };
  if (res.body === null) return "";
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body.cancel().catch(() => undefined);
    refuse();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      refuse();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Fetch a published share's whole event log (#72, `agit pull`).
 *
 * No writer token: this is the same bytes any viewer can download from the
 * share page, which is the point — pulling is adopting what was published,
 * not privileged access to it. The caller verifies the chain before storing
 * anything, exactly as adopting a `pr` bundle does.
 *
 * `limit` exists for the tests; the CLI takes the default.
 */
export async function fetchShareLog(
  relayUrl: string,
  shareId: string,
  limit: number = PULL_BODY_LIMIT,
): Promise<string[]> {
  const res = await relayFetch(relayUrl, `/api/shares/${shareId}/events.jsonl`);
  if (res.status === 404) {
    throw new Error(`no such share on ${relayUrl} — it may have expired (shares have a TTL)`);
  }
  if (!res.ok) throw new Error(`relay refused the log: ${res.status} ${await readBounded(res, limit)}`);
  return (await readBounded(res, limit)).split("\n").filter((l) => l.trim() !== "");
}

/**
 * Split a share link into the relay it lives on and the id on it, so
 * `agit pull <url>` needs no second flag. A bare id falls back to --relay.
 */
export function parseShareRef(ref: string, fallbackRelay: string): { relay: string; shareId: string } {
  if (/^https?:\/\//i.test(ref)) {
    const u = new URL(ref);
    const m = /^\/s\/([A-Za-z0-9_-]{10,})\/?$/.exec(u.pathname);
    if (!m) throw new Error(`that URL is not a share link (expected .../s/<id>): ${ref}`);
    return { relay: u.origin, shareId: m[1]! };
  }
  if (!/^[A-Za-z0-9_-]{10,}$/.test(ref)) {
    throw new Error(`not a share id or link: ${JSON.stringify(ref)}`);
  }
  return { relay: fallbackRelay, shareId: ref };
}
