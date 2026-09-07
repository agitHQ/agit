import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { canonicalJson } from "../src/format/canonical.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { verifyChain } from "../src/format/verify.js";
import type { DraftEvent, Json } from "../src/format/events.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const codexLines = readFileSync(join(ROOT, "fixtures", "codex", "simple.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const claudeLines = readFileSync(join(ROOT, "fixtures", "claude-code", "simple.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const payloadOf = (drafts: DraftEvent[], i: number): { [k: string]: Json } =>
  drafts[i]!.payload as { [k: string]: Json };

describe("codex adapter", () => {
  it("detects codex rollouts, and the two adapters never claim each other's files", () => {
    expect(codexAdapter.detect(codexLines)).toBe(true);
    expect(codexAdapter.detect(claudeLines)).toBe(false);
    expect(claudeCodeAdapter.detect(codexLines)).toBe(false);
    expect(codexAdapter.detect(["not json", "{}"])).toBe(false);
  });

  it("maps the fixture to the expected event sequence", () => {
    const res = codexAdapter.convert(codexLines);
    expect(res.sessionId).toBe("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001");
    expect(res.records).toBe(17);
    expect(res.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "tool.call", // exec (custom_tool_call)
      "tool.result",
      "cost",
      "message.assistant", // reasoning summary -> thinking block
      "tool.call", // shell (function_call)
      "tool.result",
      "cost",
      "message.assistant", // the canonical assistant message
      "session.end",
    ]);
  });

  it("skips scaffolding and duplicates, and counts every one", () => {
    const res = codexAdapter.convert(codexLines);
    expect(res.skipped).toEqual({
      "response_item:message(developer)": 1,
      "response_item:message(user)": 1,
      turn_context: 1,
      "event_msg:task_started": 1,
      "response_item:reasoning(encrypted)": 1,
      "event_msg:agent_message": 1,
      "event_msg:task_complete": 1,
    });
    // The duplicated assistant text appears exactly once in the events.
    const texts = JSON.stringify(res.drafts);
    expect(texts.split("suite is green").length - 1).toBe(1);
  });

  it("bills costs to the turn_context model and uses per-response deltas", () => {
    const res = codexAdapter.convert(codexLines);
    const costs = res.drafts.filter((d) => d.type === "cost").map((d) => d.payload as { [k: string]: Json });
    expect(costs).toHaveLength(2);
    expect(costs[0]!.model).toBe("gpt-5.5");
    expect(costs[1]!.usage).toEqual({
      inputTokens: 1200, // last_token_usage, not the cumulative total
      outputTokens: 55,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });
  });

  it("parses function_call arguments and wraps custom_tool_call input", () => {
    const res = codexAdapter.convert(codexLines);
    const calls = res.drafts
      .filter((d) => d.type === "tool.call")
      .map((d) => d.payload as { [k: string]: Json });
    expect(calls[0]!.name).toBe("exec");
    expect(calls[0]!.input).toEqual({ input: "grep -rn discount src/ | head -5\n" });
    expect(calls[1]!.name).toBe("shell");
    expect(calls[1]!.input).toEqual({ command: ["npx", "vitest", "run"], timeout_ms: 120000 });
    // Results pair by call_id and handle both output shapes (array and string).
    const results = res.drafts
      .filter((d) => d.type === "tool.result")
      .map((d) => d.payload as { [k: string]: Json });
    expect(results[0]!.toolUseId).toBe("call_alpha001");
    expect(results[0]!.output).toContain("discunt(total: number)");
    expect(results[1]!.output).toBe("Exit code: 0\nTests 3 passed (3)");
  });

  it("keeps a reasoning summary as a thinking block and drops encrypted-only reasoning", () => {
    const res = codexAdapter.convert(codexLines);
    const thinking = res.drafts.filter(
      (d) => d.type === "message.assistant" && JSON.stringify(d.payload).includes('"thinking"'),
    );
    expect(thinking).toHaveLength(1);
    expect(JSON.stringify(thinking[0]!.payload)).toContain("misspelled");
    expect(JSON.stringify(res.drafts)).not.toContain("gAAAAAB");
  });

  it("is deterministic and chains into a verifiable log", () => {
    const a = codexAdapter.convert(codexLines);
    const b = codexAdapter.convert(codexLines);
    const jsonlA = toJsonl(buildChain(a.sessionId, a.drafts));
    expect(jsonlA).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    expect(verifyChain(jsonlA.trimEnd().split("\n")).ok).toBe(true);
  });

  it("live mode is prefix-stable: every longer read strictly extends every shorter one", () => {
    const liveDrafts = (k: number): string[] => {
      try {
        return codexAdapter
          .convert(codexLines.slice(0, k), { live: true })
          .drafts.map((d) => canonicalJson(d));
      } catch {
        return []; // no session_meta yet
      }
    };
    let prev: string[] = [];
    for (let k = 1; k <= codexLines.length; k++) {
      const now = liveDrafts(k);
      expect(now.length).toBeGreaterThanOrEqual(prev.length);
      expect(now.slice(0, prev.length)).toEqual(prev);
      prev = now;
    }
    const live = codexAdapter.convert(codexLines, { live: true }).drafts;
    const full = codexAdapter.convert(codexLines).drafts;
    expect(full.length).toBe(live.length + 1); // only the synthesized session.end
    expect(payloadOf(full, full.length - 1).reason).toBe("log-end");
  });

  it("refuses a file with no session_meta", () => {
    expect(() => codexAdapter.convert(codexLines.slice(1))).toThrow(/session_meta/);
  });

  it("session.start carries provenance", () => {
    const res = codexAdapter.convert(codexLines);
    expect(payloadOf(res.drafts, 0)).toMatchObject({
      runtime: "codex",
      runtimeVersion: "0.142.0",
      nativeSessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
      cwd: "C:\\work\\shop",
    });
  });
});
