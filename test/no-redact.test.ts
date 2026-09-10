import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `agit import --no-redact` and the `share`/`pr` gate that follows it
 * (issue #70, the redaction-controls request). Redaction is a fixed pattern
 * list applied unconditionally at import (SPEC §8) — this adds an explicit
 * opt-out for it, and refuses to hand that unredacted session to anyone else
 * (share/pr) unless the opt-out is repeated with --allow-unredacted.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function freshStore(): string {
  return mkdtempSync(join(tmpdir(), "agit-no-redact-"));
}

describe("agit import --no-redact", () => {
  it("stores the session verbatim: no [REDACTED:...] markers, and says so", () => {
    const store = freshStore();
    const r = agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("redacted    SKIPPED (--no-redact)");
    const jsonl = readFileSync(
      join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl"),
      "utf8",
    );
    expect(jsonl).not.toContain("REDACTED");
    const meta = JSON.parse(
      readFileSync(join(store, ".agit", "sessions", "fixture-simple-0001", "meta.json"), "utf8"),
    ) as { redactionSkipped?: boolean; redactions: Record<string, number> };
    expect(meta.redactionSkipped).toBe(true);
    expect(meta.redactions).toEqual({});
  });

  it("a normal import (no flag) still redacts, and carries no redactionSkipped marker", () => {
    const store = freshStore();
    expect(agit(["import", SIMPLE, "--dir", store]).code).toBe(0);
    const jsonl = readFileSync(
      join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain("REDACTED:anthropic-key");
    const meta = JSON.parse(
      readFileSync(join(store, ".agit", "sessions", "fixture-simple-0001", "meta.json"), "utf8"),
    ) as { redactionSkipped?: boolean };
    expect(meta.redactionSkipped).toBeUndefined();
  });

  it("show reports the skip plainly", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    const text = agit(["show", "fixture-simple-0001", "--dir", store]);
    expect(text.out).toContain("redactions  SKIPPED at import (--no-redact)");
  });

  it("pr refuses an unredacted session without --allow-unredacted", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    const r = agit(["pr", "fixture-simple-0001", "--dir", store, "--out", join(store, "bundle")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("never scanned for credentials");
    expect(r.out).toContain("--allow-unredacted");
  });

  it("pr proceeds with --allow-unredacted", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    const r = agit([
      "pr",
      "fixture-simple-0001",
      "--dir",
      store,
      "--out",
      join(store, "bundle"),
      "--allow-unredacted",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("handoff bundle for fixture-simple-0001");
  });

  it("pr on a normally-redacted session needs no flag at all", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--dir", store]);
    const r = agit(["pr", "fixture-simple-0001", "--dir", store, "--out", join(store, "bundle")]);
    expect(r.code).toBe(0);
  });

  it("share (static, from the store) refuses an unredacted session before touching the network", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    // No relay is running; a refusal here proves the gate runs before any
    // network call, not that the relay happened to be reachable.
    const r = agit(["share", "fixture-simple-0001", "--static", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("never scanned for credentials");
  });
});

describe("switching redaction mode on an already-imported file", () => {
  // The dedupe that makes `import --all` cheap keys on the source file's
  // sha256. --no-redact makes the stored output depend on a flag as well, so
  // without this the store's redaction state freezes at whatever the first
  // import happened to use — and the obvious remedy reports success while
  // changing nothing.
  it("re-importing without the flag actually undoes an accidental --no-redact", () => {
    const store = freshStore();
    expect(agit(["import", SIMPLE, "--no-redact", "--dir", store]).out).toContain("SKIPPED (--no-redact)");
    const metaPath = join(store, ".agit", "sessions", "fixture-simple-0001", "meta.json");
    const logPath = join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl");
    expect(readFileSync(logPath, "utf8")).not.toContain("[REDACTED:");
    expect(JSON.parse(readFileSync(metaPath, "utf8")).redactionSkipped).toBe(true);

    const cure = agit(["import", SIMPLE, "--dir", store]);
    expect(cure.code).toBe(0);
    expect(cure.out).not.toContain("nothing to do");
    expect(cure.out).toContain("redaction was OFF (--no-redact) for the stored copy; it is now ON");
    expect(readFileSync(logPath, "utf8")).toContain("[REDACTED:");
    expect(JSON.parse(readFileSync(metaPath, "utf8")).redactionSkipped).toBeUndefined();
  });

  it("--no-redact on an already-redacted session takes effect instead of no-opping", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--dir", store]);
    const logPath = join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl");
    expect(readFileSync(logPath, "utf8")).toContain("[REDACTED:");

    const again = agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("redaction was ON for the stored copy; it is now OFF");
    expect(readFileSync(logPath, "utf8")).not.toContain("[REDACTED:");
  });

  it("a re-import with the SAME mode is still the cheap no-op import --all relies on", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--dir", store]);
    const before = readFileSync(join(store, ".agit", "sessions", "fixture-simple-0001", "meta.json"), "utf8");
    const again = agit(["import", SIMPLE, "--dir", store]);
    expect(again.out).toContain("nothing to do");
    expect(readFileSync(join(store, ".agit", "sessions", "fixture-simple-0001", "meta.json"), "utf8")).toBe(
      before,
    );

    const skipped = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", skipped]);
    expect(agit(["import", SIMPLE, "--no-redact", "--dir", skipped]).out).toContain("nothing to do");
  });
});

describe("handing an unredacted session onward", () => {
  it("export-html refuses it, like pr and share", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    const out = join(store, "page.html");
    const r = agit(["export-html", "fixture-simple-0001", "--out", out, "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("never scanned for credentials");
    expect(existsSync(out)).toBe(false);

    const allowed = agit([
      "export-html",
      "fixture-simple-0001",
      "--out",
      out,
      "--allow-unredacted",
      "--dir",
      store,
    ]);
    expect(allowed.code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("adopting a bundle from a --no-redact origin tells the recipient it was never scanned", () => {
    const origin = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", origin]);
    const bundle = join(origin, "bundle");
    expect(
      agit(["pr", "fixture-simple-0001", "--out", bundle, "--allow-unredacted", "--dir", origin]).code,
    ).toBe(0);

    const recipient = freshStore();
    const adopted = agit(["import", bundle, "--dir", recipient]);
    expect(adopted.code).toBe(0);
    // The recipient has the least context; silence here would read as "scanned, nothing found".
    expect(adopted.out).toContain("never scanned for credentials");
    // And the marker still travels, so their own share/pr stays gated.
    expect(agit(["pr", "fixture-simple-0001", "--out", join(recipient, "b2"), "--dir", recipient]).code).toBe(
      1,
    );
  });
});
