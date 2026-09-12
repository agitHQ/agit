import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  publicKeyFromLine,
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

/**
 * Take an unencrypted OpenSSH ed25519 key apart and put it back together
 * with one field changed, the way a corrupted or hand-built file would be.
 * ssh-keygen will not write these, so the tests have to.
 */
function rebuildOpensshKey(
  pem: string,
  edit: { pub?: (b: Buffer) => Buffer; secret?: (b: Buffer) => Buffer },
): string {
  const buf = Buffer.from(
    pem.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  let at = "openssh-key-v1\0".length;
  const read = (b: Buffer): Buffer => {
    const len = b.readUInt32BE(at);
    const v = b.subarray(at + 4, at + 4 + len);
    at += 4 + len;
    return v;
  };
  const field = (b: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  const cipher = read(buf);
  const kdf = read(buf);
  const kdfOpts = read(buf);
  at += 4; // key count
  read(buf); // outer public blob, rebuilt below
  const priv = read(buf);

  at = 8; // the two check ints
  const type = read(priv);
  const pub = (edit.pub ?? ((b) => b))(read(priv));
  const secret = (edit.secret ?? ((b) => b))(read(priv));
  const comment = read(priv);
  let section = Buffer.concat([priv.subarray(0, 8), field(type), field(pub), field(secret), field(comment)]);
  for (let i = 1; section.length % 8 !== 0; i++) section = Buffer.concat([section, Buffer.from([i])]);

  const out = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    field(cipher),
    field(kdf),
    field(kdfOpts),
    Buffer.from([0, 0, 0, 1]),
    field(Buffer.concat([field(type), field(pub)])),
    field(section),
  ]);
  const lines = out
    .toString("base64")
    .match(/.{1,70}/g)!
    .join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;
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

  it("gives an encrypted-key hint that works, and leaves the original key alone", () => {
    const enc = join(keyDir, "enc-hint");
    ssh("-t", "ed25519", "-N", "hunter2", "-f", enc);
    let hint = "";
    try {
      loadPrivateKey(readFileSync(enc, "utf8"));
    } catch (e) {
      hint = (e as Error).message;
    }
    // ssh-keygen has no -out flag: it parsed the old hint as `-o -u -t
    // <key>.pem`, stripped the passphrase from ~/.ssh/id_ed25519 in place,
    // and wrote no .pem. The hint has to copy first.
    expect(hint).not.toContain("-out");
    expect(hint).toContain("cp <key> agit-signing-key && ssh-keygen -p -f agit-signing-key -N ''");

    // Run the recipe it gives (with -P for the old passphrase, since a test
    // cannot answer a prompt) and check both halves of the promise.
    const copy = join(keyDir, "enc-hint-copy");
    copyFileSync(enc, copy);
    ssh("-p", "-P", "hunter2", "-f", copy, "-N", "");
    expect(loadPrivateKey(readFileSync(copy, "utf8")).fingerprint).toMatch(/^SHA256:/);
    expect(() => loadPrivateKey(readFileSync(enc, "utf8"))).toThrow(/encrypted/);
  });

  it("refuses an OpenSSH key whose stored public key is not the one its seed produces", () => {
    // Nothing in the file format ties the public field to the seed. Signing
    // with the seed and publishing the stored key made `agit sign` exit 0
    // with a fingerprint that had signed nothing, and `agit verify` reject
    // the record it had just written.
    const pem = rebuildOpensshKey(readFileSync(sshKey, "utf8"), {
      pub: (b) => {
        const c = Buffer.from(b);
        c[0] = c[0]! ^ 0xff;
        return c;
      },
    });
    expect(() => loadPrivateKey(pem)).toThrow(/disagrees with itself/);

    const bad = join(keyDir, "mismatched");
    writeFileSync(bad, pem, "utf8");
    const dir = storeWithDemo();
    const r = agit(["sign", "demo", "--key", bad, "--dir", dir]);
    expect(r.code).toBe(1);
    expect(metaOf(dir).signatures).toBeUndefined();
  });

  it("requires a public key of exactly 32 bytes, in a key line and in a key file", () => {
    const k = loadPrivateKey(readFileSync(sshKey, "utf8"));
    // The SPKI wrapper declares 32 bytes and OpenSSL reads no further, so a
    // padded key verified with the real key under a fingerprint of the
    // padded blob: one seed, as many "different" fingerprints as it liked,
    // none of them one ssh-keygen would print.
    const padded = Buffer.concat([k.publicRaw, Buffer.alloc(40, 0x41)]);
    expect(() => parseOpensshPublicKey(opensshPublicKey(padded))).toThrow(/72 bytes, expected 32/);
    expect(() => parseOpensshPublicKey(opensshPublicKey(k.publicRaw.subarray(0, 31)))).toThrow(KeyError);

    const pem = readFileSync(sshKey, "utf8");
    expect(() =>
      loadPrivateKey(rebuildOpensshKey(pem, { pub: (b) => Buffer.concat([b, Buffer.from([0])]) })),
    ).toThrow(/33 bytes, expected 32/);
    // A short secret used to surface as a raw OpenSSL "not enough data".
    expect(() => loadPrivateKey(rebuildOpensshKey(pem, { secret: (b) => b.subarray(0, 20) }))).toThrow(
      /20 bytes, expected 64/,
    );
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

  it("does not let a padded key line verify under a fingerprint nobody can check", () => {
    // The signature is real; only the key line grew. It verified, because
    // OpenSSL ignores what the DER does not declare, and it printed a
    // fingerprint `ssh-keygen -lf` calls "not a public key file".
    const k = loadPrivateKey(readFileSync(sshKey, "utf8"));
    const padded = Buffer.concat([k.publicRaw, Buffer.alloc(40, 0x41)]);
    const r = verifySignature(
      { ...sign(), key: opensshPublicKey(padded), keyFingerprint: fingerprint(padded) },
      head,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("expected 32");
  });

  it("refuses a small-order public key, which would verify signatures nobody made", () => {
    // OpenSSL accepts these keys, and with S = 0 and R picked from the same
    // eight points the verification equation holds for any head: a record
    // with no private key behind it reads as signed. libsodium refuses the
    // key, and SPEC §12 says an independent verifier must agree with agit.
    const forgeries: [Buffer, Buffer][] = [
      [Buffer.alloc(32), Buffer.alloc(32)],
      [
        Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]),
        Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]),
      ],
    ];
    for (const [raw, R] of forgeries) {
      const r = verifySignature(
        {
          alg: "ed25519",
          key: opensshPublicKey(raw),
          keyFingerprint: fingerprint(raw),
          sig: Buffer.concat([R, Buffer.alloc(32)]).toString("base64"),
          at,
          payloadVersion: SIGNATURE_PAYLOAD_VERSION,
        },
        head,
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain("small-order");
    }
    // The non-canonical spelling of the identity (y = p + 1) is the same point.
    const nonCanonical = Buffer.from(
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "hex",
    );
    expect(() => publicKeyFromLine(opensshPublicKey(nonCanonical))).toThrow(/small-order/);
    // And a real key is not caught in the net.
    expect(() => publicKeyFromLine(loadPrivateKey(readFileSync(sshKey, "utf8")).publicLine)).not.toThrow();
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

    // The README shows this exact run as the reason `sign` exists. It once
    // showed the `ok:` prefix the code dropped for reading as a pass, so
    // hold it to the output the code prints today, line by line.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const [verdict, mismatch] = r.out.split("\n");
    expect(readme).toContain(verdict);
    expect(readme).toContain(mismatch!.slice(mismatch!.indexOf("): ") + 3));
  });

  it("fails verify on a record whose key is a small-order point", () => {
    // The finding's shape: no key material anywhere, and `verify` used to
    // print `signed by` and exit 0.
    const dir = storeWithDemo();
    const metaPath = join(dir, ".agit", "sessions", SESSION, "meta.json");
    const meta = metaOf(dir);
    const raw = Buffer.alloc(32);
    meta.signatures = [
      {
        alg: "ed25519",
        key: opensshPublicKey(raw),
        keyFingerprint: fingerprint(raw),
        sig: Buffer.alloc(64).toString("base64"),
        at: "2026-01-01T00:00:00.000Z",
        payloadVersion: SIGNATURE_PAYLOAD_VERSION,
      },
    ];
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

    const r = agit(["verify", "demo", "--dir", dir]);
    expect(r.out).not.toContain("signed by");
    expect(r.out).toContain("SIGNATURE DOES NOT MATCH");
    expect(r.code).toBe(1);
    const doc = JSON.parse(agit(["verify", "demo", "--json", "--dir", dir]).out) as { signaturesOk: boolean };
    expect(doc.signaturesOk).toBe(false);
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

    // "Same key" is decided by fingerprint, so a key file with a padded
    // public field used to sign as a third party: the same seed, stacked
    // under a fingerprint nothing else would ever print.
    const padded = join(keyDir, "padded");
    writeFileSync(
      padded,
      rebuildOpensshKey(readFileSync(sshKey, "utf8"), {
        pub: (b) => Buffer.concat([b, Buffer.alloc(40, 0x41)]),
      }),
      "utf8",
    );
    expect(agit(["sign", "demo", "--key", padded, "--dir", dir]).code).toBe(1);
    expect(metaOf(dir).signatures).toHaveLength(2);
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

  it("reports a signatures field that is not an array of records instead of crashing", () => {
    // meta.json is third-party input once a bundle is adopted, and adoption
    // checks the chain, not the meta. `"signatures": {}` used to take verify
    // down with a bare TypeError (0 bytes on stdout under --json) and sign
    // with another.
    for (const bad of [{}, "x", true, [null], [42]]) {
      const dir = storeWithDemo();
      const metaPath = join(dir, ".agit", "sessions", SESSION, "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      meta.signatures = bad;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

      const r = agit(["verify", "demo", "--dir", dir]);
      expect(r.code, JSON.stringify(bad)).toBe(1);
      expect(r.out).not.toMatch(/is not a function|Cannot read properties/);
      expect(r.out).toContain("chain intact");
      expect(r.out).toContain("SIGNATURE DOES NOT MATCH");
      expect(r.out).toContain("malformed record");

      const j = agit(["verify", "demo", "--json", "--dir", dir]);
      expect(j.code).toBe(1);
      const doc = JSON.parse(j.out) as {
        ok: boolean;
        chainOk: boolean;
        signaturesOk: boolean;
        signatures: { ok: boolean; reason?: string }[];
      };
      expect(doc).toMatchObject({ ok: false, chainOk: true, signaturesOk: false });
      expect(doc.signatures).toHaveLength(1);
      expect(doc.signatures[0]!.ok).toBe(false);
      expect(doc.signatures[0]!.reason).toContain("malformed record");

      // Signing next to junk would put a name behind a meta.json verify keeps
      // failing; it is refused and named, and the file is left alone.
      const s = agit(["sign", "demo", "--key", sshKey, "--dir", dir]);
      expect(s.code).toBe(1);
      expect(s.out).toContain("refusing to sign");
      expect(s.out).not.toMatch(/is not a function|Cannot read properties/);
      expect((JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>).signatures).toEqual(bad);
    }
    // Five shapes, four CLI runs each: well past the default under a loaded
    // parallel run on Windows.
  }, 90_000);

  it("names a bundle meta.json that is not JSON when verifying the log beside it", () => {
    const dir = storeWithDemo();
    const out = join(dir, "bundle");
    expect(agit(["pr", "demo", "--out", out, "--dir", dir]).code).toBe(0);
    writeFileSync(join(out, "meta.json"), "not json {", "utf8");

    const r = agit(["verify", join(out, "events.jsonl"), "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("Unexpected token");
    expect(r.out).toContain(join(out, "meta.json"));
    expect(r.out).toContain("not readable JSON");
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
