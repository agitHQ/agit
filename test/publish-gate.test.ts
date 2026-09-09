import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIXTURE = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const ID = "demo-ratelimit-0001";

let relay: RelayHandle;
let base: string;

beforeAll(async () => {
  relay = await startRelay({ port: 0 });
  base = `http://127.0.0.1:${relay.port}`;
});
afterAll(async () => {
  await relay.close();
});

/** Run the built CLI; a refusal must exit promptly, so a hang is a failure. */
function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) {
      throw new Error(`agit ${args.join(" ")} hung instead of refusing:\n${e.stdout}${e.stderr}`, {
        cause: err,
      });
    }
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** Run `agit share` until it prints a link (then kill it), or until it exits. */
function shareUntilLink(args: string[]): Promise<{ link: string | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = (link: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ link, out });
    };
    const timer = setTimeout(() => finish(null), 20_000);
    const onData = (d: Buffer): void => {
      out += d.toString();
      const m = out.match(/https?:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+/);
      if (m) finish(m[0]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => finish(null));
  });
}

function freshStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "agit-gate-"));
  expect(agit(["import", FIXTURE, "--dir", dir]).code).toBe(0);
  return dir;
}
const logOf = (store: string): string => join(store, ".agit", "sessions", ID, "events.jsonl");

/** Change one byte of a user message in place: every hash after it still recomputes, this one does not. */
function tamper(store: string): void {
  const p = logOf(store);
  writeFileSync(p, readFileSync(p, "utf8").replace("rate limiting", "RATE LIMITING"), "utf8");
}

/** Drop the last event: the chain itself stays intact, meta.json is what proves the loss. */
function truncate(store: string): void {
  const p = logOf(store);
  const lines = readFileSync(p, "utf8").trimEnd().split("\n");
  writeFileSync(p, lines.slice(0, -1).join("\n") + "\n", "utf8");
}

describe("verbs that publish or hand off a stored session refuse a chain that does not verify", () => {
  it("share --static: a tampered log is refused before any share exists, naming the event", () => {
    const store = freshStore();
    tamper(store);
    const r = agit(["share", "demo", "--static", "--relay", base, "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to share: chain verification failed");
    expect(r.out).toContain("event 1: hash does not recompute");
    expect(r.out).toContain("nothing was published");
    // No link means no share was created on the relay.
    expect(r.out).not.toMatch(/\/s\/[A-Za-z0-9_-]+/);
  });

  it("share --static: a truncated log is caught through meta.json", () => {
    const store = freshStore();
    truncate(store);
    const r = agit(["share", "demo", "--static", "--relay", base, "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to share");
    expect(r.out).toMatch(/truncated or extended/);
    expect(r.out).not.toMatch(/\/s\/[A-Za-z0-9_-]+/);
  });

  it("share --static still publishes an intact log", async () => {
    const store = freshStore();
    const { link, out } = await shareUntilLink([
      "share",
      "demo",
      "--static",
      "--relay",
      base,
      "--dir",
      store,
    ]);
    expect(link, out).not.toBeNull();
    expect(out).not.toContain("refusing");
  });

  it("export refuses a tampered log and says where it broke", () => {
    const store = freshStore();
    tamper(store);
    const r = agit(["export", "demo", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to export: chain verification failed");
    expect(r.out).toContain("event 1: hash does not recompute");
    // Nothing of the log itself reached stdout.
    expect(r.out).not.toContain('"seq":0');
  });

  it("export --json refuses the same way", () => {
    const store = freshStore();
    tamper(store);
    const r = agit(["export", "demo", "--json", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to export");
    expect(r.out).not.toContain('"seq": 0');
  });

  it("export still writes an intact log byte for byte", () => {
    const store = freshStore();
    const r = agit(["export", "demo", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(readFileSync(logOf(store), "utf8"));
  });

  it("pr names the broken event instead of a generic refusal", () => {
    const store = freshStore();
    tamper(store);
    const r = agit(["pr", "demo", "--out", join(store, "bundle"), "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to hand off: chain verification failed");
    expect(r.out).toContain("event 1: hash does not recompute");
  });

  it("fork catches truncation now, not only a broken link", () => {
    const store = freshStore();
    truncate(store);
    const r = agit(["fork", "demo", "--at", "10", "--out", join(store, "fk"), "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to fork");
    expect(r.out).toMatch(/truncated or extended/);
  });

  it("every refusal points at agit verify", () => {
    const store = freshStore();
    tamper(store);
    for (const args of [
      ["export", "demo"],
      ["export-html", "demo", "--out", join(store, "x.html")],
      ["fork", "demo", "--at", "10", "--out", join(store, "fk2")],
      ["pr", "demo", "--out", join(store, "b2")],
    ]) {
      const r = agit([...args, "--dir", store]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.out, args.join(" ")).toContain("Run: agit verify demo-rat");
    }
  });
});
