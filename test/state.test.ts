import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain } from "../src/format/hash.js";
import type { DraftEvent } from "../src/format/events.js";
import { clipLine, excerpt, fileStateAt, timelineLines, usageByModel, usageTotals } from "../src/state.js";

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
const res = claudeCodeAdapter.convert(lines);
const events = buildChain(res.sessionId, res.drafts);

describe("replay state folds", () => {
  it("file state is cumulative and time-travels", () => {
    // Event 7 is the create diff, 11 the modify diff (see adapter.test.ts).
    expect(fileStateAt(events, 6).size).toBe(0);
    const afterCreate = fileStateAt(events, 7).get("C:\\proj\\hello.ts")!;
    expect(afterCreate.kind).toBe("create");
    expect(afterCreate.edits).toBe(1);

    const atEnd = fileStateAt(events).get("C:\\proj\\hello.ts")!;
    expect(atEnd.kind).toBe("create"); // created within this session, then modified
    expect(atEnd.edits).toBe(2);
    expect(atEnd.lastSeq).toBe(11);
    expect(atEnd.added).toBeGreaterThan(0);
    expect(atEnd.removed).toBeGreaterThan(0);
  });

  it("flags divergence when a beforeHash contradicts the last known content", () => {
    const diff = (ts: string, beforeHash: string | null, afterHash: string): DraftEvent => ({
      ts,
      type: "file.diff",
      payload: {
        path: "C:\\p\\a.ts",
        kind: beforeHash === null ? "create" : "modify",
        diff: "",
        beforeHash,
        afterHash,
        toolUseId: "t",
        source: "Edit",
      },
    });
    // create -> consistent edit -> edit whose before contradicts the last after
    const evs = buildChain("s", [
      diff("2026-01-01T00:00:00.000Z", null, "h1"),
      diff("2026-01-01T00:00:01.000Z", "h1", "h2"),
      diff("2026-01-01T00:00:02.000Z", "hX", "h3"),
    ]);
    const clean = fileStateAt(evs, 1).get("C:\\p\\a.ts")!;
    expect(clean.divergedAtSeq).toBeUndefined();
    const state = fileStateAt(evs).get("C:\\p\\a.ts")!;
    expect(state.divergedAtSeq).toBe(2); // proof: something changed a.ts between seq 1 and 2
    expect(state.afterHash).toBe("h3");
  });

  it("timeline shows date separators only when a session spans days", () => {
    const singleDay = timelineLines(events);
    expect(singleDay.some((l) => l.includes("──────"))).toBe(false);
    expect(singleDay).toHaveLength(events.length);

    const twoDays = buildChain("s", [
      { ts: "2026-01-01T23:59:00.000Z", type: "message.user", payload: { text: "late" } },
      { ts: "2026-01-02T00:03:00.000Z", type: "message.user", payload: { text: "past midnight" } },
      { ts: "2026-01-02T09:00:00.000Z", type: "message.user", payload: { text: "morning" } },
    ]);
    const lines2 = timelineLines(twoDays);
    expect(lines2).toHaveLength(5); // 3 rows + 2 separators
    expect(lines2[0]).toContain("2026-01-01");
    expect(lines2[2]).toContain("2026-01-02");
    expect(lines2.filter((l) => l.includes("──────"))).toHaveLength(2);
  });

  it("usage totals accumulate and respect the cutoff", () => {
    const all = usageTotals(events);
    expect(all.apiMessages).toBe(4);
    expect(all.inputTokens).toBe(10 + 1 + 7 + 5);
    expect(all.outputTokens).toBe(20 + 2 + 8 + 6);
    expect([...all.models]).toEqual(["claude-opus-5"]);

    const early = usageTotals(events, 5); // only msg_A's cost has landed
    expect(early.apiMessages).toBe(1);
    expect(early.inputTokens).toBe(10);
  });
});

describe("clipLine", () => {
  it("keeps the indentation that excerpt destroys", () => {
    const diffLine = "+    if (tokens <= 0) return false;";
    expect(clipLine(diffLine, 160)).toBe(diffLine);
    // The contrast, spelled out: excerpt is for one-line timeline summaries.
    expect(excerpt(diffLine, 160)).toBe("+ if (tokens <= 0) return false;");
  });

  it("keeps pretty-printed JSON readable", () => {
    const json = JSON.stringify({ file_path: "a.ts", edits: [{ old: "x" }] }, null, 2);
    const rendered = json.split("\n").map((l) => clipLine(l, 160));
    expect(rendered.join("\n")).toBe(json);
    expect(rendered.some((l) => l.startsWith("  "))).toBe(true);
  });

  it("clips over-long lines with an ellipsis", () => {
    expect(clipLine("abcdef", 6)).toBe("abcdef");
    expect(clipLine("abcdef", 5)).toBe("abcd\u2026");
    expect(clipLine("abcdef", 5)).toHaveLength(5);
  });

  it("drops a trailing CR so CRLF logs do not render as two lines", () => {
    expect(clipLine("const a = 1;\r", 160)).toBe("const a = 1;");
  });

  it("leaves every indented line of a real fixture diff untouched", () => {
    const diffs = events.filter((e) => e.type === "file.diff");
    expect(diffs.length).toBeGreaterThan(0);
    const diff = (diffs[0]!.payload as { diff: string }).diff;
    const indented = diff.split("\n").filter((l) => /^[+\- ]\s/.test(l));
    expect(indented.length).toBeGreaterThan(0);
    for (const l of indented) expect(clipLine(l, 160)).toBe(l);
  });
});

describe("usageByModel", () => {
  const diff = (ts: string, path: string): DraftEvent => ({
    ts,
    type: "file.diff",
    payload: { path, kind: "create", diff: "", beforeHash: null, afterHash: "h", toolUseId: "t" },
  });
  const cost = (ts: string, model: string, out: number): DraftEvent => ({
    ts,
    type: "cost",
    payload: {
      model,
      usage: { inputTokens: 1, outputTokens: out, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 },
    },
  });
  const assistant = (ts: string, model: string): DraftEvent => ({
    ts,
    type: "message.assistant",
    payload: { model, blocks: [{ type: "text", text: "hi" }], stopReason: null },
  });

  it("splits tokens by the model each cost event names", () => {
    const events = buildChain("s", [
      cost("2026-01-01T00:00:00.000Z", "opus", 10),
      cost("2026-01-01T00:00:01.000Z", "haiku", 5),
      cost("2026-01-01T00:00:02.000Z", "opus", 7),
    ]);
    const rows = usageByModel(events);
    expect(rows.map((r) => r.model)).toEqual(["opus", "haiku"]); // busiest first
    expect(rows[0]!.outputTokens).toBe(17);
    expect(rows[0]!.apiMessages).toBe(2);
    expect(rows[1]!.outputTokens).toBe(5);
  });

  it("credits a file edit to the model named by the nearest preceding event", () => {
    const events = buildChain("s", [
      assistant("2026-01-01T00:00:00.000Z", "opus"),
      diff("2026-01-01T00:00:01.000Z", "a.ts"),
      cost("2026-01-01T00:00:02.000Z", "opus", 1),
      assistant("2026-01-01T00:00:03.000Z", "haiku"),
      diff("2026-01-01T00:00:04.000Z", "b.ts"),
      diff("2026-01-01T00:00:05.000Z", "c.ts"),
      cost("2026-01-01T00:00:06.000Z", "haiku", 1),
    ]);
    const byModel = Object.fromEntries(usageByModel(events).map((r) => [r.model, [...r.files].sort()]));
    expect(byModel["opus"]).toEqual(["a.ts"]);
    expect(byModel["haiku"]).toEqual(["b.ts", "c.ts"]);
  });

  it("counts a file touched twice by one model once", () => {
    const events = buildChain("s", [
      assistant("2026-01-01T00:00:00.000Z", "opus"),
      diff("2026-01-01T00:00:01.000Z", "a.ts"),
      diff("2026-01-01T00:00:02.000Z", "a.ts"),
      cost("2026-01-01T00:00:03.000Z", "opus", 1),
    ]);
    expect(usageByModel(events)[0]!.files.size).toBe(1);
  });

  it("says (unattributed) rather than guessing when no model precedes an edit", () => {
    const events = buildChain("s", [
      diff("2026-01-01T00:00:00.000Z", "orphan.ts"),
      assistant("2026-01-01T00:00:01.000Z", "opus"),
      cost("2026-01-01T00:00:02.000Z", "opus", 1),
    ]);
    const rows = usageByModel(events);
    const orphan = rows.find((r) => r.model === "(unattributed)")!;
    expect([...orphan.files]).toEqual(["orphan.ts"]);
    expect(orphan.apiMessages).toBe(0);
  });

  it("respects the --at cutoff, like the other folds", () => {
    const events = buildChain("s", [
      cost("2026-01-01T00:00:00.000Z", "opus", 10),
      cost("2026-01-01T00:00:01.000Z", "haiku", 5),
    ]);
    expect(usageByModel(events, 0).map((r) => r.model)).toEqual(["opus"]);
  });

  it("totals across models match usageTotals", () => {
    const events = buildChain("s", [
      cost("2026-01-01T00:00:00.000Z", "opus", 10),
      cost("2026-01-01T00:00:01.000Z", "haiku", 5),
    ]);
    const rows = usageByModel(events);
    const t = usageTotals(events);
    expect(rows.reduce((n, r) => n + r.outputTokens, 0)).toBe(t.outputTokens);
    expect(rows.reduce((n, r) => n + r.apiMessages, 0)).toBe(t.apiMessages);
  });
});
