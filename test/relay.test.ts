import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain } from "../src/format/hash.js";
import type { AgitEvent } from "../src/format/events.js";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";
import {
  createShare,
  endShare,
  getShareHead,
  openInbox,
  pushEvents,
  readSse,
  type ShareInfo,
} from "../src/share.js";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "fixtures",
  "claude-code",
  "simple.jsonl",
);
const lines = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const converted = claudeCodeAdapter.convert(lines);
const EVENTS: AgitEvent[] = buildChain(converted.sessionId, converted.drafts);

let relay: RelayHandle;
let base: string;

beforeAll(async () => {
  relay = await startRelay({ port: 0 });
  base = `http://127.0.0.1:${relay.port}`;
});
afterAll(async () => {
  await relay.close();
});

/** Collect SSE frames from a share stream until `until` says stop (or timeout). */
async function collectFrames(
  url: string,
  until: (frames: { event: string; data: string }[]) => boolean,
  ms = 5000,
): Promise<{ event: string; data: string }[]> {
  const ctl = new AbortController();
  const frames: { event: string; data: string }[] = [];
  const res = await fetch(url, { signal: ctl.signal, headers: { accept: "text/event-stream" } });
  expect(res.ok).toBe(true);
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    await readSse(
      res.body!,
      (event, data) => {
        frames.push({ event, data });
        if (until(frames)) ctl.abort();
      },
      ctl.signal,
    );
  } catch {
    /* aborting the fetch rejects the read — that is the exit path */
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

describe("relay protocol v0", () => {
  it("full writer flow: create, push in batches, download, chain-checked", async () => {
    const share = await createShare(base);
    expect(share.viewUrl).toContain(`/s/${share.shareId}`);

    await pushEvents(base, share, EVENTS.slice(0, 5));
    await pushEvents(base, share, EVENTS.slice(5));

    const jsonl = await (await fetch(`${base}/api/shares/${share.shareId}/events.jsonl`)).text();
    const got = jsonl
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as AgitEvent);
    expect(got).toHaveLength(EVENTS.length);
    expect(got[got.length - 1]!.hash).toBe(EVENTS[EVENTS.length - 1]!.hash);
    await endShare(base, share);
  });

  it("refuses a push that breaks the chain (409) and a bad token (401)", async () => {
    const share = await createShare(base);
    await pushEvents(base, share, EVENTS.slice(0, 3));
    // Skipping event 3 breaks contiguity.
    await expect(pushEvents(base, share, EVENTS.slice(4))).rejects.toThrow(/409/);
    const wrong: ShareInfo = { ...share, writerToken: "x".repeat(share.writerToken.length) };
    await expect(pushEvents(base, wrong, EVENTS.slice(3))).rejects.toThrow(/401/);
    await endShare(base, share);
  });

  it("streams buffered then live events to viewers, in order", async () => {
    const share = await createShare(base);
    await pushEvents(base, share, EVENTS.slice(0, 4));

    const wanted = EVENTS.length;
    const streaming = collectFrames(
      `${base}/api/shares/${share.shareId}/stream`,
      (fs) => fs.filter((f) => f.event === "ev").length >= wanted,
    );
    // Give the viewer a beat to connect, then push the rest live.
    await new Promise((r) => setTimeout(r, 150));
    await pushEvents(base, share, EVENTS.slice(4));

    const frames = await streaming;
    expect(frames[0]!.event).toBe("info");
    const seqs = frames.filter((f) => f.event === "ev").map((f) => (JSON.parse(f.data) as AgitEvent).seq);
    expect(seqs).toEqual(EVENTS.map((e) => e.seq));
    await endShare(base, share);
  });

  it("delivers viewer messages to the writer inbox and caps their size", async () => {
    const share = await createShare(base);
    const got: { name: string; text: string }[] = [];
    const inbox = openInbox(base, share, { onMessage: (m) => got.push(m) });
    await new Promise((r) => setTimeout(r, 150));

    const res = await fetch(`${base}/api/shares/${share.shareId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "n".repeat(100), text: "ship it" }),
    });
    expect(res.ok).toBe(true);

    await expectEventually(() => got.length === 1);
    expect(got[0]!.text).toBe("ship it");
    expect(got[0]!.name).toHaveLength(40);
    inbox.abort();
    await endShare(base, share);
  });

  it("reports its head to the writer, enabling crash resume", async () => {
    const share = await createShare(base);
    expect(await getShareHead(base, share)).toMatchObject({ events: 0, lastHash: null, ended: false });

    // A first CLI pushes part of the chain, then dies.
    await pushEvents(base, share, EVENTS.slice(0, 7));
    const head = await getShareHead(base, share);
    expect(head).toMatchObject({ events: 7, lastHash: EVENTS[6]!.hash, ended: false });

    // The resumed CLI re-derives the chain, checks alignment, pushes the tail.
    expect(EVENTS[head.events - 1]!.hash).toBe(head.lastHash);
    await pushEvents(base, share, EVENTS.slice(head.events));
    const jsonl = await (await fetch(`${base}/api/shares/${share.shareId}/events.jsonl`)).text();
    expect(jsonl.trimEnd().split("\n")).toHaveLength(EVENTS.length);

    // head requires the writer token, and reflects the ended state.
    const wrong: ShareInfo = { ...share, writerToken: "x".repeat(share.writerToken.length) };
    await expect(getShareHead(base, wrong)).rejects.toThrow(/401/);
    await endShare(base, share);
    expect((await getShareHead(base, share)).ended).toBe(true);
  });

  it("404s unknown shares and refuses pushes after end", async () => {
    const missing = await fetch(`${base}/api/shares/${"A".repeat(22)}/events.jsonl`);
    expect(missing.status).toBe(404);

    const share = await createShare(base);
    await endShare(base, share);
    await expect(pushEvents(base, share, EVENTS.slice(0, 1))).rejects.toThrow(/409/);
  });

  it("serves the share page with a strict CSP and no external resources", async () => {
    const share = await createShare(base);
    const res = await fetch(share.viewUrl);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/href="http/);
    expect(html).toContain("textContent");
    await endShare(base, share);
  });
});

async function expectEventually(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}
