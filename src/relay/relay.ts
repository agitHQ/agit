/**
 * The agit share relay (PROTOCOL.md, v0).
 *
 * A deliberately small HTTP server, node:http only: the CLI POSTs chained
 * events in, browsers watch over SSE, viewer messages flow back to the
 * sharing terminal. Everything lives in memory — nothing is persisted, and a
 * share dies at its TTL or when the sharer ends it. SSE + POST instead of
 * WebSocket keeps the dependency count at zero and survives dumb proxies;
 * browsers reconnect on their own (Last-Event-ID resumes the stream).
 *
 * Security posture: share links are unguessable 128-bit ids, writing needs a
 * separate bearer token, event payloads were redacted before they left the
 * sharer's machine, and the relay treats them as opaque text. The relay
 * checks seq/prev continuity at the boundary so a broken chain is refused at
 * write time; full hash verification is the viewer's job (download
 * events.jsonl and run `agit verify`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { SHARE_PAGE } from "./page.js";
import { openRelayStore, type RelayStore } from "./store.js";

export interface RelayOptions {
  port?: number;
  host?: string;
  maxShares?: number;
  maxEventsPerShare?: number;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  trustedProxies?: string[];
  /**
   * PEM certificate and private key. Both, or neither: a relay is HTTPS or it
   * is HTTP, never half of one. Everything above the socket is identical --
   * same routes, same tokens, same SSE framing.
   */
  tls?: { cert: string; key: string };
  /**
   * Directory to persist shares in (#72). Without it the relay is in-memory
   * and a restart drops everything, which is the difference between a relay
   * and a remote. The writer token is stored here, so the directory is a
   * credential store — see src/relay/store.ts.
   */
  store?: string;
}

interface Share {
  id: string;
  writerToken: string;
  createdAt: number;
  ttlMs: number;
  ended: boolean;
  /**
   * The sharer opted into steering: a viewer message may carry a `key`,
   * which the relay forwards to the writer inbox alone (never to other
   * viewers) and does not check — only the sharer holds the steer key. The
   * flag is published in `info` so the page can show the key field.
   */
  steer: boolean;
  /** Raw event JSON strings, index === seq. */
  events: string[];
  lastHash: string | null;
  viewers: Set<ServerResponse>;
  inboxes: Set<ServerResponse>;
  /**
   * Send timestamps for the /message endpoint, keyed by remote address —
   * NOT a single shared bucket. That endpoint has no auth (any viewer with
   * the link can post), so a per-share bucket let one viewer exhaust the
   * whole share's chat quota and silence every other viewer for the sharer.
   */
  msgTimes: Map<string, number[]>;
}

const LIMITS = {
  pushBody: 25 * 1024 * 1024,
  /**
   * Backpressure bound per SSE connection: a viewer that cannot drain its
   * stream (dead link, glacial network) accumulates outbound buffer on the
   * relay. Past this, the connection is shed — the browser's EventSource
   * reconnects with Last-Event-ID and catches up from the buffer, so a
   * healthy-but-slow viewer loses nothing; an unhealthy one stops costing
   * memory. Without a bound, one stuck viewer holds the whole share's
   * buffer twice over, per connection, forever (#4).
   */
  maxBufferedPerConnection: 8 * 1024 * 1024,
  messageBody: 8 * 1024,
  messageText: 4000,
  messageName: 40,
  steerKey: 64,
  msgsPerMinute: 30,
};

export interface RelayHandle {
  server: Server;
  port: number;
  /** The scheme this relay actually speaks, so callers build links that work. */
  scheme: "http" | "https";
  close(): Promise<void>;
}

export function startRelay(opts: RelayOptions = {}): Promise<RelayHandle> {
  const shares = new Map<string, Share>();
  const maxShares = opts.maxShares ?? 200;
  const maxEvents = opts.maxEventsPerShare ?? 200_000;
  const defaultTtl = opts.defaultTtlMs ?? 24 * 3600_000;
  const maxTtl = opts.maxTtlMs ?? 7 * 24 * 3600_000;
  const trustedProxies = new Set(opts.trustedProxies ?? []);
  const store: RelayStore | null = opts.store === undefined ? null : openRelayStore(opts.store);

  // Rehydrate before serving, so a restart is invisible to anyone holding a
  // link. Viewers and inboxes are per-connection and deliberately not stored.
  if (store !== null) {
    for (const { meta, events } of store.load(Date.now())) {
      shares.set(meta.id, {
        id: meta.id,
        writerToken: meta.writerToken,
        createdAt: meta.createdAt,
        ttlMs: meta.ttlMs,
        ended: meta.ended,
        steer: meta.steer === true,
        events,
        // Recompute from what actually loaded rather than trusting the
        // recorded head: a truncated events file must not claim a head it
        // cannot serve, or the next push would extend a chain with a hole.
        lastHash: lastHashOf(events),
        viewers: new Set(),
        inboxes: new Set(),
        msgTimes: new Map(),
      });
    }
  }

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of shares) {
      const grace = s.ended ? 30 * 60_000 : 0; // ended shares linger 30m for late viewers
      if (now - s.createdAt > s.ttlMs + grace) {
        for (const res of [...s.viewers, ...s.inboxes]) res.end();
        shares.delete(id);
        store?.remove(id);
      }
    }
  }, 60_000);
  reaper.unref();

  const heartbeat = setInterval(() => {
    for (const s of shares.values()) {
      for (const res of [...s.viewers, ...s.inboxes]) res.write(":hb\n\n");
    }
  }, 15_000);
  heartbeat.unref();

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
      console.error("relay:", err instanceof Error ? err.message : err);
    });
  };
  // node:https' server is a node:http server with a TLS socket underneath, so
  // every handler, route and SSE write below is shared verbatim.
  const scheme: "http" | "https" = opts.tls ? "https" : "http";
  const server: Server = opts.tls
    ? createTlsServer({ cert: opts.tls.cert, key: opts.tls.key }, onRequest)
    : createServer(onRequest);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return text(res, 200, "agit relay v0 — POST /api/shares to create a share. See PROTOCOL.md.\n");
    }

    if (req.method === "POST" && path === "/api/shares") {
      if (shares.size >= maxShares) return json(res, 503, { error: "relay full" });
      const body = (await readBody(req, LIMITS.messageBody)) ?? {};
      // Check again after the await. Several creates whose bodies trickle in
      // (chunked, or a slow uplink) all passed the check above while the map
      // was still under the limit, then all got created once their bodies
      // landed: --max-shares 1 held five shares, and with --store every one
      // of them was a meta file in the credential directory. This endpoint
      // needs no token, so the limit is the only guard on share creation.
      if (shares.size >= maxShares) return json(res, 503, { error: "relay full" });
      const ttlMs = clampNum((body as { ttlMs?: unknown }).ttlMs, 60_000, maxTtl, defaultTtl);
      const steer = (body as { steer?: unknown }).steer === true;
      const share: Share = {
        id: randomBytes(16).toString("base64url"),
        writerToken: randomBytes(24).toString("base64url"),
        createdAt: Date.now(),
        ttlMs,
        ended: false,
        steer,
        events: [],
        lastHash: null,
        viewers: new Set(),
        inboxes: new Set(),
        msgTimes: new Map(),
      };
      shares.set(share.id, share);
      store?.create({
        id: share.id,
        writerToken: share.writerToken,
        createdAt: share.createdAt,
        ttlMs: share.ttlMs,
        ended: false,
        steer,
        lastHash: null,
      });
      return json(res, 201, {
        shareId: share.id,
        writerToken: share.writerToken,
        ttlMs,
        steer,
        path: `/s/${share.id}`,
      });
    }

    if (req.method === "GET" && /^\/s\/[A-Za-z0-9_-]{10,}$/.test(path)) {
      // Serve the page even for unknown ids; it shows "expired" when the stream 404s.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end(SHARE_PAGE);
      return;
    }

    const m = /^\/api\/shares\/([A-Za-z0-9_-]{10,})\/([a-z.]+)$/.exec(path);
    if (m) {
      const share = shares.get(m[1]!);
      const verb = m[2]!;
      if (!share) return json(res, 404, { error: "no such share (expired?)" });

      if (verb === "events" && req.method === "POST") {
        if (!authed(req, share)) return json(res, 401, { error: "bad writer token" });
        if (share.ended) return json(res, 409, { error: "share already ended" });
        const body = await readBody(req, LIMITS.pushBody);
        // The reaper can run while the body is still arriving. It removed the
        // share from the map and unlinked both files; appending to the object
        // captured above then answered 200 for a share that no longer existed
        // and recreated <id>.jsonl on disk with only this batch in it, a file
        // load() never enumerates (it looks for .json) and the reaper never
        // removes. Re-fetch, and refuse if the share is not the one we hold.
        if (shares.get(share.id) !== share) return json(res, 404, { error: "no such share (expired?)" });
        const events = (body as { events?: unknown })?.events;
        if (!Array.isArray(events) || events.length === 0)
          return json(res, 400, { error: "body must be {events: [...]}" });
        if (share.events.length + events.length > maxEvents)
          return json(res, 413, { error: "share event limit reached" });
        const err = appendEvents(share, events);
        if (err) return json(res, 409, { error: err });
        return json(res, 200, { stored: share.events.length });
      }

      if (verb === "end" && req.method === "POST") {
        if (!authed(req, share)) return json(res, 401, { error: "bad writer token" });
        share.ended = true;
        store?.setEnded(share.id, true);
        broadcast(share, "info", infoOf(share));
        return json(res, 200, { ended: true });
      }

      if (verb === "head" && req.method === "GET") {
        // Writer resume: where does the stored chain end? A restarted CLI
        // re-derives its chain (conversion is deterministic), verifies its
        // event at events-1 carries this lastHash, and pushes only the tail.
        if (!authed(req, share)) return json(res, 401, { error: "bad writer token" });
        return json(res, 200, { events: share.events.length, lastHash: share.lastHash, ended: share.ended });
      }

      if (verb === "stream" && req.method === "GET") {
        sseHead(res);
        share.viewers.add(res);
        const from = parseLastEventId(req) + 1;
        res.write(`event: info\ndata: ${JSON.stringify(infoOf(share))}\n\n`);
        for (let i = from; i < share.events.length; i++) sendEvent(res, i, share.events[i]!);
        onClose(res, () => {
          share.viewers.delete(res);
          broadcast(share, "info", infoOf(share));
        });
        broadcast(share, "info", infoOf(share));
        return;
      }

      if (verb === "inbox" && req.method === "GET") {
        if (!authed(req, share)) return json(res, 401, { error: "bad writer token" });
        sseHead(res);
        share.inboxes.add(res);
        res.write(`event: info\ndata: ${JSON.stringify(infoOf(share))}\n\n`);
        onClose(res, () => share.inboxes.delete(res));
        return;
      }

      if (verb === "message" && req.method === "POST") {
        const now = Date.now();
        const sender = senderIdentity(req, trustedProxies);
        const recent = (share.msgTimes.get(sender) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= LIMITS.msgsPerMinute) {
          share.msgTimes.set(sender, recent);
          return json(res, 429, { error: "slow down" });
        }
        const body = await readBody(req, LIMITS.messageBody);
        const textV = (body as { text?: unknown })?.text;
        if (typeof textV !== "string" || textV.trim() === "") {
          share.msgTimes.set(sender, recent);
          return json(res, 400, { error: "body must be {text, name?}" });
        }
        recent.push(now);
        share.msgTimes.set(sender, recent);
        const nameV = (body as { name?: unknown })?.name;
        const keyV = (body as { key?: unknown })?.key;
        const msg = {
          name: typeof nameV === "string" ? nameV.slice(0, LIMITS.messageName) : "viewer",
          text: textV.slice(0, LIMITS.messageText),
          ts: new Date(now).toISOString(),
        };
        // A key is a viewer's claim to steer. Viewers see that a claim was
        // made (so the chat reads honestly), never the key itself; the
        // writer inbox gets the key and decides. Off a steering share the
        // key is dropped: there is nothing on the other end to check it.
        const key =
          share.steer && typeof keyV === "string" && keyV !== "" ? keyV.slice(0, LIMITS.steerKey) : null;
        if (key === null) {
          broadcast(share, "msg", msg);
        } else {
          const claim = { ...msg, steer: true };
          for (const v of share.viewers) writeOrShed(v, frameOf("msg", claim));
          for (const i of share.inboxes) writeOrShed(i, frameOf("msg", { ...claim, key }));
        }
        return json(res, 200, { delivered: true });
      }

      if (verb === "events.jsonl" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "application/jsonl; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        for (const line of share.events) res.write(line + "\n");
        res.end();
        return;
      }
    }

    json(res, 404, { error: "not found" });
  }

  /** Boundary integrity: seq contiguity and prev linkage. Refuse broken chains at write time. */
  function appendEvents(share: Share, events: unknown[]): string | null {
    const parsed: { line: string; hash: string }[] = [];
    let seq = share.events.length;
    let last = share.lastHash;
    for (const e of events) {
      const ev = e as { seq?: unknown; prev?: unknown; hash?: unknown; type?: unknown; v?: unknown };
      if (typeof ev !== "object" || ev === null) return "event is not an object";
      if (ev.seq !== seq) return `expected seq ${seq}, got ${String(ev.seq)}`;
      if ((ev.prev ?? null) !== last) return `event ${seq}: prev does not extend the stored chain`;
      if (typeof ev.hash !== "string") return `event ${seq}: missing hash`;
      parsed.push({ line: JSON.stringify(e), hash: ev.hash });
      last = ev.hash;
      seq++;
    }
    // Persist FIRST, then advance memory. The other order let a failed write
    // (ENOSPC, EPERM, an antivirus holding the file) return 500 while the
    // in-memory head had already moved: /head then advertised events the disk
    // did not hold, a retry of the same batch was refused as a duplicate, and
    // the writer's next push landed after a gap, leaving a hole in the on-disk
    // chain that a restart served as seqs [0,1,2,6,7,8]. If the append throws
    // now, nothing has changed and the client's retry is exactly right.
    store?.append(
      share.id,
      parsed.map((x) => x.line),
      last,
    );
    for (const { line } of parsed) share.events.push(line);
    share.lastHash = last;
    for (const v of share.viewers) {
      for (let i = share.events.length - parsed.length; i < share.events.length; i++)
        sendEvent(v, i, share.events[i]!);
    }
    return null;
  }

  /** The hash of the last parseable event, so a truncated file cannot claim a head. */
  function lastHashOf(events: string[]): string | null {
    for (let i = events.length - 1; i >= 0; i--) {
      try {
        const h = (JSON.parse(events[i]!) as { hash?: unknown }).hash;
        if (typeof h === "string") return h;
      } catch {
        continue;
      }
    }
    return null;
  }

  function infoOf(share: Share): {
    live: boolean;
    viewers: number;
    events: number;
    expiresAt: string;
    steer: boolean;
  } {
    return {
      live: !share.ended,
      viewers: share.viewers.size,
      events: share.events.length,
      expiresAt: new Date(share.createdAt + share.ttlMs).toISOString(),
      steer: share.steer,
    };
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7717, opts.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 7717);
      resolve({
        server,
        port,
        scheme,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(reaper);
            clearInterval(heartbeat);
            for (const s of shares.values()) for (const res of [...s.viewers, ...s.inboxes]) res.destroy();
            server.close(() => r());
          }),
      });
    });
  });

  function broadcast(share: Share, event: string, data: unknown): void {
    const frame = frameOf(event, data);
    for (const res of [...share.viewers, ...share.inboxes]) writeOrShed(res, frame);
  }
}

function frameOf(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sendEvent(res: ServerResponse, seq: number, line: string): void {
  writeOrShed(res, `event: ev\nid: ${seq}\ndata: ${line}\n\n`);
}

/** Write one SSE frame; shed the connection if its outbound buffer is past the bound. */
function writeOrShed(res: ServerResponse, frame: string): void {
  // A broadcast iterates a snapshot, so a connection shed earlier in the same
  // loop (or tick) can still appear here — writing to it would raise
  // ERR_STREAM_DESTROYED. Skip it; its close handler already deregistered it.
  if (res.destroyed || res.writableEnded) return;
  res.write(frame);
  if (res.writableLength > LIMITS.maxBufferedPerConnection) res.destroy();
}

function sseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.write(":ok\n\n");
}

function onClose(res: ServerResponse, fn: () => void): void {
  res.on("close", fn);
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

function senderIdentity(req: IncomingMessage, trustedProxies: Set<string>): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (!trustedProxies.has(remote)) return remote;

  const raw = req.headers["x-forwarded-for"];
  const forwarded = typeof raw === "string" ? raw.split(",").map((v) => v.trim()) : [];

  for (let i = forwarded.length - 1; i >= 0; i--) {
    const candidate = forwarded[i];
    if (candidate && !trustedProxies.has(candidate)) return candidate;
  }

  return remote;
}

function authed(req: IncomingMessage, share: Share): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(share.writerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
}
