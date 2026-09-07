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
import { SHARE_PAGE } from "./page.js";

export interface RelayOptions {
  port?: number;
  host?: string;
  maxShares?: number;
  maxEventsPerShare?: number;
  defaultTtlMs?: number;
  maxTtlMs?: number;
}

interface Share {
  id: string;
  writerToken: string;
  createdAt: number;
  ttlMs: number;
  ended: boolean;
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
  msgsPerMinute: 30,
};

export interface RelayHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startRelay(opts: RelayOptions = {}): Promise<RelayHandle> {
  const shares = new Map<string, Share>();
  const maxShares = opts.maxShares ?? 200;
  const maxEvents = opts.maxEventsPerShare ?? 200_000;
  const defaultTtl = opts.defaultTtlMs ?? 24 * 3600_000;
  const maxTtl = opts.maxTtlMs ?? 7 * 24 * 3600_000;

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of shares) {
      const grace = s.ended ? 30 * 60_000 : 0; // ended shares linger 30m for late viewers
      if (now - s.createdAt > s.ttlMs + grace) {
        for (const res of [...s.viewers, ...s.inboxes]) res.end();
        shares.delete(id);
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

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
      console.error("relay:", err instanceof Error ? err.message : err);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return text(res, 200, "agit relay v0 — POST /api/shares to create a share. See PROTOCOL.md.\n");
    }

    if (req.method === "POST" && path === "/api/shares") {
      if (shares.size >= maxShares) return json(res, 503, { error: "relay full" });
      const body = (await readBody(req, LIMITS.messageBody)) ?? {};
      const ttlMs = clampNum((body as { ttlMs?: unknown }).ttlMs, 60_000, maxTtl, defaultTtl);
      const share: Share = {
        id: randomBytes(16).toString("base64url"),
        writerToken: randomBytes(24).toString("base64url"),
        createdAt: Date.now(),
        ttlMs,
        ended: false,
        events: [],
        lastHash: null,
        viewers: new Set(),
        inboxes: new Set(),
        msgTimes: new Map(),
      };
      shares.set(share.id, share);
      return json(res, 201, {
        shareId: share.id,
        writerToken: share.writerToken,
        ttlMs,
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
        const sender = req.socket.remoteAddress ?? "unknown";
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
        const msg = {
          name: typeof nameV === "string" ? nameV.slice(0, LIMITS.messageName) : "viewer",
          text: textV.slice(0, LIMITS.messageText),
          ts: new Date(now).toISOString(),
        };
        broadcast(share, "msg", msg);
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
    for (const { line } of parsed) share.events.push(line);
    share.lastHash = last;
    for (const v of share.viewers) {
      for (let i = share.events.length - parsed.length; i < share.events.length; i++)
        sendEvent(v, i, share.events[i]!);
    }
    return null;
  }

  function infoOf(share: Share): { live: boolean; viewers: number; events: number; expiresAt: string } {
    return {
      live: !share.ended,
      viewers: share.viewers.size,
      events: share.events.length,
      expiresAt: new Date(share.createdAt + share.ttlMs).toISOString(),
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
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...share.viewers, ...share.inboxes]) writeOrShed(res, frame);
  }
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
