/**
 * Regressions for CLI findings from the adversarial review. Each was
 * reproduced against the real CLI first; the test is that reproduction.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";
import { fetchShareLog } from "../src/share.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-review-cli-"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn `agit share` with a Ctrl+C the test triggers by creating a file.
 *
 * On Windows, child.kill("SIGINT") terminates the process rather than
 * delivering a signal it can catch; the CLI's waitForSigint listens on
 * process.once("SIGINT"), and emitting that in-process is what a real Ctrl+C
 * does on every platform. A flag file rather than a timer, because the CLI's
 * startup time varies with the machine and the test has to act between
 * "streaming" and "Ctrl+C", not at a guessed offset from spawn.
 */
function spawnShare(args: string[]): { cli: ReturnType<typeof spawn>; interrupt: () => void } {
  const dir = mktemp();
  const flag = join(dir, "ctrl-c");
  const preload = join(dir, "sigint.mjs");
  writeFileSync(
    preload,
    `import { existsSync } from "node:fs";\n` +
      `const t = setInterval(() => { if (existsSync(${JSON.stringify(flag)})) { clearInterval(t); process.emit("SIGINT"); } }, 100);\n` +
      `t.unref();\n`,
    "utf8",
  );
  const cli = spawn(process.execPath, ["--import", pathToFileURL(preload).href, CLI, "share", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { cli, interrupt: () => writeFileSync(flag, "", "utf8") };
}

const open: RelayHandle[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});
async function relay(): Promise<{ handle: RelayHandle; base: string }> {
  const handle = await startRelay({ port: 0 });
  open.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

describe("a history rewrite the polls never saw still stops the share at Ctrl+C", () => {
  it("finish() detecting tampering exits 1 and says so, instead of sealing the share", async () => {
    // The polls trust (size, mtime) once the file has settled, so a same-size
    // rewrite whose mtime does not move (a coarse filesystem, a backdated
    // file) reaches finish() unseen. finish() always re-reads and re-checks
    // the full prefix, and its StabilityError used to be swallowed by a
    // best-effort catch on shutdown: "shared 8 events total.", exit 0, and a
    // stream on the relay that is neither sealed nor what an import gives.
    const lines = readFileSync(SIMPLE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const dir = mktemp();
    const native = join(dir, "native.jsonl");
    const original = lines.slice(0, 6);
    writeFileSync(native, original.join("\n") + "\n", "utf8");
    // Old enough that every poll takes the settled fast path.
    const stale = new Date(Date.now() - 10_000);
    utimesSync(native, stale, stale);
    const before = statSync(native);
    const { base } = await relay();

    const { cli, interrupt } = spawnShare([native, "--relay", base, "--dir", dir]);
    let out = "";
    let err = "";
    cli.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    cli.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    const closed: Promise<number> = new Promise((r) => cli.on("close", (c) => r(c ?? -1)));
    // Only rewrite once the untampered prefix has been streamed.
    for (let i = 0; i < 200 && !out.includes("live: "); i++) await sleep(100);
    expect(out, err).toContain("live: ");
    // Same byte length, same mtime: invisible to the stat gate.
    const mutated = original.map((l, i) => (i === 1 ? l.replace("greeting module", "greetinj module") : l));
    writeFileSync(native, mutated.join("\n") + "\n", "utf8");
    utimesSync(native, before.atime, before.mtime);
    expect(statSync(native).size).toBe(before.size);
    // A couple of polls go by without noticing, then Ctrl+C.
    await sleep(2500);
    interrupt();
    const code = await closed;

    expect(err).toContain("no longer extends what was already streamed");
    expect(code).toBe(1);
    expect(out).not.toContain("events total");
    expect(out).not.toContain("sealed the stream");
    // What the relay holds is the untampered prefix, unsealed: no session.end.
    const link = /\/s\/([A-Za-z0-9_-]+)/.exec(out);
    expect(link, out + err).toBeTruthy();
    const served = await fetchShareLog(base, link![1]!);
    expect(served.length).toBeGreaterThan(0);
    expect((JSON.parse(served[served.length - 1]!) as { type: string }).type).not.toBe("session.end");
  }, 40_000);
});
