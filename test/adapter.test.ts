import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { verifyChain } from "../src/format/verify.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";
import type { Json } from "../src/format/events.js";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "fixtures",
  "claude-code",
  "simple.jsonl",
);
const lines = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const BEFORE = "export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n";
const AFTER = "export function hello(name: string): string {\n  return `Hello, ${name}!!`;\n}\n";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function payloadOf(drafts: { type: string; payload: unknown }[], i: number): Record<string, Json> {
  return drafts[i]!.payload as Record<string, Json>;
}

describe("claude-code adapter", () => {
  it("detects the native format", () => {
    expect(claudeCodeAdapter.detect(lines)).toBe(true);
    expect(claudeCodeAdapter.detect(['{"foo": 1}'])).toBe(false);
    expect(claudeCodeAdapter.detect(["not json"])).toBe(false);
  });

  it("finds a native record past a leading record it cannot map", () => {
    // `convert` skips-and-counts these; `detect` used to reject the file over
    // the first one, so agit reported "no adapter recognizes this file" for
    // logs it converts perfectly.
    const real = lines[0]!;
    for (const lead of [
      '{"type":"summary","summary":"Earlier work","leafUuid":"u0"}',
      '{"type":"file-history-snapshot","messageId":"m0"}',
      '{"half":"written',
      "null",
      "[]",
      '"a string"',
    ]) {
      expect(claudeCodeAdapter.detect([lead, real])).toBe(true);
    }
  });

  it("converts what it now detects", () => {
    const withLead = ['{"type":"summary","summary":"Earlier work","leafUuid":"u0"}', ...lines];
    expect(claudeCodeAdapter.detect(withLead)).toBe(true);
    const res = claudeCodeAdapter.convert(withLead);
    expect(res.sessionId).toBe("fixture-simple-0001");
    expect(res.skipped.summary).toBe(1);
  });

  it("still refuses a file with no native record in reach", () => {
    expect(claudeCodeAdapter.detect(Array.from({ length: 40 }, () => '{"foo":1}'))).toBe(false);
    // A native record beyond the 25-record window is out of scope, by design.
    const far = [...Array.from({ length: 30 }, () => '{"foo":1}'), lines[0]!];
    expect(claudeCodeAdapter.detect(far)).toBe(false);
  });

  it("skip-counts non-object JSON lines instead of crashing", () => {
    const res = claudeCodeAdapter.convert([lines[0]!, "null", "123", ...lines.slice(1)]);
    expect(res.skipped["<non-object>"]).toBe(2);
    expect(res.drafts.length).toBeGreaterThan(0);
  });

  it("maps the fixture to the expected event sequence", () => {
    const res = claudeCodeAdapter.convert(lines);
    expect(res.sessionId).toBe("fixture-simple-0001");
    expect(res.records).toBe(12);
    expect(res.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant", // thinking
      "message.assistant", // text
      "tool.call", // Write
      "cost", // msg_A, deduped across three records
      "tool.result",
      "file.diff", // create
      "tool.call", // Edit
      "cost", // msg_B
      "tool.result",
      "file.diff", // modify
      "tool.call", // Bash
      "cost", // msg_C
      "tool.result",
      "message.assistant", // Done.
      "cost", // msg_D, flushed at EOF
      "session.end",
    ]);
  });

  it("skips and counts what it cannot map — never guesses", () => {
    const res = claudeCodeAdapter.convert(lines);
    expect(res.skipped).toEqual({ "queue-operation": 1, "ai-title": 1 });
  });

  it("session.start carries runtime facts; session.end says it is synthesized", () => {
    const res = claudeCodeAdapter.convert(lines);
    expect(payloadOf(res.drafts, 0)).toMatchObject({
      runtime: "claude-code",
      runtimeVersion: "2.1.260",
      nativeSessionId: "fixture-simple-0001",
      cwd: "C:\\proj",
      gitBranch: "main",
    });
    expect(res.drafts[0]!.ts).toBe("2026-09-06T10:00:01.000Z");
    const end = res.drafts[res.drafts.length - 1]!;
    expect(end.payload).toEqual({ reason: "log-end", synthesized: true });
    expect(end.ts).toBe("2026-09-06T10:00:10.000Z");
  });

  it("drops thinking signatures but keeps thinking text (SPEC §5.4)", () => {
    const res = claudeCodeAdapter.convert(lines);
    const thinking = payloadOf(res.drafts, 2);
    expect(thinking.blocks).toEqual([{ type: "thinking", text: "Plan the module." }]);
    expect(JSON.stringify(thinking)).not.toContain("SIGBLOB");
  });

  it("deduplicates cost by native message id and keeps tokens verbatim", () => {
    const res = claudeCodeAdapter.convert(lines);
    const costs = res.drafts.filter((d) => d.type === "cost").map((d) => d.payload as Record<string, Json>);
    expect(costs).toHaveLength(4);
    expect(costs[0]).toEqual({
      model: "claude-opus-5",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 5 },
      native: { messageId: "msg_A", requestId: "req_A" },
    });
  });

  it("derives file.diff with correct before/after hashes for create and modify", () => {
    const res = claudeCodeAdapter.convert(lines);
    const diffs = res.drafts
      .filter((d) => d.type === "file.diff")
      .map((d) => d.payload as Record<string, Json>);
    expect(diffs).toHaveLength(2);

    const create = diffs[0]!;
    expect(create.kind).toBe("create");
    expect(create.path).toBe("C:\\proj\\hello.ts");
    expect(create.beforeHash).toBeNull();
    expect(create.afterHash).toBe(sha(BEFORE));
    expect(create.source).toBe("Write");
    expect(create.diff).toContain("--- /dev/null");
    expect(create.diff).toContain("+export function hello(name: string): string {");

    const modify = diffs[1]!;
    expect(modify.kind).toBe("modify");
    expect(modify.beforeHash).toBe(sha(BEFORE));
    expect(modify.afterHash).toBe(sha(AFTER));
    expect(modify.source).toBe("Edit");
    expect(modify.diff).toContain("@@ -1,3 +1,3 @@");
    expect(modify.diff).toContain("-  return `Hello, ${name}!`;");
    expect(modify.diff).toContain("+  return `Hello, ${name}!!`;");
  });

  it("full import pipeline: redacts the leaked key, chains, verifies, and is deterministic", () => {
    const importOnce = () => {
      const res = claudeCodeAdapter.convert(lines);
      const counts: RedactionCounts = {};
      for (const d of res.drafts) d.payload = redactDeep(d.payload, counts);
      return { jsonl: toJsonl(buildChain(res.sessionId, res.drafts)), counts };
    };
    const a = importOnce();
    const b = importOnce();

    expect(a.jsonl).toBe(b.jsonl); // SPEC §7: byte-identical re-imports
    expect(a.jsonl).not.toContain("sk-ant-api03");
    expect(a.jsonl).toContain("[REDACTED:anthropic-key]");
    expect(a.counts["anthropic-key"]).toBe(2); // tool_result text + structured stdout

    const verify = verifyChain(a.jsonl.trimEnd().split("\n"));
    expect(verify.ok).toBe(true);
    expect(verify.events).toBe(18);
  });
});
