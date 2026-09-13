/**
 * Regressions for the six high-severity findings from the adversarial review
 * of everything shipped since 0.5.0. Each one was reproduced against the real
 * CLI before it was fixed, and each test here is that reproduction, kept.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent } from "../src/format/events.js";
import { handleMessage } from "../src/mcp.js";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";
import { openRelayStore } from "../src/relay/store.js";
import { createShare, fetchShareLog, getShareHead, pushEvents } from "../src/share.js";
import { listSessionIds, readSessionEvents, writeSession } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-review-"));

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Async, because a relay under test lives in this process and execFileSync would starve it. */
function agitAsync(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const code = (err as { code?: number } | null)?.code;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, out: stdout + stderr });
    });
  });
}

const simpleEvents = (): AgitEvent[] => {
  const lines = readFileSync(SIMPLE, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const c = claudeCodeAdapter.convert(lines);
  return buildChain(c.sessionId, c.drafts);
};

/**
 * Spawn `agit share` with a Ctrl+C scheduled from inside the process.
 *
 * On Windows, child.kill("SIGINT") terminates the process rather than
 * delivering a signal it can catch, so the CLI never reaches the shutdown
 * path this suite is testing. The CLI's waitForSigint listens on
 * process.once("SIGINT"); emitting that in-process is exactly what a real
 * Ctrl+C does, on every platform.
 */
function spawnShare(args: string[], sigintAfterMs: number): ReturnType<typeof spawn> {
  const preload = join(mktemp(), "sigint.mjs");
  writeFileSync(
    preload,
    `// Fire once the CLI is listening: under a loaded parallel run its startup can outlast the delay,\n// and an emit with no listener is silently lost, leaving the share open until the test times out.\nconst fire = () => (process.listenerCount("SIGINT") > 0 ? process.emit("SIGINT") : setTimeout(fire, 50).unref());\nsetTimeout(fire, ${sigintAfterMs}).unref();\n`,
    "utf8",
  );
  return spawn(process.execPath, ["--import", pathToFileURL(preload).href, CLI, "share", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});
async function relay(store?: string): Promise<{ handle: RelayHandle; base: string }> {
  const handle = await startRelay({ port: 0, ...(store !== undefined ? { store } : {}) });
  open.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

/** A relay that answers whatever it is told to. Anything from a relay is untrusted. */
async function hostileRelay(reply: (req: http.IncomingMessage) => unknown): Promise<string> {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(req)));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  open.push({ close: () => new Promise((r) => srv.close(() => r())) });
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

describe("a hostile relay cannot choose a filename on the client", () => {
  it("refuses a share id that would escape .agit/shares", async () => {
    // The id became a filename on write and on the rmSync that ends a share:
    // "../../package" overwrote package.json, then deleted it.
    const base = await hostileRelay(() => ({
      shareId: "../../package",
      writerToken: "t",
      ttlMs: 3600_000,
      path: "/s/x",
    }));
    await expect(createShare(base)).rejects.toThrow(/will not use as a filename/);
  });

  it("refuses a share path it would not link to, and a missing token", async () => {
    const badPath = await hostileRelay(() => ({
      shareId: "abcdefghijklmnop",
      writerToken: "t",
      ttlMs: 1,
      path: "/anywhere",
    }));
    await expect(createShare(badPath)).rejects.toThrow(/will not link to/);
    const noToken = await hostileRelay(() => ({ shareId: "abcdefghijklmnop", path: "/s/abcdefghijklmnop" }));
    await expect(createShare(noToken)).rejects.toThrow(/no writer token/);
  });

  it("leaves a real project untouched end to end", async () => {
    const base = await hostileRelay(() => ({
      shareId: "../../victim",
      writerToken: "t",
      ttlMs: 3600_000,
      path: "/s/x",
    }));
    const dir = mktemp();
    const victim = join(dir, "victim.json");
    writeFileSync(victim, '{"keep":"me"}', "utf8");
    expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
    const r = await agitAsync(["share", "demo", "--static", "--detach", "--relay", base, "--dir", dir]);
    expect(r.code).not.toBe(0);
    expect(readFileSync(victim, "utf8")).toBe('{"keep":"me"}');
  });
});

describe("a session id that differs only in case is the same session", () => {
  it("writeSession refuses the case variant", () => {
    const dir = mktemp();
    writeSession(dir, "demo-x", '{"a":1}\n');
    expect(() => writeSession(dir, "DEMO-X", '{"b":2}\n')).toThrow(/differs only in case/);
    // The original is intact and the variant was not created beside it.
    expect(listSessionIds(dir)).toEqual(["demo-x"]);
    expect(readFileSync(join(dir, ".agit", "sessions", "demo-x", "events.jsonl"), "utf8")).toBe('{"a":1}\n');
    // An exact match is an update to the same session and still works.
    writeSession(dir, "demo-x", '{"a":2}\n');
  });

  it("pull refuses a log whose id is a case variant of one already stored", async () => {
    // On NTFS and APFS the exact-match check let this land in the existing
    // directory and replace its events.jsonl under the old meta.json, so the
    // victim session then failed verification. The id comes from the log,
    // which on a pull comes from the relay.
    const { base } = await relay();
    const a = mktemp();
    expect(agit(["import", DEMO, "--dir", a]).code).toBe(0);
    const before = readFileSync(join(a, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"), "utf8");

    const lines = readFileSync(DEMO, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const c = claudeCodeAdapter.convert(lines);
    const variant = buildChain("DEMO-RATELIMIT-0001", c.drafts);
    const share = await createShare(base);
    await pushEvents(base, share, variant);

    const r = await agitAsync(["pull", share.viewUrl, "--dir", a]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("differs only in case");
    expect(readFileSync(join(a, ".agit", "sessions", "demo-ratelimit-0001", "events.jsonl"), "utf8")).toBe(
      before,
    );
    expect(agit(["verify", "demo", "--dir", a]).code).toBe(0);
  });
});

describe("one malformed session cannot take down a store-wide search", () => {
  function poison(
    dir: string,
    id: string,
    payload: unknown,
    type: "message.user" | "message.assistant" = "message.user",
  ): void {
    const chain = buildChain(id, [
      { ts: "2026-01-01T00:00:00.000Z", type: "session.start", payload: { runtime: "x", cwd: null } },
      { ts: "2026-01-01T00:00:01.000Z", type, payload: payload as never },
    ]);
    const bundle = join(dir, `${id}.jsonl`);
    writeFileSync(bundle, chain.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    // The chain verifies, because verifyChain never looked at payload.
    expect(agit(["import", bundle, "--dir", dir]).code).toBe(0);
  }

  it("readSessionEvents rejects a payload that is not an object", () => {
    const dir = mktemp();
    poison(dir, "poison-null", null);
    expect(() => readSessionEvents(dir, "poison-null")).toThrow(/payload is not an object/);
  });

  it("agit_grep still returns the healthy sessions' hits", () => {
    const dir = mktemp();
    expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
    poison(dir, "zz-poison", null);
    const r = handleMessage(dir, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "agit_grep", arguments: { pattern: "ratelimit" } },
    });
    const res = r?.result as { isError: boolean; content: { text: string }[] };
    expect(res.isError).toBe(false);
    const doc = JSON.parse(res.content[0]!.text) as { total: number; unreadable?: string[] };
    expect(doc.total).toBeGreaterThan(0);
    expect(doc.unreadable).toContain("zz-poison");
  });

  it("agit grep on the CLI does too, and names what it skipped", () => {
    const dir = mktemp();
    expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
    // An object payload passes the read-time check; a null block inside it
    // throws in the renderer. Sorts before "demo-…" so the crash used to
    // happen before any hit printed.
    poison(dir, "aa-poison", { model: "m", blocks: [null] }, "message.assistant");
    const r = agit(["grep", "ratelimit", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("demo-rat");
    expect(r.out).toContain("skipping aa-poiso");
  });
});

describe("the relay store survives a crash mid-write", () => {
  it("drops a torn trailing line on load, and the next push lands on a fresh line", async () => {
    const dir = mktemp();
    const EVENTS = simpleEvents();
    const first = await relay(dir);
    const share = await createShare(first.base);
    await pushEvents(first.base, share, EVENTS.slice(0, 3));
    await first.handle.close();
    open.length = 0;

    // A crash mid-appendFileSync: half of event 3, no newline.
    const file = join(dir, `${share.shareId}.jsonl`);
    appendFileSync(file, JSON.stringify(EVENTS[3]).slice(0, 40), "utf8");

    const second = await relay(dir);
    // Count and head agree, and the fragment is not served as an event.
    const head = await getShareHead(second.base, share);
    expect(head.events).toBe(3);
    expect(head.lastHash).toBe(EVENTS[2]!.hash);
    expect((await fetchShareLog(second.base, share.shareId)).length).toBe(3);

    // The next push must not be glued onto the fragment.
    await pushEvents(second.base, share, EVENTS.slice(3));
    await second.handle.close();
    open.length = 0;
    const third = await relay(dir);
    const served = await fetchShareLog(third.base, share.shareId);
    expect(served.length).toBe(EVENTS.length);
    for (const line of served) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("does not drop an unparseable line that is not the tail", () => {
    // Only a torn tail is a crash artifact. Corruption in the middle is a
    // real problem verify should name, not something to skip past.
    const dir = mktemp();
    const store = openRelayStore(dir);
    store.create({
      id: "abcdefghijklmnop",
      writerToken: "t",
      createdAt: Date.now(),
      ttlMs: 3600_000,
      ended: false,
      lastHash: null,
    });
    writeFileSync(join(dir, "abcdefghijklmnop.jsonl"), '{"seq":0}\nnot json\n{"seq":2}\n', "utf8");
    expect(store.load(Date.now())[0]!.events).toHaveLength(3);
  });

  it("a failed persist leaves the in-memory head where it was, so a retry succeeds", async () => {
    // The other order advanced memory first: /head advertised events the disk
    // did not hold, the retry was refused as a duplicate, and the next push
    // landed after a gap, leaving a hole in the on-disk chain.
    const dir = mktemp();
    const EVENTS = simpleEvents();
    const { base } = await relay(dir);
    const share = await createShare(base);
    await pushEvents(base, share, EVENTS.slice(0, 3));

    const file = join(dir, `${share.shareId}.jsonl`);
    chmodSync(file, 0o444);
    let failed = false;
    try {
      await pushEvents(base, share, EVENTS.slice(3, 6));
    } catch {
      failed = true;
    }
    chmodSync(file, 0o644);
    if (!failed) return; // a platform where chmod does not block the append: nothing to assert

    const head = await getShareHead(base, share);
    expect(head.events).toBe(3);
    expect(head.lastHash).toBe(EVENTS[2]!.hash);
    // The exact same batch is accepted now that the disk is writable.
    await pushEvents(base, share, EVENTS.slice(3, 6));
    expect((await getShareHead(base, share)).events).toBe(6);
    const onDisk = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(onDisk).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("a live share survives one failed push", () => {
  it("retries the events the relay did not accept, and says so", async () => {
    // The follower's poll() advances its own state, so an event it handed
    // over is never returned again. A push that failed lost those events for
    // good; the relay then answered 409 to every later push, the catch
    // swallowed each, and the sharer saw exit 0 with nothing delivered.
    const upstream = await relay();
    let pushes = 0;
    const proxy = http.createServer((req, res) => {
      const isPush = req.method === "POST" && /\/api\/shares\/[^/]+\/events$/.test(req.url ?? "");
      if (isPush && ++pushes === 2) {
        req.resume();
        res.writeHead(503).end("relay hiccup");
        return;
      }
      const up = http.request(
        {
          host: "127.0.0.1",
          port: upstream.handle.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      up.on("error", () => res.destroy());
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    open.push({ close: () => new Promise((r) => proxy.close(() => r())) });
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

    const lines = readFileSync(SIMPLE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const dir = mktemp();
    const native = join(dir, "native.jsonl");
    writeFileSync(native, lines.slice(0, 3).join("\n") + "\n", "utf8");

    const cli = spawnShare([native, "--relay", proxyUrl, "--dir", dir], 9000);
    let out = "";
    let err = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    cli.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    await sleep(2500);
    appendFileSync(native, lines.slice(3, 8).join("\n") + "\n", "utf8"); // push #2: the one the proxy fails
    await sleep(2500);
    appendFileSync(native, lines.slice(8).join("\n") + "\n", "utf8");
    const code: number = await new Promise((r) => cli.on("close", (c) => r(c ?? -1)));

    const link = /http:\/\/[^\s]+\/s\/([A-Za-z0-9_-]+)/.exec(out);
    expect(link, out + err).toBeTruthy();
    const served = await fetchShareLog(upstream.base, link![1]!);
    const full = buildChain(
      claudeCodeAdapter.convert(lines).sessionId,
      claudeCodeAdapter.convert(lines).drafts,
    );
    expect(served.length, err).toBe(full.length);
    expect(err).toContain("push failed");
    expect(err).toContain("reachable again");
    expect(code).toBe(0);
  }, 30_000);

  it("leaves the share open and resumable when the relay never comes back", async () => {
    const dir = mktemp();
    const lines = readFileSync(SIMPLE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const native = join(dir, "native.jsonl");
    writeFileSync(native, lines.slice(0, 3).join("\n") + "\n", "utf8");
    const { base, handle } = await relay();

    const cli = spawnShare([native, "--relay", base, "--dir", dir], 6000);
    let out = "";
    let err = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    cli.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    await new Promise((r) => setTimeout(r, 2000));
    // The relay vanishes, then the log grows: every push from here fails,
    // including the final one on Ctrl+C.
    await handle.close();
    open.length = 0;
    appendFileSync(native, lines.slice(3).join("\n") + "\n", "utf8");
    const code: number = await new Promise((r) => cli.on("close", (c) => r(c ?? -1)));

    expect(code).toBe(1);
    expect(err).toContain("resumable");
    expect(out).not.toContain("share ended.");
    // The state file that --resume needs is still there.
    const shares = join(dir, ".agit", "shares");
    expect(
      existsSync(shares) &&
        readFileSync(join(shares, `${/\/s\/([A-Za-z0-9_-]+)/.exec(out)![1]}.json`), "utf8"),
    ).toBeTruthy();
  }, 30_000);
});
