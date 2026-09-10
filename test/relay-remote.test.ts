import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
});

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
});

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agit-remote-"));
}
