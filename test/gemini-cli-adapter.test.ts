import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { geminiCliAdapter } from "../src/adapters/gemini-cli.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIX = join(ROOT, "fixtures", "gemini-cli", "simple.jsonl");
const CLI = join(ROOT, "dist", "cli.js");

function linesOf(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agit-test-gemini-"));
}

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("geminiCliAdapter.detect", () => {
  it("recognizes a Gemini CLI chat session", () => {
    expect(geminiCliAdapter.detect(linesOf(FIX))).toBe(true);
  });

  it("rejects non-json and arbitrary records", () => {
    expect(geminiCliAdapter.detect(["not json"])).toBe(false);
    expect(geminiCliAdapter.detect(['{"foo":"bar"}'])).toBe(false);
    expect(geminiCliAdapter.detect([])).toBe(false);
  });
});

describe("geminiCliAdapter.convert", () => {
  it("converts a fixture into expected draft events", () => {
    const lines = linesOf(FIX);
    const res = geminiCliAdapter.convert(lines);

    expect(res.sessionId).toBe("gemini-fixture-0001");
    expect(res.records).toBe(lines.length);

    const types = res.drafts.map((d) => d.type);
    expect(types).toContain("session.start");
    expect(types).toContain("message.user");
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("cost");
    expect(types).toContain("message.assistant");
    expect(types).toContain("session.end");

    const start = res.drafts.find((d) => d.type === "session.start")!;
    expect(start.payload.runtime).toBe("gemini-cli");
    expect(start.payload.nativeSessionId).toBe("gemini-fixture-0001");

    const userMsg = res.drafts.find((d) => d.type === "message.user")!;
    expect(userMsg.payload.text).toContain("check the current directory");

    const toolCall = res.drafts.find((d) => d.type === "tool.call")!;
    expect(toolCall.payload.name).toBe("run_shell");
    expect(toolCall.payload.toolUseId).toBe("call_1");

    const toolResult = res.drafts.find((d) => d.type === "tool.result")!;
    expect(toolResult.payload.toolUseId).toBe("call_1");
    expect(toolResult.payload.output).toContain("index.ts");

    const assistant = res.drafts.find((d) => d.type === "message.assistant")!;
    const blocks = assistant.payload.blocks as Array<{ type: string; text: string }>;
    expect(blocks.some((b) => b.type === "thinking")).toBe(true);
    expect(blocks.some((b) => b.type === "text")).toBe(true);

    const cost = res.drafts.find((d) => d.type === "cost")!;
    const u = cost.payload.usage as { inputTokens: number; outputTokens: number };
    expect(u.inputTokens).toBeGreaterThan(0);
    expect(u.outputTokens).toBeGreaterThan(0);
  });

  it("supports live conversion omitting session.end", () => {
    const lines = linesOf(FIX);
    const res = geminiCliAdapter.convert(lines, { live: true });
    expect(res.drafts.some((d) => d.type === "session.end")).toBe(false);
  });
});

describe("agit CLI integration on Gemini CLI session", () => {
  it("imports, verifies, and reads session", () => {
    const dir = mktemp();
    const imp = agit(["import", FIX, "--dir", dir]);
    expect(imp.code).toBe(0);
    expect(imp.out).toContain("gemini-fixture-0001");

    const ver = agit(["verify", "gemini-fixture-0001", "--dir", dir]);
    expect(ver.code).toBe(0);

    const show = agit(["show", "gemini-fixture-0001", "--dir", dir]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("gemini-cli");

    const stats = agit(["stats", "--by", "runtime", "--dir", dir]);
    expect(stats.code).toBe(0);
    expect(stats.out).toContain("gemini-cli");
  });
});
