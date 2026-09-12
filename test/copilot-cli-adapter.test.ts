import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copilotCliAdapter } from "../src/adapters/copilot-cli.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIX = join(ROOT, "fixtures", "copilot-cli", "session.jsonl");
const CLI = join(ROOT, "dist", "cli.js");

function linesOf(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agit-test-copilot-"));
}

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("copilotCliAdapter.detect", () => {
  it("recognizes a Copilot CLI session", () => {
    expect(copilotCliAdapter.detect(linesOf(FIX))).toBe(true);
  });

  it("rejects non-json and arbitrary objects", () => {
    expect(copilotCliAdapter.detect(["not json"])).toBe(false);
    expect(copilotCliAdapter.detect(['{"copilot":false}'])).toBe(false);
    expect(copilotCliAdapter.detect([])).toBe(false);
  });
});

describe("copilotCliAdapter.convert", () => {
  it("converts a fixture into expected draft events", () => {
    const lines = linesOf(FIX);
    const res = copilotCliAdapter.convert(lines);

    expect(res.sessionId).toBe("copilot-fixture-0001");
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
    expect(start.payload.runtime).toBe("copilot-cli");
    expect(start.payload.nativeSessionId).toBe("copilot-fixture-0001");

    const userMsg = res.drafts.find((d) => d.type === "message.user")!;
    expect(userMsg.payload.text).toContain("git commits");

    const toolCall = res.drafts.find((d) => d.type === "tool.call")!;
    expect(toolCall.payload.name).toBe("shell");
    expect((toolCall.payload.input as { command: string }).command).toContain("git log");

    const toolResult = res.drafts.find((d) => d.type === "tool.result")!;
    expect(toolResult.payload.output).toContain("chore: initial commit");

    const cost = res.drafts.find((d) => d.type === "cost")!;
    const costUsage = cost.payload.usage as { inputTokens: number; outputTokens: number };
    expect(costUsage.inputTokens).toBe(95);
    expect(costUsage.outputTokens).toBe(35);
  });

  it("omits session.end when live is true", () => {
    const lines = linesOf(FIX);
    const res = copilotCliAdapter.convert(lines, { live: true });
    expect(res.drafts.some((d) => d.type === "session.end")).toBe(false);
  });
});

describe("agit CLI integration on Copilot CLI session", () => {
  it("imports, verifies, and reads session", () => {
    const dir = mktemp();
    const imp = agit(["import", FIX, "--dir", dir]);
    expect(imp.code).toBe(0);
    expect(imp.out).toContain("copilot-fixture-0001");

    const ver = agit(["verify", "copilot-fixture-0001", "--dir", dir]);
    expect(ver.code).toBe(0);

    const show = agit(["show", "copilot-fixture-0001", "--dir", dir]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("copilot-cli");

    const stats = agit(["stats", "--by", "runtime", "--dir", dir]);
    expect(stats.code).toBe(0);
    expect(stats.out).toContain("copilot-cli");
  });
});
