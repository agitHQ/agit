import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIX = join(ROOT, "fixtures", "opencode", "session.jsonl");
const CLI = join(ROOT, "dist", "cli.js");

function linesOf(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agit-test-opencode-"));
}

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("opencodeAdapter.detect", () => {
  it("recognizes an OpenCode session", () => {
    expect(opencodeAdapter.detect(linesOf(FIX))).toBe(true);
  });

  it("rejects non-json and arbitrary objects", () => {
    expect(opencodeAdapter.detect(["not json"])).toBe(false);
    expect(opencodeAdapter.detect(['{"opencode":false}'])).toBe(false);
    expect(opencodeAdapter.detect([])).toBe(false);
  });
});

describe("opencodeAdapter.convert", () => {
  it("converts a fixture into expected draft events", () => {
    const lines = linesOf(FIX);
    const res = opencodeAdapter.convert(lines);

    expect(res.sessionId).toBe("opencode-fixture-0001");
    expect(res.records).toBe(lines.length);

    const types = res.drafts.map((d) => d.type);
    expect(types).toContain("session.start");
    expect(types).toContain("message.user");
    expect(types).toContain("message.assistant");
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("cost");
    expect(types).toContain("session.end");

    const start = res.drafts.find((d) => d.type === "session.start")!;
    expect(start.payload.runtime).toBe("opencode");
    expect(start.payload.nativeSessionId).toBe("opencode-fixture-0001");

    const userMsg = res.drafts.find((d) => d.type === "message.user")!;
    expect(userMsg.payload.text).toContain("parser module");

    const toolCall = res.drafts.find((d) => d.type === "tool.call")!;
    expect(toolCall.payload.name).toBe("readFile");

    const toolResult = res.drafts.find((d) => d.type === "tool.result")!;
    expect(toolResult.payload.output).toContain("vitest");

    const cost = res.drafts.find((d) => d.type === "cost")!;
    const costUsage = cost.payload.usage as { inputTokens: number; outputTokens: number };
    expect(costUsage.inputTokens).toBe(110);
    expect(costUsage.outputTokens).toBe(45);
  });

  it("omits session.end when live is true", () => {
    const lines = linesOf(FIX);
    const res = opencodeAdapter.convert(lines, { live: true });
    expect(res.drafts.some((d) => d.type === "session.end")).toBe(false);
  });
});

describe("agit CLI integration on OpenCode session", () => {
  it("imports, verifies, and reads session", () => {
    const dir = mktemp();
    const imp = agit(["import", FIX, "--dir", dir]);
    expect(imp.code).toBe(0);
    expect(imp.out).toContain("opencode-fixture-0001");

    const ver = agit(["verify", "opencode-fixture-0001", "--dir", dir]);
    expect(ver.code).toBe(0);

    const show = agit(["show", "opencode-fixture-0001", "--dir", dir]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("opencode");

    const stats = agit(["stats", "--by", "runtime", "--dir", dir]);
    expect(stats.code).toBe(0);
    expect(stats.out).toContain("opencode");
  });
});
