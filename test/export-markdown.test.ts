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
  it("exports a verified session as GitHub Flavored Markdown with correct token totals and fenced text", () => {
    const dir = mktemp();
    const imp = agit(["import", FIX, "--dir", dir]);
    expect(imp.code).toBe(0);

    const r = agit(["export", "demo-ratelimit-0001", "--markdown", "--dir", dir]);
    expect(r.code).toBe(0);

    const md = r.out;
    expect(md).toContain("# Session Audit: demo-ratelimit-0001");
    expect(md).toContain("- **Runtime**: claude-code");
    expect(md).toContain("- **Head Hash**:");
    expect(md).toContain("## Usage & Models");
    expect(md).toContain("- **Input Tokens**: 142");
    expect(md).toContain("- **Output Tokens**: 1,055");
    expect(md).toContain("## Files Touched");
    expect(md).toContain("Structured edits only. Files changed by shell commands leave no record (SPEC §5.7)");
    expect(md).toContain("## Trajectory Timeline");
    expect(md).toContain("### User");
    expect(md).toContain("### Assistant");
    // Text blocks must be safely fenced
    expect(md).toContain("```");
  });

  it("supports --md alias flag", () => {
    const dir = mktemp();
    expect(agit(["import", FIX, "--dir", dir]).code).toBe(0);
    const r = agit(["export", "demo-ratelimit-0001", "--md", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Session Audit: demo-ratelimit-0001");
  });
});
