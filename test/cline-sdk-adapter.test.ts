import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atifAdapter } from "../src/adapters/atif.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { clineSdkAdapter, CLINE_MESSAGES_VERSION } from "../src/adapters/cline-sdk.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import { canonicalJson } from "../src/format/canonical.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";
import { SessionFollower } from "../src/share.js";

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

  it("survives wrong-typed fields without dropping the import, and names what they cost", () => {
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
    // Surviving is not the same as being lossless: the call's input and the
    // text block both went missing, and the report has to say so.
    expect(r2.skipped["malformed-block:tool_use(input)"]).toBe(1);
    expect(r2.skipped["malformed-block:text"]).toBe(1);
  });

  it("counts content entries that are not blocks, and blocks whose text is not text", () => {
    // detect() only checks that content is an array. What is in it used to
    // be filtered to objects and string-typed text without a count, so an
    // import that lost the user's whole message printed no skipped line.
    const rough = doc({}, [
      { id: "u1", role: "user", ts: 1777713262000, content: ["hello there", 42, null] },
      {
        id: "a1",
        role: "assistant",
        ts: 1777713263000,
        content: ["reply", { type: "text", text: 7 }, { type: "thinking", thinking: ["x"] }],
      },
    ]);
    const r2 = clineSdkAdapter.convert(rough);
    expect(r2.drafts.map((d) => d.type)).toEqual(["session.start", "session.end"]);
    expect(r2.skipped["malformed-block:non-object"]).toBe(4);
    expect(r2.skipped["malformed-block:text"]).toBe(1);
    expect(r2.skipped["malformed-block:thinking"]).toBe(1);
  });

  it("gives an id-less tool_use or tool_result a null id rather than a shared placeholder", () => {
    // Both used to get the literal "(missing)". The exporters key results by
    // toolUseId and treat only null as "no id", so that one string paired
    // every id-less call with the last id-less result: a successful
    // read_files came out of the OTLP export as a failed span.
    const r2 = clineSdkAdapter.convert(
      doc({}, [
        {
          id: "a1",
          role: "assistant",
          ts: 1777713262000,
          content: [
            { type: "tool_use", name: "read_files", input: { files: [{ path: "a.ts" }] } },
            { type: "tool_use", name: "run_commands", input: { commands: [{ command: "rm" }] } },
          ],
        },
        {
          id: "u2",
          role: "user",
          ts: 1777713263000,
          content: [
            { type: "tool_result", content: "contents of a.ts" },
            { type: "tool_result", content: "rm: permission denied", is_error: true },
          ],
        },
      ]),
    );
    const ids = (t: string): unknown[] =>
      r2.drafts.filter((d) => d.type === t).map((d) => (d.payload as { toolUseId: unknown }).toolUseId);
    expect(ids("tool.call")).toEqual([null, null]);
    expect(ids("tool.result")).toEqual([null, null]);
    expect(r2.skipped["tool-use-without-id"]).toBe(2);
    expect(r2.skipped["tool-result-without-id"]).toBe(2);
  });

  it("treats a timestamp outside the years 0000 to 9999 as absent, and counts it", () => {
    // Date throws a bare "Invalid time value" past 8.64e15, which used to
    // end the whole import with that as the only message. Inside Date's
    // range but before year 0 it prints -001199-02-15T..., which is not the
    // SPEC §2 shape and which fixed-offset readers garble.
    const text = [{ type: "text", text: "x" }];
    const only = doc({}, [{ id: "a1", role: "assistant", ts: 1e300, content: text }]);
    expect(() => clineSdkAdapter.convert(only)).toThrow(/no timestamps/);

    const mixed = doc({}, [
      { id: "a1", role: "assistant", ts: 1777713262000, content: text },
      { id: "a2", role: "assistant", ts: 8640000000000001, content: text },
      { id: "a3", role: "assistant", ts: -1e14, content: text },
    ]);
    const r2 = clineSdkAdapter.convert(mixed);
    for (const d of r2.drafts) expect(d.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r2.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.assistant",
      "message.assistant",
      "message.assistant",
      "session.end",
    ]);
    expect(r2.skipped["message-timestamp-out-of-range"]).toBe(2);
    expect(r2.skipped["message-timestamp-inherited"]).toBeUndefined();
  });

  it("carries metrics.cost only when the source held a number", () => {
    // A string, a null or a boolean used to land as cost: 0 inside the
    // hashed payload, a figure the log never stated (openclaw's precedent
    // is to record only what was actually a number).
    const text = [{ type: "text", text: "x" }];
    const r2 = clineSdkAdapter.convert(
      doc({}, [
        { id: "a1", role: "assistant", ts: 5, content: text, metrics: { inputTokens: 10, cost: "0.021" } },
        { id: "a2", role: "assistant", ts: 6, content: text, metrics: { inputTokens: 10, cost: null } },
        { id: "a3", role: "assistant", ts: 7, content: text, metrics: { inputTokens: 10, cost: true } },
        { id: "a4", role: "assistant", ts: 8, content: text, metrics: { inputTokens: 10, cost: 0.021 } },
      ]),
    );
    const natives = r2.drafts
      .filter((d) => d.type === "cost")
      .map((d) => (d.payload as { native: Record<string, unknown> }).native);
    expect(natives).toHaveLength(4);
    for (const n of natives.slice(0, 3)) expect("cost" in n).toBe(false);
    expect(natives[3]!.cost).toBe(0.021);
  });
});

describe("a session that is still running (ConvertOptions.live)", () => {
  const v1 = [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
    {
      id: "a1",
      role: "assistant",
      ts: 1777713262000,
      modelInfo: { id: "m" },
      content: [{ type: "text", text: "hello" }],
    },
  ];
  const v2 = [
    ...v1,
    {
      id: "a2",
      role: "assistant",
      ts: 1777713263000,
      modelInfo: { id: "m" },
      content: [{ type: "text", text: "more" }],
    },
  ];

  it("holds back session.end, and keeps the document's updated_at out of the chain", () => {
    // Cline rewrites <id>.messages.json in place as messages land and bumps
    // updated_at each time. A session.end that moved with every poll, or a
    // session.start that changed with the file's own write time, was a
    // rewrite of streamed history and stopped the share on the first update.
    const at = (t: string, messages: unknown[]): string[] => doc({ updated_at: t }, messages);
    const live = clineSdkAdapter.convert(at("2026-05-02T09:14:22.000Z", v1), { live: true }).drafts;
    expect(live.some((d) => d.type === "session.end")).toBe(false);

    const full = clineSdkAdapter.convert(at("2026-05-02T09:14:22.000Z", v1)).drafts;
    expect(full.length).toBe(live.length + 1);
    expect(full.slice(0, live.length).map((d) => canonicalJson(d))).toEqual(
      live.map((d) => canonicalJson(d)),
    );
    expect(full[full.length - 1]!.type).toBe("session.end");

    const later = clineSdkAdapter.convert(at("2026-05-02T09:15:00.000Z", v2), { live: true }).drafts;
    expect(later.slice(0, live.length).map((d) => canonicalJson(d))).toEqual(
      live.map((d) => canonicalJson(d)),
    );
  });

  it("a follower keeps streaming across Cline's rewrites and ends byte-identical to an import", () => {
    const dir = mktemp();
    const path = join(dir, "s-1.messages.json");
    const write = (t: string, messages: unknown[]): void =>
      writeFileSync(path, doc({ updated_at: t }, messages).join("\n"), "utf8");

    // The golden fixture omits ts on user messages, so a session that has
    // only the user's opening turn is not yet datable: nothing streams, and
    // nothing throws.
    write("2026-05-02T09:14:20.000Z", v1.slice(0, 1));
    const follower = new SessionFollower(path, clineSdkAdapter);
    const chunks = [follower.poll()];
    expect(chunks[0]).toEqual([]);

    write("2026-05-02T09:14:22.000Z", v1);
    chunks.push(follower.poll());
    expect(chunks[1]!.map((e) => e.type)).toEqual(["session.start", "message.user", "message.assistant"]);

    write("2026-05-02T09:15:00.000Z", v2);
    chunks.push(follower.poll()); // used to throw StabilityError here
    expect(chunks[2]!.map((e) => e.type)).toEqual(["message.assistant"]);
    chunks.push(follower.finish());
    expect(chunks[3]!.map((e) => e.type)).toEqual(["session.end"]);

    const streamed = chunks.flat();
    const full = clineSdkAdapter.convert(doc({ updated_at: "2026-05-02T09:15:00.000Z" }, v2));
    const counts: RedactionCounts = {};
    for (const d of full.drafts) d.payload = redactDeep(d.payload, counts);
    expect(toJsonl(streamed)).toBe(toJsonl(buildChain(full.sessionId, full.drafts)));
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

  it("does not pair id-less calls with id-less results in the OpenTelemetry export", () => {
    // With the shared "(missing)" id, both spans below reported the second
    // result's error, and read_files had not failed.
    const dir = mktemp();
    const src = join(dir, "s-miss.messages.json");
    writeFileSync(
      src,
      doc({ sessionId: "s-miss" }, [
        {
          id: "a1",
          role: "assistant",
          ts: 1777713262000,
          modelInfo: { id: "m" },
          content: [
            { type: "tool_use", name: "read_files", input: { files: [{ path: "a.ts" }] } },
            { type: "tool_use", name: "run_commands", input: { commands: [{ command: "rm" }] } },
          ],
        },
        {
          id: "u2",
          role: "user",
          ts: 1777713263000,
          content: [
            { type: "tool_result", content: "contents of a.ts" },
            { type: "tool_result", content: "rm: permission denied", is_error: true },
          ],
        },
      ]).join("\n"),
      "utf8",
    );
    const imp = agit(["import", src, "--dir", dir]);
    expect(imp.code).toBe(0);
    expect(imp.out).toContain("tool-use-without-id");
    const otel = agit(["export", "s-miss", "--otel", "--dir", dir]);
    expect(otel.code).toBe(0);
    expect(otel.out).not.toContain("(missing)");
    type Span = { name: string; status: { code: number } };
    const spans = (JSON.parse(otel.out) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] })
      .resourceSpans[0]!.scopeSpans[0]!.spans;
    const tools = spans.filter((s) => s.name.startsWith("execute_tool "));
    expect(tools.map((s) => s.name)).toEqual(["execute_tool read_files", "execute_tool run_commands"]);
    for (const s of tools) expect(s.status.code).toBe(0);
  });
});
