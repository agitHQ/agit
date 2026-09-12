import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIX = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const CLI = join(ROOT, "dist", "cli.js");

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agit-test-export-md-"));
}

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("agit export --markdown", () => {
  it("exports a verified session as GitHub Flavored Markdown", () => {
    const dir = mktemp();
    const imp = agit(["import", FIX, "--dir", dir]);
    expect(imp.code).toBe(0);

    const r = agit(["export", "demo-ratelimit-0001", "--markdown", "--dir", dir]);
    expect(r.code).toBe(0);

    const md = r.out;
    expect(md).toContain("# Session Audit: demo-ratelimit-0001");
    expect(md).toContain("- **Runtime**:");
    expect(md).toContain("- **Head Hash**:");
    expect(md).toContain("## Usage & Models");
    expect(md).toContain("## Trajectory Timeline");
    expect(md).toContain("### User");
    expect(md).toContain("### Assistant");
  });

  it("supports -md alias flag", () => {
    const dir = mktemp();
    expect(agit(["import", FIX, "--dir", dir]).code).toBe(0);
    const r = agit(["export", "demo-ratelimit-0001", "-md", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Session Audit: demo-ratelimit-0001");
  });
});
