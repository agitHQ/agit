import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { sha256Hex } from "../src/format/hash.js";
import type { Json, SessionMeta } from "../src/format/events.js";
import { loadBaseTree, seedKnownFromBase, BaseTreeError } from "../src/base.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const EDITS = join(ROOT, "fixtures", "codex", "edits.jsonl");

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** The fixture edits existing.py, which it never created — the #85 case exactly. */
const EXISTING_BEFORE = 'def greet(name):\n    return "Hello, " + name\n';
const EXISTING_AFTER = 'def greet(name):\n    return f"Hello, {name}"\n';

let store: string;
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "agit-base-"));
});

function baseDir(content: string): string {
  const dir = join(store, "basetree");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "existing.py"), content, "utf8");
  return dir;
}

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const GIT = haveGit();

describe("loadBaseTree (#85)", () => {
  it("reads a directory as forward-slashed relative paths", () => {
    const dir = baseDir(EXISTING_BEFORE);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "nested.txt"), "hi\n", "utf8");
    const tree = loadBaseTree(dir, store);
    expect(tree.kind).toBe("dir");
    expect(tree.files.get("existing.py")).toBe(EXISTING_BEFORE);
    expect(tree.files.get("sub/nested.txt")).toBe("hi\n");
  });

  it("skips .git and node_modules rather than walking them", () => {
    const dir = baseDir(EXISTING_BEFORE);
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x", "utf8");
    const tree = loadBaseTree(dir, store);
    expect([...tree.files.keys()].some((k) => k.startsWith("node_modules/"))).toBe(false);
  });

  it("reports an unreadable git ref rather than throwing something raw", () => {
    if (!GIT) return;
    expect(() => loadBaseTree("definitely-not-a-ref", ROOT)).toThrow(BaseTreeError);
  });
});

describe("seedKnownFromBase", () => {
  it("keys content the way the runtime reports paths", () => {
    const known = new Map<string, string>();
    const base = { kind: "dir" as const, ref: "d", files: new Map([["src/a.ts", "A"]]) };
    seedKnownFromBase(known, base, "C:\\work\\app");
    expect(known.get("C:\\work\\app\\src\\a.ts")).toBe("A");
  });

  it("uses posix separators when the cwd does", () => {
    const known = new Map<string, string>();
    const base = { kind: "dir" as const, ref: "d", files: new Map([["src/a.ts", "A"]]) };
    seedKnownFromBase(known, base, "/work/app");
    expect(known.get("/work/app/src/a.ts")).toBe("A");
  });

  it("never overwrites content the session itself established", () => {
    const known = new Map([["/work/app/a.ts", "from the session"]]);
    seedKnownFromBase(
      known,
      { kind: "dir", ref: "d", files: new Map([["a.ts", "from the base"]]) },
      "/work/app",
    );
    expect(known.get("/work/app/a.ts")).toBe("from the session");
  });

  it("does nothing without a cwd to resolve against", () => {
    const known = new Map<string, string>();
    seedKnownFromBase(known, { kind: "dir", ref: "d", files: new Map([["a.ts", "A"]]) }, null);
    expect(known.size).toBe(0);
  });
});

describe("the adapter with a base", () => {
  const lines = readFileSync(EDITS, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");

  it("skips an update to a pre-session file without one", () => {
    const res = codexAdapter.convert(lines);
    expect(res.skipped["patch_apply:update(base content not in log)"]).toBe(1);
    const paths = res.drafts
      .filter((d) => d.type === "file.diff")
      .map((d) => String((d.payload as { path: Json }).path));
    expect(paths.some((p) => p.endsWith("existing.py"))).toBe(false);
  });

  it("verifies that same update when the base is supplied", () => {
    const base = { kind: "dir" as const, ref: "d", files: new Map([["existing.py", EXISTING_BEFORE]]) };
    const res = codexAdapter.convert(lines, { base });
    expect(res.skipped["patch_apply:update(base content not in log)"]).toBeUndefined();
    const diff = res.drafts.find(
      (d) => d.type === "file.diff" && String((d.payload as { path: Json }).path).endsWith("existing.py"),
    )!;
    const p = diff.payload as Record<string, Json>;
    // Hashed over real content on both sides — not a guess.
    expect(p.beforeHash).toBe(sha256Hex(EXISTING_BEFORE));
    expect(p.afterHash).toBe(sha256Hex(EXISTING_AFTER));
  });

  it("skips exactly as before when the base is wrong", () => {
    // A wrong base must never yield a hash: the runtime's diff will not apply.
    const base = { kind: "dir" as const, ref: "d", files: new Map([["existing.py", "something else\n"]]) };
    const res = codexAdapter.convert(lines, { base });
    expect(res.skipped["patch_apply:update(diff did not apply)"]).toBeGreaterThanOrEqual(1);
    const paths = res.drafts
      .filter((d) => d.type === "file.diff")
      .map((d) => String((d.payload as { path: Json }).path));
    expect(paths.some((x) => x.endsWith("existing.py"))).toBe(false);
  });

  it("puts nothing in the log for base files the session never touched", () => {
    const base = {
      kind: "dir" as const,
      ref: "d",
      files: new Map([
        ["existing.py", EXISTING_BEFORE],
        ["untouched.py", "print('never edited')\n"],
      ]),
    };
    const res = codexAdapter.convert(lines, { base });
    const paths = res.drafts.map((d) => JSON.stringify(d.payload));
    expect(paths.some((p) => p.includes("untouched.py"))).toBe(false);
  });
});

describe("agit import --base", () => {
  it("verifies the pre-session edit and records the base in meta", () => {
    const dir = baseDir(EXISTING_BEFORE);
    const r = agit(["import", EDITS, "--base", dir, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("update(base content not in log)");

    const meta = JSON.parse(
      readFileSync(
        join(store, ".agit", "sessions", "0199edit-0000-7aaa-8bbb-ccccdddd0001", "meta.json"),
        "utf8",
      ),
    ) as SessionMeta;
    expect(meta.base).toMatchObject({ kind: "dir", ref: dir });
    expect(meta.base!.files).toBeGreaterThan(0);
    expect(meta.base!.cwd).toBe("C:\\work\\app");
  });

  it("show says where the verification came from", () => {
    const dir = baseDir(EXISTING_BEFORE);
    agit(["import", EDITS, "--base", dir, "--dir", store]);
    expect(agit(["show", "0199", "--dir", store]).out).toMatch(/base\s+dir .*files/);
  });

  it("still skips, and says so, when the base does not match", () => {
    const dir = baseDir("wrong content entirely\n");
    const r = agit(["import", EDITS, "--base", dir, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("update(diff did not apply)");
  });

  it("records no base when the flag is absent", () => {
    agit(["import", EDITS, "--dir", store]);
    const meta = JSON.parse(
      readFileSync(
        join(store, ".agit", "sessions", "0199edit-0000-7aaa-8bbb-ccccdddd0001", "meta.json"),
        "utf8",
      ),
    ) as SessionMeta;
    expect(meta.base).toBeUndefined();
  });

  it("refuses an empty base rather than importing as if none was given", () => {
    const empty = join(store, "empty");
    mkdirSync(empty, { recursive: true });
    const r = agit(["import", EDITS, "--base", empty, "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("empty tree");
  });

  it("names an unusable git ref", () => {
    if (!GIT) return;
    const r = agit(["import", EDITS, "--base", "no-such-ref-at-all", "--dir", ROOT]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--base no-such-ref-at-all");
  });
});
