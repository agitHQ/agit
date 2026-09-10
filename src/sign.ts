/**
 * Ed25519 signatures over a session's head (issue #68).
 *
 * The hash chain proves a log was not modified after it was chained. It does
 * not prove *who* chained it: anyone can build a fresh, perfectly valid chain
 * over edited content. A signature binds a head to a key someone holds, which
 * is the missing half.
 *
 * What a signature here does and does not say:
 *
 * - **Does**: this key signed this session id, at this event count, with this
 *   head hash. Change any event and the head moves, so the signature stops
 *   matching. Re-chaining edited content produces a head this key never
 *   signed.
 * - **Does not**: prove *when*. The `at` field is inside the signed payload,
 *   so it cannot be edited after the fact — but it is still a time the signer
 *   chose. Only an RFC 3161 time-stamp from a third party turns that claim
 *   into evidence, and agit does not issue one yet (#68 tracks it).
 * - **Does not**: say the content is true. A signature over a log full of
 *   lies is a signed log full of lies. It binds an identity to bytes, nothing
 *   more.
 *
 * Signatures live in `meta.json`, never in the chain. An event's hash covers
 * the event; signing is something done *to* a finished head, so putting it in
 * the chain would mean the chain covered a thing that did not exist when it
 * was built. It also means a signature can be added, or a second one
 * appended, without rewriting a single event.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalJson } from "./format/canonical.js";

/** Bumped only if the signed payload's shape changes; verifiers check it. */
export const SIGNATURE_PAYLOAD_VERSION = 1;

export interface AgitSignature {
  /** Always "ed25519" today. Present so a verifier never has to infer it. */
  alg: "ed25519";
  /** The public key in OpenSSH one-line form, so it can be pasted anywhere SSH keys go. */
  key: string;
  /** SHA256:… as `ssh-keygen -l` prints it — the short form humans compare. */
  keyFingerprint: string;
  /** Base64 signature over the canonical payload below. */
  sig: string;
  /** The signer's own claim about when. Signed, so it cannot be edited later; not proof. */
  at: string;
  /** Payload shape this signature covers. */
  payloadVersion: number;
}

export interface SignedPayload {
  agitSignature: number;
  sessionId: string;
  headHash: string;
  eventCount: number;
  at: string;
}

export class KeyError extends Error {}

/**
 * The exact bytes a signature covers (SPEC §12).
 *
 * Canonical JSON, so an independent implementation reproduces it byte for
 * byte from the same four facts and can verify without agit.
 */
export function signedBytes(p: SignedPayload): Buffer {
  return Buffer.from(
    canonicalJson({
      agitSignature: p.agitSignature,
      sessionId: p.sessionId,
      headHash: p.headHash,
      eventCount: p.eventCount,
      at: p.at,
    }),
    "utf8",
  );
}

// --- key loading ------------------------------------------------------------

const SSH_ED25519 = "ssh-ed25519";

/** Read a length-prefixed field from an OpenSSH binary blob. */
function readField(buf: Buffer, at: number): { value: Buffer; next: number } {
  if (at + 4 > buf.length) throw new KeyError("truncated OpenSSH key");
  const len = buf.readUInt32BE(at);
  const start = at + 4;
  if (start + len > buf.length) throw new KeyError("truncated OpenSSH key");
  return { value: buf.subarray(start, start + len), next: start + len };
}

function sshField(b: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

/** The one-line `ssh-ed25519 AAAA…` form, from the 32 raw public bytes. */
export function opensshPublicKey(raw: Buffer): string {
  const blob = Buffer.concat([sshField(Buffer.from(SSH_ED25519, "utf8")), sshField(raw)]);
  return `${SSH_ED25519} ${blob.toString("base64")}`;
}

/** `SHA256:…`, base64 without padding — what `ssh-keygen -l` shows. */
export function fingerprint(raw: Buffer): string {
  const blob = Buffer.concat([sshField(Buffer.from(SSH_ED25519, "utf8")), sshField(raw)]);
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/** Parse the 32 raw bytes out of a one-line `ssh-ed25519 AAAA…` public key. */
export function parseOpensshPublicKey(line: string): Buffer {
  const parts = line.trim().split(/\s+/);
  const idx = parts.indexOf(SSH_ED25519);
  if (idx === -1 || parts[idx + 1] === undefined) {
    throw new KeyError(`not an ${SSH_ED25519} public key: ${JSON.stringify(line.slice(0, 40))}`);
  }
  const blob = Buffer.from(parts[idx + 1]!, "base64");
  const type = readField(blob, 0);
  if (type.value.toString("utf8") !== SSH_ED25519) throw new KeyError("public key is not ed25519");
  return readField(blob, type.next).value;
}

/**
 * Parse an unencrypted OpenSSH private key ("-----BEGIN OPENSSH PRIVATE KEY-----").
 *
 * Node reads PKCS#8 natively but not this format, and this is the file most
 * developers actually have at ~/.ssh/id_ed25519, so it is worth the parser.
 *
 * Encrypted keys are refused rather than decrypted: that would mean handling
 * a passphrase, and the fix is one `ssh-keygen` command the owner runs
 * themselves.
 */
function parseOpensshPrivateKey(pem: string): { priv: KeyObject; pub: Buffer } {
  const b64 = pem.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");

  const magic = "openssh-key-v1\0";
  if (buf.subarray(0, magic.length).toString("binary") !== magic) {
    throw new KeyError("not an OpenSSH private key");
  }
  let at = magic.length;
  const cipher = readField(buf, at);
  at = cipher.next;
  const kdf = readField(buf, at);
  at = kdf.next;
  const kdfOpts = readField(buf, at);
  at = kdfOpts.next;

  const cipherName = cipher.value.toString("utf8");
  if (cipherName !== "none" || kdf.value.toString("utf8") !== "none") {
    throw new KeyError(
      `this key is encrypted (${cipherName}). agit does not take passphrases.\n` +
        "Export an unencrypted copy you control, and sign with that:\n" +
        "  ssh-keygen -p -f <key> -m PKCS8 -N '' -out <key>.pem\n" +
        "or generate a signing key: ssh-keygen -t ed25519 -N '' -f agit-signing-key",
    );
  }

  // The key count is a bare uint32, not a length-prefixed field. Reading it
  // as one swallows the public key blob's length and everything downstream.
  if (at + 4 > buf.length) throw new KeyError("truncated OpenSSH key");
  const keyCount = buf.readUInt32BE(at);
  at += 4;
  if (keyCount !== 1) throw new KeyError(`expected one key in the file, found ${keyCount}`);

  const pubBlob = readField(buf, at);
  at = pubBlob.next;
  const privBlob = readField(buf, at);

  // The private section: two check ints, then type, public, private, comment.
  let p = 8;
  const type = readField(privBlob.value, p);
  p = type.next;
  if (type.value.toString("utf8") !== SSH_ED25519) {
    throw new KeyError(
      `unsupported key type ${JSON.stringify(type.value.toString("utf8"))}; agit signs with ed25519`,
    );
  }
  const pub = readField(privBlob.value, p);
  p = pub.next;
  const secret = readField(privBlob.value, p);
  // OpenSSH stores seed||public for ed25519; PKCS#8 wants the 32-byte seed.
  const seed = secret.value.subarray(0, 32);

  // Wrap the raw seed in the minimal PKCS#8 DER that node will read.
  const der = Buffer.concat([
    Buffer.from([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ]),
    seed,
  ]);
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { priv, pub: pub.value };
}

export interface LoadedKey {
  priv: KeyObject;
  publicRaw: Buffer;
  publicLine: string;
  fingerprint: string;
}

/**
 * Load an Ed25519 private key from PEM (PKCS#8) or an unencrypted OpenSSH
 * private key. Anything else is named rather than guessed at.
 */
export function loadPrivateKey(pem: string): LoadedKey {
  let priv: KeyObject;
  let publicRaw: Buffer;

  if (pem.includes("BEGIN OPENSSH PRIVATE KEY")) {
    const parsed = parseOpensshPrivateKey(pem);
    priv = parsed.priv;
    publicRaw = parsed.pub;
  } else {
    try {
      priv = createPrivateKey(pem);
    } catch (e) {
      throw new KeyError(
        `cannot read this key: ${e instanceof Error ? e.message : String(e)}\n` +
          "agit reads PKCS#8 PEM and unencrypted OpenSSH ed25519 keys.",
      );
    }
    if (priv.asymmetricKeyType !== "ed25519") {
      throw new KeyError(`this is an ${priv.asymmetricKeyType ?? "unknown"} key; agit signs with ed25519`);
    }
    // The last 32 bytes of the SPKI DER are the raw public key.
    const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
    publicRaw = Buffer.from(spki.subarray(spki.length - 32));
  }

  return {
    priv,
    publicRaw,
    publicLine: opensshPublicKey(publicRaw),
    fingerprint: fingerprint(publicRaw),
  };
}

/** Rebuild a verifying key from the stored one-line public key. */
export function publicKeyFromLine(line: string): { key: KeyObject; raw: Buffer } {
  const raw = parseOpensshPublicKey(line);
  const der = Buffer.concat([
    Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
    raw,
  ]);
  return { key: createPublicKey({ key: der, format: "der", type: "spki" }), raw };
}

// --- sign and verify --------------------------------------------------------

export function signHead(key: LoadedKey, payload: SignedPayload): AgitSignature {
  const sig = cryptoSign(null, signedBytes(payload), key.priv);
  return {
    alg: "ed25519",
    key: key.publicLine,
    keyFingerprint: key.fingerprint,
    sig: sig.toString("base64"),
    at: payload.at,
    payloadVersion: payload.agitSignature,
  };
}

export type SignatureVerdict =
  { ok: true; fingerprint: string; at: string } | { ok: false; fingerprint: string | null; reason: string };

/**
 * Check one signature against the head agit currently holds.
 *
 * A mismatch is the interesting case and it has two very different causes:
 * the log changed after signing, or the signature was never valid. Both mean
 * "do not trust this", so both are reported the same way and loudly.
 */
export function verifySignature(
  s: AgitSignature,
  head: { sessionId: string; headHash: string; eventCount: number },
): SignatureVerdict {
  if (s.alg !== "ed25519") return { ok: false, fingerprint: null, reason: `unsupported algorithm ${s.alg}` };
  if (s.payloadVersion !== SIGNATURE_PAYLOAD_VERSION) {
    return {
      ok: false,
      fingerprint: s.keyFingerprint ?? null,
      reason: `signature payload version ${s.payloadVersion}, this agit understands ${SIGNATURE_PAYLOAD_VERSION}`,
    };
  }
  let pub;
  try {
    pub = publicKeyFromLine(s.key);
  } catch (e) {
    return { ok: false, fingerprint: null, reason: e instanceof Error ? e.message : String(e) };
  }
  // The stored fingerprint is a convenience field; recompute it so a doctored
  // one cannot make an unrelated key look familiar.
  const real = fingerprint(pub.raw);
  if (s.keyFingerprint !== real) {
    return {
      ok: false,
      fingerprint: real,
      reason: `stored fingerprint ${s.keyFingerprint} does not match its own key`,
    };
  }

  const bytes = signedBytes({
    agitSignature: s.payloadVersion,
    sessionId: head.sessionId,
    headHash: head.headHash,
    eventCount: head.eventCount,
    at: s.at,
  });
  let good: boolean;
  try {
    good = cryptoVerify(null, bytes, pub.key, Buffer.from(s.sig, "base64"));
  } catch {
    // A malformed signature throws rather than returning false. Either way
    // the answer is the same: this does not verify.
    good = false;
  }
  return good
    ? { ok: true, fingerprint: real, at: s.at }
    : {
        ok: false,
        fingerprint: real,
        reason: "does not match this head — the log changed after signing, or the signature was never valid",
      };
}
