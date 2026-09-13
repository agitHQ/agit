/**
 * The OpenCode adapter over the database OpenCode writes (opencode.db). The
 * fixture is two synthetic sessions under OpenCode's generated DDL, with
 * message and part rows shaped by its v1 session schema and inserted out of
 * the order OpenCode reads them in — so the adapter is held to the read
 * order the runtime's own `MessageV2.page` uses, not to rowid luck.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { discoverSessionLogs } from "../src/discover.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { readSessionEvents, readSessionMeta } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DB = join(ROOT, "fixtures", "opencode", "opencode.sqlite");
const A = "ses_fixtureaaaa0001";
const B = "ses_fixturebbbb0002";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-opencode-"));
const bytes = (): Uint8Array => new Uint8Array(readFileSync(DB));
const payloads = (drafts: { type: string; payload: Json }[], type: string): Record<string, Json>[] =>
  drafts.filter((d) => d.type === type).map((d) => d.payload as Record<string, Json>);

function agit(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, ...env },
      }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("the OpenCode adapter over opencode.db", () => {
  it("is a binary adapter recognized by OpenCode's three tables, and lists the sessions that have messages", () => {
    expect(opencodeAdapter.detect(["{}"])).toBe(false);
    expect(() => opencodeAdapter.convert(["{}"])).toThrow(/opencode\.db/);
    expect(opencodeAdapter.detectBytes!(bytes())).toBe(true);
    expect(
      opencodeAdapter.detectBytes!(
        new Uint8Array(readFileSync(join(ROOT, "fixtures", "openclaw", "agent.sqlite"))),
      ),
    ).toBe(false);
    expect(opencodeAdapter.sessionsIn!(bytes())).toEqual([A, B]);
  });

  it("maps a session's messages and parts in OpenCode's own read order", () => {
    const r = opencodeAdapter.convertBytes!(bytes(), { select: A });
    expect(r.sessionId).toBe(A);
    expect(r.records).toBe(4);
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "tool.call",
      "tool.result",
      "cost",
      "tool.call",
      "tool.result",
      "cost",
      "message.user",
      "tool.call",
      "tool.result",
      "tool.call",
      "cost",
      "session.end",
    ]);
    const start = r.drafts[0]!.payload as Record<string, Json>;
    expect(start).toMatchObject({
      runtime: "opencode",
      runtimeVersion: "1.2.3",
      cwd: "/home/dev/demo",
      nativeSessionId: A,
      native: { title: "Fix the parser test", projectId: "prj_fixture0001" },
    });

    const [assistant] = payloads(r.drafts, "message.assistant");
    expect(assistant!.model).toBe("claude-sonnet-5");
    expect(assistant!.stopReason).toBe("stop");
    expect(assistant!.blocks).toEqual([
      { type: "thinking", text: "Read the test first, then the parser." },
      { type: "text", text: "Let me look at the failing test." },
      { type: "text", text: "The parser was concatenating strings; fixed." },
    ]);

    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => [c.toolUseId, c.name])).toEqual([
      ["call_read_1", "read"],
      ["call_edit_1", "edit"],
      ["call_bash_1", "bash"],
      ["call_bash_2", "bash"],
    ]);
    expect(calls[1]!.input).toEqual({
      filePath: "src/parser.ts",
      oldString: "a + b",
      newString: "Number(a) + Number(b)",
    });
    const results = payloads(r.drafts, "tool.result");
    expect(results.map((x) => [x.toolUseId, x.isError, x.output])).toEqual([
      ["call_read_1", false, "expect(parse('1+1')).toBe(2)"],
      ["call_edit_1", false, "Edit applied"],
      ["call_bash_1", true, "Command timed out"],
    ]);

    // One cost per step-finish, that step's tokens; reasoning tokens ride under native.
    const costs = payloads(r.drafts, "cost");
    expect(costs.map((c) => c.usage)).toEqual([
      { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 300, cacheCreationInputTokens: 20 },
      { inputTokens: 200, outputTokens: 55, cacheReadInputTokens: 320, cacheCreationInputTokens: 0 },
      { inputTokens: 80, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    ]);
    expect((costs[0]!.native as Record<string, Json>).reasoningTokens).toBe(12);
    expect((costs[0]!.native as Record<string, Json>).reason).toBe("tool-calls");
    // The third has no step-finish: usage came from the message itself.
    expect((costs[2]!.native as Record<string, Json>).partId).toBeUndefined();
    for (const c of costs) expect(JSON.stringify(c)).not.toContain("0.00");

    // Timestamps are the rows' own and monotonic.
    const ts = r.drafts.map((d) => d.ts);
    expect([...ts].sort()).toEqual(ts);
    expect(ts[0]).toBe("2026-03-05T08:00:00.000Z");
    expect(payloads(r.drafts, "tool.result")[2]).toBeDefined();
    expect(r.drafts[11]!.ts).toBe("2026-03-05T08:00:40.100Z"); // the bash error's time.end
  });

  it("counts what it does not map, by name", () => {
    const r = opencodeAdapter.convertBytes!(bytes(), { select: A });
    expect(r.skipped).toEqual({
      "cost-usd-not-stored (SPEC §5.9)": 3,
      "part:step-start": 2,
      "part:patch": 1,
      "text-part-synthetic": 1,
      "tool-part-running": 1,
      "part:file": 1,
    });
    // The synthetic part is not the user's words: the second prompt is the typed text alone.
    expect(payloads(r.drafts, "message.user").map((p) => p.text)).toEqual([
      "The parser test is failing, can you look?",
      "Thanks. Run the tests.",
    ]);
    // No file.diff: OpenCode's edits live in git snapshots, not in the database.
    expect(r.drafts.some((d) => d.type === "file.diff")).toBe(false);
  });

  it("takes a message's own usage when no step-finish part broke it up", () => {
    const r = opencodeAdapter.convertBytes!(bytes(), { select: B });
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "cost",
      "session.end",
    ]);
    expect(payloads(r.drafts, "cost")[0]!.usage).toEqual({
      inputTokens: 30,
      outputTokens: 8,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("is deterministic, and refuses to guess between sessions", () => {
    const a = opencodeAdapter.convertBytes!(bytes(), { select: A });
    const b = opencodeAdapter.convertBytes!(bytes(), { select: A });
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    expect(() => opencodeAdapter.convertBytes!(bytes())).toThrow(/2 sessions.*--thread/);
    expect(() => opencodeAdapter.convertBytes!(bytes(), { select: "nope" })).toThrow(/no session "nope"/);
  });
});

describe("agit import on opencode.db", () => {
  it("imports every session, verifies, and is found where OpenCode keeps the file", () => {
    const dir = mktemp();
    const all = agit(["import", DB, "--dir", dir]);
    expect(all.code, all.out).toBe(0);
    expect(all.out).toContain("2 sessions");
    expect(all.out).toMatch(/imported {3}ses_fixtureaaaa0001 {2}opencode\s+15 events/);
    expect(agit(["verify", A, "--dir", dir]).code).toBe(0);
    expect(readSessionMeta(dir, A)!.source.select).toBe(A);
    expect(readSessionEvents(dir, B).length).toBe(5);
    expect(agit(["export", A, "--atif", "--dir", dir]).code).toBe(0);
    expect(agit(["replay", A, "--timeline", "--dir", dir]).out).toContain("bash command=npm test");
    expect(agit(["import", DB, "--dir", dir]).out).toContain("0 imported, 0 updated, 2 unchanged");

    const home = mktemp();
    const data = join(home, ".local", "share", "opencode");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "opencode.db"), readFileSync(DB));
    writeFileSync(join(data, "opencode-beta.db"), readFileSync(DB));
    const { logs } = discoverSessionLogs(home, {});
    expect(logs.map((l) => [l.runtime, l.path]).sort()).toEqual([
      ["opencode", join(data, "opencode-beta.db")],
      ["opencode", join(data, "opencode.db")],
    ]);
    const other = mktemp();
    const r = agit(["import", "--all", "--dir", other], { HOME: home, USERPROFILE: home, XDG_DATA_HOME: "" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("2 imported, 0 updated, 2 unchanged");
  });
});
