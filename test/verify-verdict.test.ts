import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

interface VerifyDoc {
  ok: boolean;
  chainOk: boolean;
  signaturesOk: boolean;
  events: number;
  signed: boolean;
  signatures: { ok: boolean }[];
}

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const OPENSSL = haveOpenssl();

let store: string;
let keyA: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-verdict-"));
  expect(agit(["import", DEMO, "--dir", store]).code).toBe(0);
  expect(agit(["import", SIMPLE, "--dir", store]).code).toBe(0);
  if (OPENSSL) {
    keyA = join(store, "a.pem");
    execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", keyA], { stdio: "ignore" });
  }
});

const metaPath = (id: string): string => join(store, ".agit", "sessions", id, "meta.json");

describe("verify's answer agrees with its exit code", () => {
  it("an unsigned intact session is ok and exits 0", () => {
    const r = agit(["verify", "demo", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as VerifyDoc;
    expect(doc.ok).toBe(true);
    expect(doc.chainOk).toBe(true);
    expect(doc.signaturesOk).toBe(true);
    expect(doc.signed).toBe(false);
  });

  it.skipIf(!OPENSSL)("a signed intact session is ok and exits 0", () => {
    expect(agit(["sign", "demo", "--key", keyA, "--dir", store]).code).toBe(0);
    const r = agit(["verify", "demo", "--json", "--dir", store]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as VerifyDoc;
    expect(doc).toMatchObject({ ok: true, chainOk: true, signaturesOk: true, signed: true });
  });

  it.skipIf(!OPENSSL)("an intact chain with a signature that does not match is not ok", () => {
    // The bug: this reported ok:true and exited 1, which are opposite answers
    // from the one verb whose job is to say whether this can be trusted.
    // Graft another session's signature on: valid signature, wrong head.
    const keyB = join(store, "b.pem");
    execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", keyB], { stdio: "ignore" });
    expect(agit(["sign", "fixture", "--key", keyB, "--dir", store]).code).toBe(0);

    const other = JSON.parse(readFileSync(metaPath("fixture-simple-0001"), "utf8")) as {
      signatures: unknown[];
    };
    const demoMeta = JSON.parse(readFileSync(metaPath("demo-ratelimit-0001"), "utf8")) as {
      signatures: unknown[];
    };
    demoMeta.signatures = other.signatures;
    writeFileSync(metaPath("demo-ratelimit-0001"), JSON.stringify(demoMeta, null, 2) + "\n", "utf8");

    const r = agit(["verify", "demo", "--json", "--dir", store]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.out) as VerifyDoc;
    expect(doc.ok).toBe(false); // agrees with the exit code
    expect(doc.chainOk).toBe(true); // and the chain result is still available
    expect(doc.signaturesOk).toBe(false);
    expect(doc.signatures[0]!.ok).toBe(false);
  });

  it.skipIf(!OPENSSL)("the human output does not lead with ok: on a run that exits 1", () => {
    const r = agit(["verify", "demo", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out.split("\n")[0]).not.toMatch(/^ok:/);
    expect(r.out).toContain("NOT OK");
    // The phrase the adopt and schema-compat suites assert on survives.
    expect(r.out).toContain("chain intact");
    expect(r.out).toContain("SIGNATURE DOES NOT MATCH");
  });

  it("a broken chain is not ok and exits 1", () => {
    const broken = mkdtempSync(join(tmpdir(), "agit-verdict-broken-"));
    const log = join(broken, "events.jsonl");
    const good = readFileSync(join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    good[2] = good[2]!.replace(/"ts":"[^"]+"/, '"ts":"2000-01-01T00:00:00.000Z"');
    writeFileSync(log, good.join("\n") + "\n", "utf8");

    const r = agit(["verify", log, "--json"]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.out) as VerifyDoc;
    expect(doc.ok).toBe(false);
    expect(doc.chainOk).toBe(false);
  });
});
