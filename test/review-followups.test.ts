/**
 * The four items the medium/low fixers flagged as outside their file groups
 * (#125): publishing verbs that ignored a signature `verify` rejects, a
 * bundle summary that dereferenced a missing adapter, tree paths that failed
 * a whole fork/diff/merge over one unusable entry, and dollar amounts three
 * adapters stored against SPEC §5.9.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../src/format/events.js";
import { buildChain, sha256Hex, toJsonl } from "../src/format/hash.js";
import { loadPrivateKey, signHead, SIGNATURE_PAYLOAD_VERSION } from "../src/sign.js";
import { readSessionMeta } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const DEMO_ID = "demo-ratelimit-0001";

function agit(args: string[]): { code: number; out: string } {
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

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-followups-"));

function storeWithDemo(): string {
  const dir = mktemp();
  expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
  return dir;
}

function metaPath(dir: string, id = DEMO_ID): string {
  return join(dir, ".agit", "sessions", id, "meta.json");
}

/** A session whose log records a file at `path` (hash-verified) next to an ordinary one. */
function importSessionCreating(dir: string, id: string, path: string): void {
  const create = (ts: number, p: string, content: string, toolUseId: string) => ({
    ts: `2026-01-01T00:00:0${ts}.000Z`,
    type: "file.diff" as const,
    payload: {
      path: p,
      kind: "create",
      diff: `--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+${content.trimEnd()}\n`,
      beforeHash: null,
      afterHash: sha256Hex(content),
      toolUseId,
      source: "Write",
    },
  });
  const events = buildChain(id, [
    { ts: "2026-01-01T00:00:00.000Z", type: "session.start", payload: { runtime: "test", cwd: "/work" } },
    create(1, path, "hello\n", "t0"),
    create(2, "/work/ok.ts", "ok\n", "t1"),
  ]);
  const src = join(dir, "src", id);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "events.jsonl"), toJsonl(events), "utf8");
  expect(agit(["import", join(src, "events.jsonl"), "--dir", dir]).code).toBe(0);
}

describe("publishing verbs refuse a signature verify rejects", () => {
  it("export, pr, push and share stop at a signature over a different head", () => {
    // The forgery signing exists to catch: a rechained log still carrying
    // its original signature. `verify` said NOT OK and exited 1, but the
    // publishing gate checked the chain alone, so the same store would
    // export, bundle, push and share a claim of provenance it rejects.
    const dir = storeWithDemo();
    const meta = readSessionMeta(dir, DEMO_ID)!;
    const key = loadPrivateKey(
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    );
    const stale = signHead(key, {
      agitSignature: SIGNATURE_PAYLOAD_VERSION,
      sessionId: DEMO_ID,
      headHash: "b".repeat(64),
      eventCount: meta.eventCount,
      at: "2026-09-10T00:00:00.000Z",
    });
    writeFileSync(metaPath(dir), JSON.stringify({ ...meta, signatures: [stale] }, null, 2) + "\n", "utf8");
    expect(agit(["verify", "demo", "--dir", dir]).code).toBe(1);

    const out = join(dir, "pr");
    for (const args of [
      ["export", "demo"],
      ["export", "demo", "--atif"],
      ["pr", "demo", "--out", out],
      ["push", "demo", "--relay", "http://127.0.0.1:1"],
    ]) {
      const r = agit([...args, "--dir", dir]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.out, args.join(" ")).toContain("SIGNATURE DOES NOT MATCH");
      expect(r.out, args.join(" ")).toContain("refusing to");
    }
    expect(existsSync(out)).toBe(false);

    // The same signature over the real head is fine everywhere.
    const good = signHead(key, {
      agitSignature: SIGNATURE_PAYLOAD_VERSION,
      sessionId: DEMO_ID,
      headHash: meta.headHash,
      eventCount: meta.eventCount,
      at: "2026-09-10T00:00:00.000Z",
    });
    writeFileSync(metaPath(dir), JSON.stringify({ ...meta, signatures: [good] }, null, 2) + "\n", "utf8");
    expect(agit(["verify", "demo", "--dir", dir]).code).toBe(0);
    expect(agit(["export", "demo", "--dir", dir]).code).toBe(0);
  });
});

describe("an adopted meta.json without an adapter", () => {
  it("is summarized by show and by adoption without a TypeError", () => {
    const dir = storeWithDemo();
    const meta = readSessionMeta(dir, DEMO_ID)! as Partial<SessionMeta>;
    delete meta.adapter;
    writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2) + "\n", "utf8");

    const show = agit(["show", "demo", "--dir", dir]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("unknown adapter");
    expect(show.out).not.toMatch(/Cannot read properties/);

    // Adopt that session's bundle somewhere else: the adoption summary is
    // the other place the adapter was dereferenced.
    const bundle = join(dir, "bundle");
    expect(agit(["pr", "demo", "--out", bundle, "--dir", dir]).code).toBe(0);
    const other = mktemp();
    const adopt = agit(["import", join(bundle, "events.jsonl"), "--dir", other]);
    expect(adopt.code).toBe(0);
    expect(adopt.out).toContain("unknown adapter");
    expect(adopt.out).not.toMatch(/Cannot read properties/);
  });
});

describe("a path that sanitizes to nothing costs one file, not the operation", () => {
  it("diff compares the rest and counts the file; fork writes the rest and names the skip", () => {
    // A hash-verified file.diff at "/" (or ".") has no path segments a tree
    // can place. The MCP agit_diff already set it aside; the CLI verbs went
    // through fork.ts and threw "unusable path in log" for the whole run.
    const dir = storeWithDemo();
    for (const [i, path] of ["/", ".", "//"].entries()) {
      const id = `unkeyable-${i}`;
      importSessionCreating(dir, id, path);
      const diff = agit(["diff", id, "demo", "--dir", dir]);
      expect(diff.code, path).toBe(0);
      expect(diff.out, path).toContain("ok.ts");
      expect(diff.out, path).not.toContain("unusable path");

      const out = join(dir, `fork-${i}`);
      const fork = agit(["fork", id, "--at", "2", "--out", out, "--dir", dir]);
      expect(fork.code, path).toBe(0);
      expect(existsSync(join(out, "tree", "ok.ts")), path).toBe(true);
      expect(readFileSync(join(out, "SEED.md"), "utf8"), path).toContain("sanitizes to nothing");
    }
  });
});

describe("dollar amounts stay out of the log (SPEC §5.9)", () => {
  it("no adapter writes a price into a hashed payload, and each names the drop", () => {
    const openclaw = agit(["import", join(ROOT, "fixtures", "openclaw", "simple.jsonl"), "--dir", mktemp()]);
    expect(openclaw.code).toBe(0);
    expect(openclaw.out).toContain("cost-usd-not-stored (SPEC §5.9)");
    const cline = agit([
      "import",
      join(ROOT, "fixtures", "cline-sdk", "simple.messages.json"),
      "--dir",
      mktemp(),
    ]);
    expect(cline.code).toBe(0);
    for (const r of [openclaw, cline]) expect(r.out).not.toMatch(/costUsd|"cost":/);
  });
});
