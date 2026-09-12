import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent } from "../src/format/events.js";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";
import { openRelayStore } from "../src/relay/store.js";
import { createShare, endShare, fetchShareLog, parseShareRef, pushEvents } from "../src/share.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const SESSION = "demo-ratelimit-0001";

/**
 * Run the CLI *asynchronously*.
 *
 * The relay under test runs inside this process, and execFileSync blocks the
 * event loop — so a child that talks to that relay waits forever for a reply
 * the blocked loop can never send. Every CLI call that touches the relay has
 * to leave the loop turning.
 */
function agit(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const code = (err as { code?: number } | null)?.code ?? 0;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, out: stdout + stderr });
    });
  });
}

/** Synchronous is fine where nothing needs to reach the in-process relay. */
function agitSync(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

let EVENTS: AgitEvent[];
beforeAll(() => {
  const lines = readFileSync(SIMPLE, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const c = claudeCodeAdapter.convert(lines);
  EVENTS = buildChain(c.sessionId, c.drafts);
});

const open: RelayHandle[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});

async function relayWith(store?: string): Promise<{ handle: RelayHandle; base: string }> {
  const handle = await startRelay({ port: 0, ...(store !== undefined ? { store } : {}) });
  open.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

function storeDir(): string {
  return mkdtempSync(join(tmpdir(), "agit-relaystore-"));
}

describe("relay --store keeps shares across a restart (#72)", () => {
  it("serves the same share after the relay is restarted", async () => {
    const dir = storeDir();
    const first = await relayWith(dir);
    const share = await createShare(first.base);
    await pushEvents(first.base, share, EVENTS);
    await endShare(first.base, share);
    await first.handle.close();
    open.length = 0;

    // A restart is where an in-memory relay stops being a remote.
    const second = await relayWith(dir);
    const lines = await fetchShareLog(second.base, share.shareId);
    expect(lines.length).toBe(EVENTS.length);
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 0 });
  });

  it("forgets everything without --store, which is the default", async () => {
    const first = await relayWith();
    const share = await createShare(first.base);
    await pushEvents(first.base, share, EVENTS);
    await first.handle.close();
    open.length = 0;

    // A fresh relay with no store has never heard of that share. Binding the
    // same port again would be the more literal restart, but a just-closed
    // port is not reliably free, and the property under test is the same.
    const second = await relayWith();
    await expect(fetchShareLog(second.base, share.shareId)).rejects.toThrow(/no such share/);
  });

  it("keeps accepting pushes onto a chain it reloaded from disk", async () => {
    const dir = storeDir();
    const first = await relayWith(dir);
    const share = await createShare(first.base);
    await pushEvents(first.base, share, EVENTS.slice(0, 3));
    await first.handle.close();
    open.length = 0;

    // The reloaded head has to be right, or the next push is rejected as not
    // extending the chain.
    const second = await relayWith(dir);
    await pushEvents(second.base, share, EVENTS.slice(3));
    expect((await fetchShareLog(second.base, share.shareId)).length).toBe(EVENTS.length);
  });

  it("does not resurrect a share whose TTL ran out while the relay was down", async () => {
    const dir = storeDir();
    const store = openRelayStore(dir);
    store.create({
      id: "expired-share-aaaaaaaa",
      writerToken: "t",
      createdAt: Date.now() - 10 * 3600_000,
      ttlMs: 3600_000,
      ended: true,
      lastHash: null,
    });
    // The clock keeps running while the process is not.
    expect(store.load(Date.now())).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("skips one corrupt share rather than failing to start", async () => {
    const dir = storeDir();
    const store = openRelayStore(dir);
    store.create({
      id: "goodshare-aaaaaaaaaa",
      writerToken: "t",
      createdAt: Date.now(),
      ttlMs: 3600_000,
      ended: false,
      lastHash: null,
    });
    writeFileSync(join(dir, "badshare-bbbbbbbbbb.json"), "{ not json", "utf8");
    const loaded = store.load(Date.now());
    expect(loaded.map((l) => l.meta.id)).toEqual(["goodshare-aaaaaaaaaa"]);
  });

  it("recomputes the head from the events it actually loaded", async () => {
    // A truncated events file must not claim a head it cannot serve, or the
    // next push extends a chain with a hole in it.
    const dir = storeDir();
    const first = await relayWith(dir);
    const share = await createShare(first.base);
    await pushEvents(first.base, share, EVENTS);
    await first.handle.close();
    open.length = 0;

    const file = join(dir, `${share.shareId}.jsonl`);
    const kept = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, 2);
    writeFileSync(file, kept.join("\n") + "\n", "utf8");

    const second = await relayWith(dir);
    expect((await fetchShareLog(second.base, share.shareId)).length).toBe(2);
    // The head is event 1's hash now, so pushing event 2 onward must work.
    await pushEvents(second.base, share, EVENTS.slice(2));
    expect((await fetchShareLog(second.base, share.shareId)).length).toBe(EVENTS.length);
  });

  it("refuses a share id that could escape the directory", () => {
    const dir = storeDir();
    const store = openRelayStore(dir);
    store.create({
      id: "../../escape",
      writerToken: "t",
      createdAt: Date.now(),
      ttlMs: 3600_000,
      ended: false,
      lastHash: null,
    });
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("skips a meta whose clock fields are missing or the wrong type", () => {
    // A meta with no createdAt or ttlMs used to load: the TTL comparison was
    // NaN, so the reaper never expired it, and every /end and /stream on it
    // threw "Invalid time value". The header promises one bad file costs one
    // share, skipped with a warning, not a share that is half broken forever.
    const dir = storeDir();
    const bad: Record<string, unknown>[] = [
      { id: "noclock-aaaaaaaaaaaa", writerToken: "t", ended: false, lastHash: null },
      { id: "strttl-bbbbbbbbbbbbb", writerToken: "t", createdAt: Date.now(), ttlMs: "1h", ended: false },
      { id: "nanat-cccccccccccccc", writerToken: "t", createdAt: null, ttlMs: 3600_000, ended: false },
      { id: "strend-dddddddddddd", writerToken: "t", createdAt: Date.now(), ttlMs: 3600_000, ended: "no" },
    ];
    for (const meta of bad)
      writeFileSync(join(dir, `${meta.id as string}.json`), JSON.stringify(meta) + "\n", "utf8");
    const store = openRelayStore(dir);
    store.create({
      id: "goodshare-aaaaaaaaaa",
      writerToken: "t",
      createdAt: Date.now(),
      ttlMs: 3600_000,
      ended: false,
      lastHash: null,
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(store.load(Date.now()).map((l) => l.meta.id)).toEqual(["goodshare-aaaaaaaaaa"]);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("skipping"))).toHaveLength(
        bad.length,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("relay limits hold across an awaited body", () => {
  it("refuses a push whose share the reaper removed while the body was still arriving", async () => {
    const dir = storeDir();
    const ticks = captureIntervals();
    let base: string;
    try {
      ({ base } = await relayWith(dir));
    } finally {
      ticks.restore();
    }
    const share = await createShare(base);
    await pushEvents(base, share, EVENTS.slice(0, 2));

    // Headers and half the body, then hold the request open: a slow uplink.
    const slow = slowPost(base, `/api/shares/${share.shareId}/events`, share.writerToken, {
      events: EVENTS.slice(2, 4),
    });
    await new Promise((r) => setTimeout(r, 150));

    // The share's TTL runs out under the reaper, which unlinks both files.
    ticks.fire(Date.now() + 10 * 24 * 3600_000);
    expect(readdirSync(dir)).toHaveLength(0);

    // The completed push must not land on the object the handler captured
    // before the await: that answered 200 for a share that no longer existed
    // and recreated <id>.jsonl on its own, a file load() never enumerates and
    // the reaper never removes.
    const res = await slow.finish();
    expect(res.status).toBe(404);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("holds --max-shares when several creates have slow bodies", async () => {
    const dir = storeDir();
    const handle = await startRelay({ port: 0, store: dir, maxShares: 1 });
    open.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;

    // Every request passes the size check while the map is still empty; the
    // check has to hold again once the bodies land, or --max-shares 1 holds
    // four shares and, with --store, four meta files in the credential
    // directory. The endpoint needs no token, so this is the only guard.
    const slow = Array.from({ length: 4 }, () => slowPost(base, "/api/shares", null, {}));
    await new Promise((r) => setTimeout(r, 150));
    const statuses = (await Promise.all(slow.map((s) => s.finish()))).map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 503)).toHaveLength(3);
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });
});

/**
 * Capture the intervals a relay registers while it starts, so a test can
 * fire the reaper on demand instead of waiting for its 60s tick. `fire`
 * runs them with Date.now pinned to `at`, which is how a TTL runs out.
 */
function captureIntervals(): { fire(at: number): void; restore(): void } {
  const fns: (() => void)[] = [];
  const real = globalThis.setInterval;
  const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
    fns.push(fn);
    return real(fn, ms);
  }) as unknown as typeof setInterval);
  return {
    fire(at) {
      const clock = vi.spyOn(Date, "now").mockReturnValue(at);
      try {
        for (const fn of fns) fn();
      } finally {
        clock.mockRestore();
      }
    },
    restore: () => spy.mockRestore(),
  };
}

/**
 * POST a JSON body in two chunks, holding the request open between them.
 * The relay's handler is then parked on `await readBody` with the first
 * half in hand, which is where its state can change underneath it.
 */
function slowPost(
  base: string,
  path: string,
  writerToken: string | null,
  body: unknown,
): { finish(): Promise<{ status: number; body: string }> } {
  const url = new URL(path, base);
  const text = JSON.stringify(body);
  const half = Math.max(1, Math.floor(text.length / 2));
  let resolveRes!: (r: { status: number; body: string }) => void;
  let rejectRes!: (e: unknown) => void;
  const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveRes = resolve;
    rejectRes = reject;
  });
  const req = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
        ...(writerToken !== null ? { authorization: `Bearer ${writerToken}` } : {}),
      },
    },
    (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (data += d));
      res.on("end", () => resolveRes({ status: res.statusCode ?? 0, body: data }));
    },
  );
  req.on("error", rejectRes);
  req.write(text.slice(0, half));
  return {
    finish() {
      req.end(text.slice(half));
      return done;
    },
  };
}

describe("parseShareRef", () => {
  it("splits a share link into relay and id", () => {
    expect(parseShareRef("https://relay.example/s/abcdefghijkl", "http://fallback")).toEqual({
      relay: "https://relay.example",
      shareId: "abcdefghijkl",
    });
  });

  it("falls back to --relay for a bare id", () => {
    expect(parseShareRef("abcdefghijkl", "http://fallback")).toEqual({
      relay: "http://fallback",
      shareId: "abcdefghijkl",
    });
  });

  it("rejects a URL that is not a share link, and junk", () => {
    expect(() => parseShareRef("https://relay.example/other", "x")).toThrow(/not a share link/);
    expect(() => parseShareRef("short", "x")).toThrow(/not a share id or link/);
  });
});

describe("agit push / agit pull (#72)", () => {
  it("pushes a session and pulls it into another store, byte for byte", async () => {
    const dir = storeDir();
    const { base } = await relayWith(dir);
    const a = mktemp();
    const b = mktemp();
    expect(agitSync(["import", DEMO, "--dir", a]).code).toBe(0);

    const pushed = await agit(["push", "demo", "--relay", base, "--dir", a]);
    expect(pushed.code).toBe(0);
    const url = /http:\/\/\S+\/s\/[A-Za-z0-9_-]+/.exec(pushed.out)?.[0];
    expect(url).toBeTruthy();

    const pulled = await agit(["pull", url!, "--dir", b]);
    expect(pulled.code).toBe(0);
    expect(pulled.out).toContain("adopted");

    // The point of a hash chain: what arrives is what left.
    expect(readFileSync(join(b, ".agit", "sessions", SESSION, "events.jsonl"), "utf8")).toBe(
      readFileSync(join(a, ".agit", "sessions", SESSION, "events.jsonl"), "utf8"),
    );
    expect((await agit(["verify", "demo", "--dir", b])).code).toBe(0);
  });

  it("reuses the link on a second push, and makes a new one only for --force", async () => {
    const { base } = await relayWith(storeDir());
    const a = mktemp();
    expect(agitSync(["import", DEMO, "--dir", a]).code).toBe(0);

    const first = await agit(["push", "demo", "--relay", base, "--dir", a]);
    const url1 = /\/s\/[A-Za-z0-9_-]+/.exec(first.out)?.[0];
    const second = await agit(["push", "demo", "--relay", base, "--dir", a]);
    expect(second.out).toContain("already pushed");
    expect(second.out).toContain(url1!);

    const forced = await agit(["push", "demo", "--relay", base, "--force", "--dir", a]);
    expect(forced.code).toBe(0);
    expect(/\/s\/[A-Za-z0-9_-]+/.exec(forced.out)?.[0]).not.toBe(url1);
  });

  it("refuses to push a session whose chain does not verify", async () => {
    const { base } = await relayWith(storeDir());
    const a = mktemp();
    expect(agitSync(["import", DEMO, "--dir", a]).code).toBe(0);
    const p = join(a, ".agit", "sessions", SESSION, "events.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace("rate limiting", "RATE LIMITING"), "utf8");

    const r = await agit(["push", "demo", "--relay", base, "--dir", a]);
    expect(r.code).toBe(1);
  });

  it("refuses a pulled log the relay altered", async () => {
    // Nothing here trusts the relay. A relay that changes one byte serves a
    // log that fails verification, which is the entire reason for the chain.
    const dir = storeDir();
    const first = await relayWith(dir);
    const a = mktemp();
    expect(agitSync(["import", DEMO, "--dir", a]).code).toBe(0);
    const pushed = await agit(["push", "demo", "--relay", first.base, "--dir", a]);
    const shareId = /\/s\/([A-Za-z0-9_-]+)/.exec(pushed.out)?.[1];
    await first.handle.close();
    open.length = 0;

    const file = join(dir, `${shareId!}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8").replace("rate limiting", "RATE LIMITING"), "utf8");

    const second = await relayWith(dir);
    const r = await agit(["pull", shareId!, "--relay", second.base, "--dir", mktemp()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to adopt");
  });

  it("pulls into a project that keeps its own meta.json at the root", async () => {
    // pull used to hand adoptBundle a fake path under the project root, so
    // the root's meta.json (a theme's, a dataset's) was read as the pulled
    // session's meta and every pull in that project was refused against it.
    const { base } = await relayWith(storeDir());
    const a = mktemp();
    expect(agitSync(["import", DEMO, "--dir", a]).code).toBe(0);
    const url = /http:\/\/\S+\/s\/[A-Za-z0-9_-]+/.exec(
      (await agit(["push", "demo", "--relay", base, "--dir", a])).out,
    )?.[0];
    expect(url).toBeTruthy();

    const project = mktemp();
    writeFileSync(join(project, "meta.json"), '{"name":"my-theme","version":"1.0.0"}\n', "utf8");
    const pulled = await agit(["pull", url!, "--dir", project]);
    expect(pulled.out).not.toContain("refusing");
    expect(pulled.code).toBe(0);
    expect(pulled.out).toContain("adopted");
    // And a root meta.json that is not even JSON is none of pull's business.
    const junk = mktemp();
    writeFileSync(join(junk, "meta.json"), "not json {\n", "utf8");
    expect((await agit(["pull", url!, "--dir", junk])).code).toBe(0);
    expect(readFileSync(join(junk, "meta.json"), "utf8")).toBe("not json {\n");
  });

  it("publishes to a second relay instead of reporting the first relay's link", async () => {
    // The remote record was matched by session id alone, so a push to relay
    // B printed relay A's link, said the log was served there, and exited 0
    // while B never received anything.
    const a = await relayWith(storeDir());
    const b = await relayWith(storeDir());
    const store = mktemp();
    expect(agitSync(["import", DEMO, "--dir", store]).code).toBe(0);
    const first = await agit(["push", "demo", "--relay", a.base, "--dir", store]);
    expect(first.code).toBe(0);

    const second = await agit(["push", "demo", "--relay", b.base, "--dir", store]);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("already pushed");
    const url = /http:\/\/\S+\/s\/[A-Za-z0-9_-]+/.exec(second.out)?.[0];
    expect(url).toBeTruthy();
    expect(url!.startsWith(b.base)).toBe(true);
    expect((await agit(["pull", url!, "--dir", mktemp()])).code).toBe(0);
    // The same relay again is the case the short-circuit exists for.
    expect((await agit(["push", "demo", "--relay", b.base, "--dir", store])).out).toContain("already pushed");
  });

  it("survives a remotes.json that is not what it wrote", async () => {
    // remotes.json parsing to null used to throw on `all[id] = rec` after
    // the session was already published: no link printed, nothing recorded,
    // and the next push published another copy.
    const dir = storeDir();
    const { base } = await relayWith(dir);
    const store = mktemp();
    expect(agitSync(["import", DEMO, "--dir", store]).code).toBe(0);
    const remotes = join(store, ".agit", "remotes.json");
    writeFileSync(remotes, "null\n", "utf8");

    const r = await agit(["push", "demo", "--relay", base, "--dir", store]);
    expect(r.code).toBe(0);
    const url = /http:\/\/\S+\/s\/([A-Za-z0-9_-]+)/.exec(r.out);
    expect(url).toBeTruthy();
    expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    const rec = (JSON.parse(readFileSync(remotes, "utf8")) as Record<string, { shareId: string }>)[SESSION];
    expect(rec?.shareId).toBe(url![1]);

    // A record that is not a record is not a place this was pushed either:
    // it used to be reported as "already pushed to: undefined", exit 0.
    writeFileSync(remotes, `{"${SESSION}":"junk"}\n`, "utf8");
    const again = await agit(["push", "demo", "--relay", base, "--dir", store]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("undefined");
    expect(again.out).toMatch(/\/s\/[A-Za-z0-9_-]+/);
  });

  it("pushes a session whose id is a name Object.prototype also has", async () => {
    // The id comes from the native log, and `constructor` is a valid one. On
    // a plain object the lookup found Object.prototype's, so the session was
    // "already pushed to: undefined" and never published once remotes.json
    // existed.
    const { base } = await relayWith(storeDir());
    const store = mktemp();
    const log = join(store, "c.jsonl");
    writeFileSync(log, readFileSync(DEMO, "utf8").replaceAll(SESSION, "constructor"), "utf8");
    expect(agitSync(["import", log, "--dir", store]).code).toBe(0);
    expect(agitSync(["import", SIMPLE, "--dir", store]).code).toBe(0);
    expect((await agit(["push", "fixture-simple", "--relay", base, "--dir", store])).code).toBe(0);

    const r = await agit(["push", "constructor", "--relay", base, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("undefined");
    const url = /http:\/\/\S+\/s\/[A-Za-z0-9_-]+/.exec(r.out)?.[0];
    expect(url).toBeTruthy();
    expect((await agit(["pull", url!, "--dir", mktemp()])).out).toContain("adopted constructor");
  });

  it("says plainly when a share is gone", async () => {
    const { base } = await relayWith();
    const r = await agit(["pull", "nosuchshareaaaaaaaa", "--relay", base, "--dir", mktemp()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no such share/);
  });

  it("wants an argument", async () => {
    expect((await agit(["push", "--dir", mktemp()])).code).toBe(2);
    expect((await agit(["pull", "--dir", mktemp()])).code).toBe(2);
  });
});

describe("share --detach (#72)", () => {
  it("prints the link and exits instead of holding the share open", async () => {
    const { base } = await relayWith(storeDir());
    const a = mktemp();
    expect(agitSync(["import", DEMO, "--dir", a]).code).toBe(0);

    // The whole point: this call returns. Without --detach it would block on
    // SIGINT and this test would hang.
    const r = await agit(["share", "demo", "--static", "--detach", "--relay", base, "--dir", a]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("detached");
    const url = /http:\/\/\S+\/s\/[A-Za-z0-9_-]+/.exec(r.out)?.[0];
    expect(url).toBeTruthy();
    expect((await agit(["pull", url!, "--dir", mktemp()])).code).toBe(0);
  }, 30_000);

  it("refuses to detach from a live share rather than publishing one event", async () => {
    const { base } = await relayWith(storeDir());
    const a = mktemp();
    // A native log is live-capable, so --detach would leave nothing tailing.
    const r = await agit(["share", SIMPLE, "--detach", "--relay", base, "--dir", a]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("nothing would be left tailing");
  }, 30_000);

  it("refuses before creating anything: no link, no state file, no share on the relay", async () => {
    // The refusal used to come after createShare: the link and the --resume
    // hint were already on stdout, the writer token was already in
    // .agit/shares, and the relay kept an ended, empty share until its TTL.
    // Following the printed hint then failed with "ended on the relay".
    const dir = storeDir();
    const { base } = await relayWith(dir);
    const a = mktemp();
    // An imported session whose source file still exists is live-capable.
    expect(agitSync(["import", DEMO, "--dir", a]).code).toBe(0);

    const r = await agit(["share", "demo", "--detach", "--relay", base, "--dir", a]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("nothing would be left tailing");
    expect(r.out).not.toMatch(/\/s\/[A-Za-z0-9_-]+/);
    expect(r.out).not.toContain("--resume");
    expect(existsSync(join(a, ".agit", "shares"))).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
  }, 30_000);
});

describe("agit relay --store", () => {
  it("tells the operator where shares are written, not that nothing is", async () => {
    // The startup line said "nothing is written to disk" whether or not
    // --store was given, to the one operator who most needs to know the
    // directory holds writer tokens.
    const dir = storeDir();
    const child = execFile(process.execPath, [CLI, "relay", "--port", "0", "--store", dir], {
      encoding: "utf8",
    });
    let out = "";
    const banner = await new Promise<string>((resolve) => {
      child.stdout!.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("Ctrl+C to stop")) resolve(out);
      });
      child.on("close", () => resolve(out));
    });
    child.kill();
    expect(banner).toContain("agit relay listening on");
    expect(banner).not.toContain("nothing is written to disk");
    expect(banner).toContain(dir);
    expect(banner).toContain("writer tokens");
  }, 30_000);
});

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agit-remote-"));
}
