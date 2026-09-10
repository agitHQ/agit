import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { eventHash } from "../src/format/hash.js";
import type { AgitEvent, SessionMeta } from "../src/format/events.js";
import {
  fingerprint,
  KeyError,
  loadPrivateKey,
  opensshPublicKey,
  parseOpensshPublicKey,
  signedBytes,
  signHead,
  SIGNATURE_PAYLOAD_VERSION,
  verifySignature,
} from "../src/sign.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const SESSION = "demo-ratelimit-0001";

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

/** ssh-keygen with an empty passphrase — an array, because "" cannot survive a split. */
function ssh(...args: string[]): void {
  execFileSync("ssh-keygen", args, { stdio: "pipe" });
}

function storeWithDemo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agit-sign-"));
  expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
  return dir;
}

function metaOf(dir: string): SessionMeta {
  return JSON.parse(
    readFileSync(join(dir, ".agit", "sessions", SESSION, "meta.json"), "utf8"),
  ) as SessionMeta;
}

/** The forger's move: edit content, then rebuild a valid chain and matching head. */
function forge(dir: string): void {
  const p = join(dir, ".agit", "sessions", SESSION, "events.jsonl");
  const events = readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AgitEvent);
  const i = events.findIndex((e) => e.type === "message.assistant");
  events[i]!.payload = { ...(events[i]!.payload as object), text: "I did not do that." };

  let prev: string | null = null;
  for (const e of events) {
    e.prev = prev;
    e.hash = eventHash({
      v: e.v,
      seq: e.seq,
      ts: e.ts,
      session: e.session,
      type: e.type,
      payload: e.payload,
      prev,
    });
    prev = e.hash;
  }
  writeFileSync(
    p,
    events
      .map((e) =>
        JSON.stringify({
          v: e.v,
          seq: e.seq,
          ts: e.ts,
          session: e.session,
          type: e.type,
          payload: e.payload,
          prev: e.prev,
          hash: e.hash,
        }),
      )
      .join("\n") + "\n",
    "utf8",
  );
  const metaPath = join(dir, ".agit", "sessions", SESSION, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
  meta.headHash = events[events.length - 1]!.hash;
  meta.eventCount = events.length;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

let keyDir: string;
let sshKey: string;
beforeAll(() => {
  keyDir = mkdtempSync(join(tmpdir(), "agit-keys-"));
  sshKey = join(keyDir, "id_ed25519");
  ssh("-t", "ed25519", "-N", "", "-C", "agit@test", "-f", sshKey);
});

describe("key handling (#68)", () => {
  it("reads the ed25519 key ssh-keygen writes, and agrees with it on the fingerprint", () => {
    const k = loadPrivateKey(readFileSync(sshKey, "utf8"));
    const theirs = execFileSync("ssh-keygen", ["-lf", `${sshKey}.pub`], { encoding: "utf8" }).split(" ")[1];
    // If agit's fingerprint disagreed with ssh-keygen's, every human check of
    // "is this the key I think it is" would be against a different number.
    expect(k.fingerprint).toBe(theirs);
    expect(k.publicLine).toBe(readFileSync(`${sshKey}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" "));
  });

  it("reads a PKCS#8 PEM key too", () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const k = loadPrivateKey(pem);
    expect(k.fingerprint).toMatch(/^SHA256:/);
    expect(k.publicRaw.length).toBe(32);
  });

  it("refuses an encrypted key rather than asking for a passphrase", () => {
    const enc = join(keyDir, "enc");
    ssh("-t", "ed25519", "-N", "hunter2", "-f", enc);
    expect(() => loadPrivateKey(readFileSync(enc, "utf8"))).toThrow(KeyError);
    try {
      loadPrivateKey(readFileSync(enc, "utf8"));
    } catch (e) {
      // Refusing is only useful if it says what to do instead.
      expect((e as Error).message).toContain("ssh-keygen");
    }
  });

  it("names a key type it cannot sign with instead of guessing", () => {
    const rsa = join(keyDir, "rsa");
    ssh("-t", "rsa", "-b", "2048", "-N", "", "-m", "PKCS8", "-f", rsa);
    expect(() => loadPrivateKey(readFileSync(rsa, "utf8"))).toThrow(/ed25519/);
  });

  it("round-trips a public key through the OpenSSH one-line form", () => {
    const k = loadPrivateKey(readFileSync(sshKey, "utf8"));
    expect(parseOpensshPublicKey(opensshPublicKey(k.publicRaw))).toEqual(k.publicRaw);
    expect(fingerprint(k.publicRaw)).toBe(k.fingerprint);
  });
});

describe("signatures bind a head to a key", () => {
  const head = { sessionId: "s", headHash: "a".repeat(64), eventCount: 31 };
  const at = "2026-09-10T00:00:00.000Z";
  const sign = (): ReturnType<typeof signHead> =>
    signHead(loadPrivateKey(readFileSync(sshKey, "utf8")), {
      agitSignature: SIGNATURE_PAYLOAD_VERSION,
      ...head,
      at,
    });

  it("verifies what it signed", () => {
    expect(verifySignature(sign(), head).ok).toBe(true);
  });

  it("is deterministic: the same facts produce the same bytes", () => {
    // Ed25519 is deterministic, and the payload is canonical JSON, so two
    // signers of the same head must agree byte for byte.
    expect(sign().sig).toBe(sign().sig);
    expect(signedBytes({ agitSignature: 1, ...head, at }).toString("utf8")).toBe(
      signedBytes({ agitSignature: 1, ...head, at }).toString("utf8"),
    );
  });

  it("stops matching when the head moves", () => {
    const r = verifySignature(sign(), { ...head, headHash: "b".repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("does not match this head");
  });

  it("stops matching when the event count changes", () => {
    // Truncation keeps every remaining hash valid, so the count has to be
    // inside the signed payload or a signed log could be silently shortened.
    expect(verifySignature(sign(), { ...head, eventCount: 30 }).ok).toBe(false);
  });

  it("stops matching when the session id changes", () => {
    expect(verifySignature(sign(), { ...head, sessionId: "other" }).ok).toBe(false);
  });

  it("rejects a signature whose key was swapped for another", () => {
    const other = loadPrivateKey(
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const forged = { ...sign(), key: other.publicLine, keyFingerprint: other.fingerprint };
    expect(verifySignature(forged, head).ok).toBe(false);
  });

  it("recomputes the fingerprint instead of believing the stored one", () => {
    // A doctored fingerprint is how an unrelated key gets to look familiar to
    // whoever reads the output.
    const lied = { ...sign(), keyFingerprint: "SHA256:aKeyYouRecognize" };
    const r = verifySignature(lied, head);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("does not match its own key");
  });

  it("refuses a payload version it does not understand", () => {
    expect(verifySignature({ ...sign(), payloadVersion: 99 }, head).ok).toBe(false);
  });
});

describe("agit sign / agit verify", () => {
  it("signs a session and reports it on verify", () => {
    const dir = storeWithDemo();
    const before = agit(["verify", "demo", "--dir", dir]);
    expect(before.code).toBe(0);
    expect(before.out).toContain("unsigned");

    const signed = agit(["sign", "demo", "--key", sshKey, "--dir", dir]);
    expect(signed.code).toBe(0);
    expect(signed.out).toContain("SHA256:");
    // The claim about time must not be sold as proof of time.
    expect(signed.out).toContain("not proof of when");

    const after = agit(["verify", "demo", "--dir", dir]);
    expect(after.code).toBe(0);
    expect(after.out).toMatch(/signed by SHA256:\S+ at \d{4}-/);
  });

  it("stores the signature in meta.json and leaves the chain untouched", () => {
    const dir = storeWithDemo();
    const eventsPath = join(dir, ".agit", "sessions", SESSION, "events.jsonl");
    const before = readFileSync(eventsPath, "utf8");
    const headBefore = metaOf(dir).headHash;

    agit(["sign", "demo", "--key", sshKey, "--dir", dir]);

    // Signing must never move the head it signs.
    expect(readFileSync(eventsPath, "utf8")).toBe(before);
    const meta = metaOf(dir);
    expect(meta.headHash).toBe(headBefore);
    expect(meta.signatures).toHaveLength(1);
    expect(meta.signatures![0]!.alg).toBe("ed25519");
    expect(meta.signatures![0]!.key).toMatch(/^ssh-ed25519 /);
  });

  it("catches a forged chain that verify alone is happy with", () => {
    // The whole point of #68. Re-chaining edited content produces a log whose
    // hashes all recompute and whose meta head matches — the chain cannot tell.
    const dir = storeWithDemo();
    agit(["sign", "demo", "--key", sshKey, "--dir", dir]);
    forge(dir);

    const r = agit(["verify", "demo", "--dir", dir]);
    expect(r.out).toContain("chain intact");
    expect(r.out).toContain("SIGNATURE DOES NOT MATCH");
    expect(r.code).toBe(1);
  });

  it("refuses to sign a log whose chain does not verify", () => {
    const dir = storeWithDemo();
    const p = join(dir, ".agit", "sessions", SESSION, "events.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace("rate limiting", "RATE LIMITING"), "utf8");

    const r = agit(["sign", "demo", "--key", sshKey, "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to sign");
    expect(metaOf(dir).signatures).toBeUndefined();
  });

  it("wants a key, and says how to make one", () => {
    const dir = storeWithDemo();
    const r = agit(["sign", "demo", "--dir", dir]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("ssh-keygen -t ed25519");
  });

  it("re-signing with the same key replaces, a second key appends", () => {
    const dir = storeWithDemo();
    const second = join(keyDir, "second");
    ssh("-t", "ed25519", "-N", "", "-f", second);

    agit(["sign", "demo", "--key", sshKey, "--dir", dir]);
    agit(["sign", "demo", "--key", sshKey, "--dir", dir]);
    expect(metaOf(dir).signatures).toHaveLength(1);

    agit(["sign", "demo", "--key", second, "--dir", dir]);
    // Two people signing the same head is the useful case, not a conflict.
    expect(metaOf(dir).signatures).toHaveLength(2);
    const r = agit(["verify", "demo", "--dir", dir]);
    expect(r.out.match(/signed by/g)).toHaveLength(2);
    expect(r.code).toBe(0);
  });

  it("reports signatures in --json, and fails the exit code on a bad one", () => {
    const dir = storeWithDemo();
    agit(["sign", "demo", "--key", sshKey, "--dir", dir]);

    const good = agit(["verify", "demo", "--json", "--dir", dir]);
    const doc = JSON.parse(good.out) as { signed: boolean; signatures: { ok: boolean }[] };
    expect(doc.signed).toBe(true);
    expect(doc.signatures[0]!.ok).toBe(true);
    expect(good.code).toBe(0);

    forge(dir);
    const bad = agit(["verify", "demo", "--json", "--dir", dir]);
    expect((JSON.parse(bad.out) as { signatures: { ok: boolean }[] }).signatures[0]!.ok).toBe(false);
    expect(bad.code).toBe(1);
  });

  it("carries signatures into a pr bundle, so the recipient can check them", () => {
    const dir = storeWithDemo();
    agit(["sign", "demo", "--key", sshKey, "--dir", dir]);
    const out = join(dir, "bundle");
    expect(agit(["pr", "demo", "--out", out, "--dir", dir]).code).toBe(0);

    const bundled = JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as SessionMeta;
    expect(bundled.signatures).toHaveLength(1);

    // And it still verifies where it lands: a signature that only worked in
    // the store it was made in would be no use to the person receiving it.
    const adopted = mkdtempSync(join(tmpdir(), "agit-adopt-"));
    cpSync(out, join(adopted, "in"), { recursive: true });
    expect(agit(["import", join(adopted, "in"), "--dir", adopted]).code).toBe(0);
    const r = agit(["verify", "demo", "--dir", adopted]);
    expect(r.out).toContain("signed by");
    expect(r.code).toBe(0);
  });
});
