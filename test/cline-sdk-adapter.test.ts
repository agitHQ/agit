import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atifAdapter } from "../src/adapters/atif.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { clineSdkAdapter, CLINE_MESSAGES_VERSION } from "../src/adapters/cline-sdk.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIX = join(ROOT, "fixtures", "cline-sdk", "simple.messages.json");
const ATIF = join(ROOT, "fixtures", "atif", "simple.json");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const linesOf = (p: string): string[] => readFileSync(p, "utf8").split("\n");
const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-cline-"));

/** A minimal valid document, with overrides, for the edge cases. */
function doc(overrides: Record<string, unknown> = {}, messages?: unknown[]): string[] {
  return [
    JSON.stringify({
      version: 1,
      sessionId: "s-1",
      messages: messages ?? [
        { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
        {
          id: "a1",
          role: "assistant",
          ts: 1777713262000,
          modelInfo: { id: "m" },
          content: [{ type: "text", text: "hello" }],
        },
      ],
      ...overrides,
    }),
  ];
}

describe("detection (#63)", () => {
  it("recognizes a Cline SDK messages file", () => {
    expect(clineSdkAdapter.detect(linesOf(FIX))).toBe(true);
  });

  it("does not claim the other formats, and they do not claim it", () => {
    // Adapters are tried in order; an over-eager detect steals another
    // format's file. ATIF is the nearest neighbour, being a single JSON
    // document too, so it matters most that the two stay apart.
    for (const other of [DEMO, CODEX, ATIF])
      expect(clineSdkAdapter.detect(linesOf(other)), other).toBe(false);
    for (const a of [claudeCodeAdapter, codexAdapter, openclawAdapter, atifAdapter]) {
      expect(a.detect(linesOf(FIX)), a.name).toBe(false);
    }
  });

  it("declines documents that only look similar", () => {
    expect(clineSdkAdapter.detect(['{"version":1,"messages":[]}'])).toBe(false); // no sessionId
    expect(clineSdkAdapter.detect(['{"version":"1","sessionId":"s","messages":[]}'])).toBe(false); // string version
    expect(clineSdkAdapter.detect(['{"version":1,"sessionId":"s","messages":[{"role":"user"}]}'])).toBe(
      false,
    ); // no content
    expect(clineSdkAdapter.detect(["not json"])).toBe(false);
  });
});

describe("the mapping", () => {
  const r = clineSdkAdapter.convert(linesOf(FIX));
  const byType = (t: string): typeof r.drafts => r.drafts.filter((d) => d.type === t);

  it("keeps the session id and names the runtime", () => {
    expect(r.sessionId).toBe("cline-fixture-0001");
    const p = r.drafts[0]!.payload as Record<string, unknown>;
    expect(r.drafts[0]!.type).toBe("session.start");
    expect(p.runtime).toBe("cline");
    // The contract records the model, not the Cline version; nothing invented.
    expect(p.runtimeVersion).toBeNull();
    expect(p.cwd).toBeNull();
    expect((p.native as Record<string, unknown>).agent).toBe("lead");
  });

  it("converts epoch-millisecond timestamps to ISO", () => {
    for (const d of r.drafts) expect(d.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(byType("cost")[0]!.ts).toBe("2026-05-02T09:14:50.000Z");
  });

  it("maps text and thinking blocks, keeping thinking as a thinking block", () => {
    const assistants = byType("message.assistant");
    const first = assistants[0]!.payload as { blocks: { type: string; text: string }[]; model: string };
    expect(first.blocks).toEqual([{ type: "thinking", text: "Read the fetch module before touching it." }]);
    expect(first.model).toBe("some-model-v1");
    expect(byType("message.user")).toHaveLength(1);
  });

  it("emits one tool.call per tool_use and one tool.result per tool_result, matched by id", () => {
    const calls = byType("tool.call").map((d) => d.payload as { toolUseId: string; name: string });
    const results = byType("tool.result").map((d) => d.payload as { toolUseId: string; isError: boolean });
    expect(calls.map((c) => c.name)).toEqual(["read_files", "editor", "run_commands"]);
    for (const c of calls) expect(results.some((x) => x.toolUseId === c.toolUseId)).toBe(true);
    expect(results.find((x) => x.toolUseId === "call_3")!.isError).toBe(true);
  });

  it("flattens a structured tool_result content array to text", () => {
    const r3 = byType("tool.result").find(
      (d) => (d.payload as { toolUseId: string }).toolUseId === "call_3",
    )!;
    expect((r3.payload as { output: string }).output).toBe("1 failing");
  });

  it("maps metrics onto a cost event with the contract's field names", () => {
    const u = (byType("cost")[0]!.payload as { usage: Record<string, number> }).usage;
    expect(u.inputTokens).toBe(1200);
    expect(u.outputTokens).toBe(340);
    expect(u.cacheReadInputTokens).toBe(900);
    expect(u.cacheCreationInputTokens).toBe(40);
  });
});

describe("what it declines, and says it declined", () => {
  const r = clineSdkAdapter.convert(linesOf(FIX));

  it("emits no file.diff, because new-file content depends on an OS the log does not record", () => {
    // The editor's create path converts LF to CRLF only when Cline ran on
    // Windows, and the file does not say where it ran. A hash over new_text
    // would be right on one platform and wrong on another.
    expect(r.drafts.some((d) => d.type === "file.diff" || d.type === "file.delete")).toBe(false);
    expect(r.skipped["file-edit-unverifiable"]).toBe(1);
  });

  it("counts the system prompt rather than filing it as a user message", () => {
    expect(r.skipped["system-prompt"]).toBe(1);
    for (const d of r.drafts) {
      expect((d.payload as { text?: string }).text ?? "").not.toContain("careful coding agent");
    }
  });

  it("counts a content block it does not know, per the contract's tolerate-unknown rule", () => {
    // Tolerated means counted, not silently dropped.
    expect(r.skipped["unknown-block:image"]).toBe(1);
  });

  it("says how many messages inherited a timestamp", () => {
    // The golden fixture omits ts on user messages; ours does the same.
    expect(r.skipped["message-timestamp-inherited"]).toBe(3);
  });

  it("refuses a contract version it does not read, rather than guessing at what broke", () => {
    expect(() => clineSdkAdapter.convert(doc({ version: 2 }))).toThrow(/version 2/);
    expect(CLINE_MESSAGES_VERSION).toBe(1);
  });

  it("refuses a file with no timestamps anywhere", () => {
    const none = doc({}, [
      { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(() => clineSdkAdapter.convert(none)).toThrow(/no timestamps/);
  });

  it("refuses an empty session", () => {
    expect(() => clineSdkAdapter.convert(doc({}, []))).toThrow(/no messages/);
  });

  it("counts a role it does not know", () => {
    const odd = doc({}, [
      { id: "x", role: "system", ts: 1777713262000, content: [{ type: "text", text: "..." }] },
      { id: "a1", role: "assistant", ts: 1777713263000, content: [{ type: "text", text: "hello" }] },
    ]);
    expect(clineSdkAdapter.convert(odd).skipped["unknown-role:system"]).toBe(1);
  });

  it("survives wrong-typed fields without dropping the import", () => {
    const rough = doc({}, [
      {
        id: "a1",
        role: "assistant",
        ts: 1777713262000,
        modelInfo: "not-an-object",
        metrics: "not-an-object",
        content: [
          { type: "tool_use", id: "c", name: "editor", input: "not-an-object" },
          { type: "text", text: 42 },
        ],
      },
    ]);
    const r2 = clineSdkAdapter.convert(rough);
    expect(r2.drafts[0]!.type).toBe("session.start");
    const call = r2.drafts.find((d) => d.type === "tool.call")!;
    expect((call.payload as { input: unknown }).input).toEqual({});
  });
});

describe("agit import on a Cline SDK session", () => {
  it("imports, verifies, and names what it skipped", () => {
    const dir = mktemp();
    const r = agit(["import", FIX, "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("cline-sdk@");
    expect(r.out).toContain("file-edit-unverifiable");
    expect(r.out).toContain("system-prompt");
    expect(agit(["verify", "cline", "--dir", dir]).code).toBe(0);
  });

  it("is deterministic", () => {
    const a = mktemp();
    const b = mktemp();
    expect(agit(["import", FIX, "--dir", a]).code).toBe(0);
    expect(agit(["import", FIX, "--dir", b]).code).toBe(0);
    const log = (d: string): string =>
      readFileSync(join(d, ".agit", "sessions", "cline-fixture-0001", "events.jsonl"), "utf8");
    expect(log(a)).toBe(log(b));
  });

  it("leaves the read verbs working and stats attributing to the runtime", () => {
    const dir = mktemp();
    expect(agit(["import", FIX, "--dir", dir]).code).toBe(0);
    expect(agit(["show", "cline", "--dir", dir]).code).toBe(0);
    expect(agit(["grep", "retry", "--dir", dir]).code).toBe(0);
    const stats = agit(["stats", "--by", "runtime", "--dir", dir]);
    expect(stats.out).toContain("cline");
    expect(stats.out).toContain("1,200");
    // No file events means blame has nothing, and says so rather than
    // answering with an empty attribution that reads as "nothing was written".
    expect(agit(["blame", "/work/app/src/retry.ts", "--dir", dir]).code).not.toBe(0);
  });

  it("exports to ATIF and OpenTelemetry like any other session", () => {
    // The point of a common event log: a session from a runtime agit only
    // met today gets every view the others have.
    const dir = mktemp();
    expect(agit(["import", FIX, "--dir", dir]).code).toBe(0);
    const atif = agit(["export", "cline", "--atif", "--dir", dir]);
    expect(atif.code).toBe(0);
    expect((JSON.parse(atif.out) as { agent: { name: string } }).agent.name).toBe("cline");
    const otel = agit(["export", "cline", "--otel", "--dir", dir]);
    expect(otel.code).toBe(0);
    expect(otel.out).toContain("invoke_agent cline");
  });
});
