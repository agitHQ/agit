/**
 * The MCP server's `verified` is the verdict `agit verify` gives, signatures
 * included.
 *
 * It used to be the chain result alone. A signed session that is edited and
 * rechained after signing (the forgery signing exists to catch) has an intact
 * chain and a head its signature never covered: `agit verify` prints NOT OK
 * and exits 1, and `export`, `pr`, `share` and `fork` refuse it. Every MCP
 * tool still handed it to the agent as `verified: true`, and `agit_verify`
 * added "The chain is intact" without a word about the signature.
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgitEvent, SessionMeta } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { handleMessage } from "../src/mcp.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const ID = "demo-ratelimit-0001";
const INTACT = "The chain is intact: every event links to the one before it and the hashes recompute.";

function agit(args: string[]): { code: number; stdout: string; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function storeWith(...fixtures: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agit-mcp-sig-"));
  for (const f of fixtures) expect(agit(["import", f, "--dir", dir]).code).toBe(0);
  return dir;
}

/** A fresh Ed25519 key as PKCS#8 PEM, which `agit sign` reads without ssh-keygen or openssl. */
function newKey(dir: string, name: string): string {
  const path = join(dir, `${name}.pem`);
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(path, pem as string, "utf8");
  return path;
}

function sign(dir: string, id: string, key: string): void {
  const r = agit(["sign", id, "--key", key, "--dir", dir]);
  expect(r.code, r.out).toBe(0);
}

const fileOf = (dir: string, id: string, name: string): string => join(dir, ".agit", "sessions", id, name);

function readMeta(dir: string, id: string): SessionMeta {
  return JSON.parse(readFileSync(fileOf(dir, id, "meta.json"), "utf8")) as SessionMeta;
}

function writeMeta(dir: string, id: string, meta: unknown): void {
  writeFileSync(fileOf(dir, id, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

/**
 * The forger's move: edit a user message, rebuild a valid chain over it, and
 * point meta.json's head at the new chain. The signatures are left as they
 * were, so the chain verifies and the signature does not.
 */
function rechain(dir: string): void {
  const path = fileOf(dir, ID, "events.jsonl");
  const events = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AgitEvent);
  const i = events.findIndex((e) => e.type === "message.user");
  events[i]!.payload = { ...(events[i]!.payload as object), text: "EDITED AFTER SIGNING" };
  const chained = buildChain(
    ID,
    events.map((e) => ({ ts: e.ts, type: e.type, payload: e.payload })),
  );
  writeFileSync(path, toJsonl(chained), "utf8");
  writeMeta(dir, ID, { ...readMeta(dir, ID), headHash: chained.at(-1)!.hash, eventCount: chained.length });
}

/** Call one tool and parse the JSON document it puts in its text content. */
function call(dir: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const r = handleMessage(dir, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = r?.result as { content: { text: string }[]; isError: boolean };
  return { ...(JSON.parse(result.content[0]!.text) as object), _isError: result.isError };
}

interface VerifyResult {
  verified: boolean;
  chainOk: boolean;
  signaturesOk: boolean;
  events: number;
  headHash?: string;
  recordedEventCount?: number;
  firstBroken?: { seq: number; reason: string };
  signatures: { keyFingerprint: string | null; ok: boolean; reason?: string }[];
  meaning: string;
  _isError: boolean;
}

/** `agit verify --json`, the verdict the MCP answer has to agree with. */
function cliVerdict(dir: string): {
  ok: boolean;
  chainOk: boolean;
  signaturesOk: boolean;
  signatures: unknown[];
} {
  return JSON.parse(agit(["verify", ID, "--json", "--dir", dir]).stdout) as {
    ok: boolean;
    chainOk: boolean;
    signaturesOk: boolean;
    signatures: unknown[];
  };
}

/** The `verified` flag each tool that carries one reports for the demo session. */
function verifiedEverywhere(dir: string): Record<string, unknown> {
  const list = call(dir, "agit_list") as { sessions: { id: string; verified: boolean }[] };
  const grep = call(dir, "agit_grep", { pattern: "e" }) as { hits: { session: string; verified: boolean }[] };
  const own = grep.hits.filter((h) => h.session === ID);
  expect(own.length).toBeGreaterThan(0);
  const diff = call(dir, "agit_diff", { a: ID, b: ID }) as {
    a: { verified: boolean };
    b: { verified: boolean };
  };
  return {
    agit_verify: call(dir, "agit_verify", { id: ID }).verified,
    agit_list: list.sessions.find((s) => s.id === ID)?.verified,
    agit_show: call(dir, "agit_show", { id: ID }).verified,
    agit_grep: [...new Set(own.map((h) => h.verified))],
    agit_replay: call(dir, "agit_replay", { id: ID }).verified,
    "agit_replay state": call(dir, "agit_replay", { id: ID, state: true }).verified,
    "agit_diff a": diff.a.verified,
    "agit_diff b": diff.b.verified,
  };
}

const everywhere = (v: boolean): Record<string, unknown> => ({
  agit_verify: v,
  agit_list: v,
  agit_show: v,
  agit_grep: [v],
  agit_replay: v,
  "agit_replay state": v,
  "agit_diff a": v,
  "agit_diff b": v,
});

describe("MCP verification includes the signatures agit verify checks", () => {
  it("a session edited and rechained after signing is verified: false in every tool", () => {
    const dir = storeWith(DEMO);
    sign(dir, ID, newKey(dir, "a"));
    const signer = readMeta(dir, ID).signatures![0]!.keyFingerprint;
    rechain(dir);

    // The premise: the CLI calls this a failure, and so does every publishing gate.
    expect(agit(["verify", ID, "--dir", dir]).code).toBe(1);
    expect(agit(["export", ID, "--dir", dir]).out).toContain("refusing to export: SIGNATURE DOES NOT MATCH");

    expect(verifiedEverywhere(dir)).toEqual(everywhere(false));

    const v = call(dir, "agit_verify", { id: ID }) as unknown as VerifyResult;
    expect(v).toMatchObject({ verified: false, chainOk: true, signaturesOk: false, _isError: false });
    expect(v.firstBroken).toBeUndefined();
    expect(v.signatures).toHaveLength(1);
    expect(v.signatures[0]).toMatchObject({ keyFingerprint: signer, ok: false });
    expect(v.meaning).not.toBe(INTACT);
    expect(v.meaning).toContain("signature");
    // Not a second opinion: the same entries `verify --json` reports.
    const cli = cliVerdict(dir);
    expect({ ok: cli.ok, chainOk: cli.chainOk, signaturesOk: cli.signaturesOk }).toEqual({
      ok: v.verified,
      chainOk: v.chainOk,
      signaturesOk: v.signaturesOk,
    });
    expect(v.signatures).toEqual(cli.signatures);

    const show = call(dir, "agit_show", { id: ID }) as { unverifiedReason?: string };
    expect(show.unverifiedReason).toMatch(/^signature SHA256:\S+: does not match this head/);

    // The edited text itself comes back flagged, which is the case that matters.
    const forged = call(dir, "agit_grep", { pattern: "EDITED AFTER SIGNING" }) as {
      hits: { verified: boolean }[];
    };
    expect(forged.hits).toHaveLength(1);
    expect(forged.hits[0]!.verified).toBe(false);
  }, 60_000);

  it("a signed session nobody touched stays verified, with its signature listed as holding", () => {
    // Guards the other direction: a check that used the wrong head (or the
    // wrong session id) would fail every honest signature.
    const dir = storeWith(DEMO);
    sign(dir, ID, newKey(dir, "a"));

    expect(verifiedEverywhere(dir)).toEqual(everywhere(true));
    const v = call(dir, "agit_verify", { id: ID }) as unknown as VerifyResult;
    expect(v).toMatchObject({ verified: true, chainOk: true, signaturesOk: true, meaning: INTACT });
    expect(v.signatures).toHaveLength(1);
    expect(v.signatures[0]!.ok).toBe(true);
    expect(v.signatures).toEqual(cliVerdict(dir).signatures);
    expect(call(dir, "agit_show", { id: ID }).unverifiedReason).toBeUndefined();
  }, 60_000);

  it("an unsigned session is still verified, and agit_verify keeps every field it had", () => {
    const dir = storeWith(DEMO);

    expect(verifiedEverywhere(dir)).toEqual(everywhere(true));
    const v = call(dir, "agit_verify", { id: "demo" }) as unknown as VerifyResult;
    expect(v).toMatchObject({
      id: ID,
      verified: true,
      events: 31,
      recordedEventCount: 31,
      meaning: INTACT,
      chainOk: true,
      signaturesOk: true,
      signatures: [],
    });
    expect(v.headHash).toBe(readMeta(dir, ID).headHash);
  });

  it("one bad signature fails the session even when another on the same head holds", () => {
    // A valid signature from another session, grafted on: right key, wrong
    // head. It sits after an honest one, so a check that stopped at the first
    // signature would pass it.
    const dir = storeWith(DEMO, SIMPLE);
    sign(dir, ID, newKey(dir, "a"));
    sign(dir, "fixture-simple-0001", newKey(dir, "b"));
    const grafted = readMeta(dir, "fixture-simple-0001").signatures![0]!;
    const meta = readMeta(dir, ID);
    writeMeta(dir, ID, { ...meta, signatures: [...meta.signatures!, grafted] });
    expect(agit(["verify", ID, "--dir", dir]).code).toBe(1);

    expect(verifiedEverywhere(dir)).toEqual(everywhere(false));
    const v = call(dir, "agit_verify", { id: ID }) as unknown as VerifyResult;
    expect(v).toMatchObject({ verified: false, chainOk: true, signaturesOk: false });
    expect(v.signatures.map((s) => s.ok)).toEqual([true, false]);
    expect(call(dir, "agit_show", { id: ID }).unverifiedReason).toContain(grafted.keyFingerprint);

    // The session the signature was taken from is not affected by the theft.
    const list = call(dir, "agit_list") as { sessions: { id: string; verified: boolean }[] };
    expect(list.sessions.find((s) => s.id === "fixture-simple-0001")?.verified).toBe(true);
  }, 60_000);

  it("a signatures field that is not an array of records is a failed check, not a crash", () => {
    // meta.json is third-party input once a bundle has been adopted.
    for (const bad of [{}, [null]]) {
      const dir = storeWith(DEMO);
      writeMeta(dir, ID, { ...readMeta(dir, ID), signatures: bad });

      const v = call(dir, "agit_verify", { id: ID }) as unknown as VerifyResult;
      expect(v, JSON.stringify(bad)).toMatchObject({
        _isError: false,
        verified: false,
        chainOk: true,
        signaturesOk: false,
      });
      expect(v.signatures).toHaveLength(1);
      expect(v.signatures[0]!.reason).toContain("malformed record");

      const show = call(dir, "agit_show", { id: ID }) as { verified: boolean; unverifiedReason?: string };
      expect(show.verified).toBe(false);
      expect(show.unverifiedReason).toContain("malformed record");
      const list = call(dir, "agit_list") as { sessions: { verified: boolean }[] };
      expect(list.sessions[0]!.verified).toBe(false);
    }
  });

  it("a chain broken in place is still reported as a broken chain, not as a signature", () => {
    // Editing a byte without rechaining leaves meta.json's head, and so the
    // signature over it, untouched. The chain is what failed, and the answer
    // has to say that rather than blame the signature.
    const dir = storeWith(DEMO);
    sign(dir, ID, newKey(dir, "a"));
    const path = fileOf(dir, ID, "events.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace("rate limiting", "RATE LIMITING"), "utf8");

    expect(verifiedEverywhere(dir)).toEqual(everywhere(false));
    const v = call(dir, "agit_verify", { id: ID }) as unknown as VerifyResult;
    expect(v).toMatchObject({ verified: false, chainOk: false, signaturesOk: true });
    expect(v.firstBroken?.seq).toBe(1);
    expect(v.meaning).toContain("The chain does not verify");
    const cli = cliVerdict(dir);
    expect({ ok: cli.ok, chainOk: cli.chainOk, signaturesOk: cli.signaturesOk }).toEqual({
      ok: false,
      chainOk: false,
      signaturesOk: true,
    });
    expect(call(dir, "agit_show", { id: ID }).unverifiedReason).toMatch(/^seq 1: /);
  }, 60_000);
});
