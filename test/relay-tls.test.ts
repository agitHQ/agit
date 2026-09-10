import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startRelay } from "../src/relay/relay.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/**
 * A throwaway self-signed cert for localhost.
 *
 * Generated per run rather than committed: a PEM private key in the repo is a
 * thing secret scanners and readers both have to reason about, and this one
 * would be worth exactly nothing to either. Returns null when openssl is not
 * on PATH, and the TLS round-trip is skipped rather than failing the suite on
 * a machine that cannot produce a certificate.
 */
function makeCert(): { cert: string; key: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "agit-tls-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
  } catch {
    return null;
  }
  return existsSync(cert) && existsSync(key) ? { cert, key } : null;
}

/** One HTTPS GET that accepts the self-signed certificate. */
function httpsGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", rejectUnauthorized: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const PEM = makeCert();

describe("relay TLS (#87)", () => {
  it("reports http and stays plaintext when given no TLS material", async () => {
    const h = await startRelay({ port: 0 });
    try {
      expect(h.scheme).toBe("http");
    } finally {
      await h.close();
    }
  });

  it.skipIf(PEM === null)("serves the same routes over HTTPS when given a cert and key", async () => {
    const { readFileSync } = await import("node:fs");
    const h = await startRelay({
      port: 0,
      tls: { cert: readFileSync(PEM!.cert, "utf8"), key: readFileSync(PEM!.key, "utf8") },
    });
    try {
      expect(h.scheme).toBe("https");
      // Same route, same body as the HTTP relay: TLS is a socket concern only.
      const root = await httpsGet(h.port, "/");
      expect(root.status).toBe(200);
      expect(root.body).toContain("agit relay v0");
      // And the share page still serves, so the viewer path works end to end.
      const page = await httpsGet(h.port, "/s/" + "a".repeat(22));
      expect(page.status).toBe(200);
      expect(page.body).toContain("<!doctype html>");
    } finally {
      await h.close();
    }
  });

  it("refuses a cert without a key, and a key without a cert", () => {
    const a = agit(["relay", "--cert", "only.pem"]);
    expect(a.code).toBe(2);
    expect(a.out).toContain("--cert and --key go together");

    const b = agit(["relay", "--key", "only.pem"]);
    expect(b.code).toBe(2);
    expect(b.out).toContain("--cert and --key go together");
  });

  it("names the file when the TLS material cannot be read", () => {
    const r = agit([
      "relay",
      "--cert",
      join(tmpdir(), "no-such-cert.pem"),
      "--key",
      join(tmpdir(), "no-such-key.pem"),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("cannot read the TLS material");
  });

  it("refuses to bind beyond loopback without TLS", () => {
    const r = agit(["relay", "--host", "0.0.0.0", "--port", "0"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to bind 0.0.0.0 without TLS");
    // The message has to say what to do instead, not just say no.
    expect(r.out).toContain("--cert");
    expect(r.out).toContain("--insecure");
  });

  it("treats the whole 127.0.0.0/8 block as loopback, not just 127.0.0.1", () => {
    // 127.0.0.2 is as private as the default; refusing it would be wrong, and
    // warning "bound beyond loopback" after --insecure would be untrue.
    const r = agit(["relay", "--host", "127.0.0.2", "--port", "-1"]);
    expect(r.out).not.toContain("refusing to bind");
  });

  it("still allows loopback without TLS, which is the default posture", () => {
    // Nothing to refuse here: the check is about traffic crossing a network.
    // Proven by the flag parse getting far enough to hit the port instead.
    const r = agit(["relay", "--host", "127.0.0.1", "--port", "-1"]);
    expect(r.out).not.toContain("refusing to bind");
  });
});
