/**
 * The Hermes adapter over a state.db written with Hermes's own DDL: two
 * sessions with messages and one without; OpenAI-shaped tool calls and
 * results; a write Hermes verified untransformed, a patch with its diff, a
 * write Hermes transformed (CRLF preserved), a failed patch, a multimodal
 * turn, a compressed summary, a retired row, and per-model totals.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { langgraphAdapter } from "../src/adapters/langgraph.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { discoverSessionLogs } from "../src/discover.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { applyUnifiedDiff } from "../src/patch.js";
import { integerPrimaryKeyIndex, rowsOf, SqliteFile } from "../src/sqlite.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DB = join(ROOT, "fixtures", "hermes", "state.db");
const SID = "a3f9c2e1b7d04c5e8f6a1b2c3d4e5f60";
const SID2 = "b7e1d0c9a8f74b3e9c2d1e0f6a5b4c3d";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-hermes-"));
const payloads = (drafts: { type: string; payload: Json }[], type: string): Record<string, Json>[] =>
  drafts.filter((d) => d.type === type).map((d) => d.payload as Record<string, Json>);
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const bytes = (): Uint8Array => new Uint8Array(readFileSync(DB));

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

describe("the SQLite reader and a rowid alias", () => {
  it("fills an INTEGER PRIMARY KEY column from the rowid, which the record stores as NULL", () => {
    const db = new SqliteFile(bytes());
    const messages = db.table("messages")!;
    expect(integerPrimaryKeyIndex(messages)).toBe(0);
    expect(integerPrimaryKeyIndex(db.table("sessions")!)).toBe(-1);
    const rows = rowsOf(db, messages);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => i + 1));
  });
});

describe("the Hermes adapter", () => {
  it("recognizes state.db by its tables, lists the sessions that have messages, and no other adapter claims it", () => {
    expect(hermesAdapter.detectBytes!(bytes())).toBe(true);
    expect(hermesAdapter.sessionsIn!(bytes())).toEqual([SID, SID2]);
    for (const other of [
      join("langgraph", "simple.sqlite"),
      join("openclaw", "agent.sqlite"),
      join("opencode", "opencode.sqlite"),
    ]) {
      expect(
        hermesAdapter.detectBytes!(new Uint8Array(readFileSync(join(ROOT, "fixtures", other)))),
        other,
      ).toBe(false);
    }
    expect(langgraphAdapter.detectBytes!(bytes())).toBe(false);
    expect(openclawAdapter.detectBytes!(bytes())).toBe(false);
    expect(opencodeAdapter.detectBytes!(bytes())).toBe(false);
    expect(hermesAdapter.detect(["{}"])).toBe(false);
    expect(() => hermesAdapter.convertBytes!(bytes())).toThrow(/2 sessions/);
    expect(() => hermesAdapter.convertBytes!(bytes(), { select: "nope" })).toThrow(/no session nope/);
  });

  it("reads a session in row order: OpenAI-shaped calls and results, thinking, flags, and aggregate usage", () => {
    const r = hermesAdapter.convertBytes!(bytes(), { select: SID });
    expect(r.sessionId).toBe(SID);
    expect(r.records).toBe(16);
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
      "file.diff",
      "tool.call",
      "tool.result",
      "file.diff",
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
      "message.user",
      "message.assistant",
      "message.user",
      "message.assistant",
      "cost",
      "cost",
      "session.end",
    ]);
    const start = payloads(r.drafts, "session.start")[0]!;
    expect(start).toMatchObject({
      runtime: "hermes",
      cwd: "/home/dev/hello",
      gitBranch: "main",
      nativeSessionId: SID,
    });
    expect(start.native).toEqual({
      source: "cli",
      model: "claude-sonnet-5",
      parentSessionId: null,
      title: "README greeting",
    });
    expect(r.drafts[0]!.ts).toBe("2026-06-09T10:13:20.000Z");

    const a = payloads(r.drafts, "message.assistant");
    expect(a[0]!.blocks).toEqual([
      { type: "thinking", text: "Read first, then write the README." },
      { type: "text", text: "Let me check what is there." },
    ]);
    expect(a[0]!).toMatchObject({ model: "claude-sonnet-5", stopReason: "tool_calls" });
    expect(a[0]!.native).toEqual({ rowId: 3, active: true });
    // The retired row is kept, in row order, flagged; the summary row too.
    expect(a[2]!.native).toEqual({ rowId: 16, active: false });
    expect(payloads(r.drafts, "message.user")[2]!.native).toMatchObject({ compressedSummary: true });
    expect(payloads(r.drafts, "message.user")[1]!.text).toBe("Here is a screenshot\n[image]");

    const calls = payloads(r.drafts, "tool.call");
    expect(calls.map((c) => [c.name, c.toolUseId])).toEqual([
      ["read_file", "call_r1"],
      ["write_file", "call_w1"],
      ["patch", "call_p1"],
      ["write_file", "call_w2"],
      ["patch", "call_p2"],
    ]);
    expect(calls[2]!.input).toEqual({
      path: "README.md",
      old_string: "the world",
      new_string: "the whole world",
    });
    const results = payloads(r.drafts, "tool.result");
    expect(results.map((x) => [x.toolUseId, x.isError])).toEqual([
      ["call_r1", false],
      ["call_w1", false],
      ["call_p1", false],
      ["call_w2", false],
      ["call_p2", true],
    ]);
    expect(results[1]!.structured).toMatchObject({ verified: true, bytes_written: 27 });
    expect(results[4]!.structured).toEqual({ error: "Failed to read file: src/missing.ts" });
    expect(results[0]!.native).toMatchObject({ toolName: "read_file" });

    const costs = payloads(r.drafts, "cost");
    expect(costs.map((c) => [c.model, (c.usage as Record<string, number>).inputTokens])).toEqual([
      ["claude-sonnet-5", 8000],
      ["gpt-5.5", 1100],
    ]);
    expect(costs[0]!.native).toEqual({ aggregate: true, apiCallCount: 5, requestId: null });
    expect(r.drafts.at(-1)).toMatchObject({
      ts: "2026-06-09T10:13:50.000Z",
      type: "session.end",
      payload: { reason: "user_exit", synthesized: false },
    });
    expect(JSON.stringify(r.drafts)).not.toContain("0.0412");
    expect(r.skipped).toEqual({
      "message-role:system": 1,
      "write_file:prior content unknown": 1,
      "write_file:content transformed (CRLF or BOM preserved)": 1,
      "content:image": 1,
      "cost-usd-not-stored (SPEC §5.9)": 2,
      "cost-aggregated-per-model (no per-message usage)": 2,
    });
  });

  it("hashes a write Hermes verified untransformed, and a patch replayed from Hermes's diff", () => {
    const r = hermesAdapter.convertBytes!(bytes(), { select: SID });
    const diffs = payloads(r.drafts, "file.diff");
    const readme = "# hello\n\nGreets the world.\n";
    const after = "# hello\n\nGreets the whole world.\n";
    expect(diffs[0]).toMatchObject({
      path: "/home/dev/hello/README.md",
      kind: "create",
      beforeHash: null,
      afterHash: sha(readme),
      toolUseId: "call_w1",
      source: "write_file",
    });
    expect(applyUnifiedDiff(null, diffs[0]!.diff as string)).toBe(readme);
    expect(diffs[1]).toMatchObject({
      path: "/home/dev/hello/README.md",
      kind: "modify",
      beforeHash: sha(readme),
      afterHash: sha(after),
      toolUseId: "call_p1",
      source: "patch",
    });
    // Hermes's own diff is the event's diff, and it replays.
    expect(diffs[1]!.diff).toBe(
      (payloads(r.drafts, "tool.result")[2]!.structured as Record<string, Json>).diff,
    );
    expect(applyUnifiedDiff(readme, diffs[1]!.diff as string)).toBe(after);
    // The CRLF-preserved write is not hashed: 19 bytes landed for a 17-byte argument.
    expect(diffs).toHaveLength(2);
  });

  it("holds back a synthesized session.end for a live share, keeps a real one, and is deterministic", () => {
    const ended = hermesAdapter.convertBytes!(bytes(), { select: SID, live: true });
    expect(ended.drafts.at(-1)!.type).toBe("session.end"); // Hermes recorded ended_at: that end is real
    const open = hermesAdapter.convertBytes!(bytes(), { select: SID2, live: true });
    expect(open.drafts.at(-1)!.type).not.toBe("session.end");
    const closed = hermesAdapter.convertBytes!(bytes(), { select: SID2 });
    expect(closed.drafts.at(-1)).toMatchObject({ type: "session.end", payload: { synthesized: true } });
    expect(payloads(closed.drafts, "cost")).toHaveLength(1); // the sessions row's totals, no per-model rows
    expect(payloads(closed.drafts, "cost")[0]!.model).toBe("gpt-5.5");
    const a = hermesAdapter.convertBytes!(bytes(), { select: SID });
    const b = hermesAdapter.convertBytes!(bytes(), { select: SID });
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
  });
});

describe("agit import on a Hermes database", () => {
  it("imports every session, picks one with --thread, verifies, and is found in the Hermes home", () => {
    const dir = mktemp();
    const all = agit(["import", DB, "--dir", dir]);
    expect(all.code, all.out).toBe(0);
    expect(all.out).toContain("2 sessions");
    expect(all.out).toContain("2 imported");
    expect(agit(["verify", SID, "--dir", dir]).code).toBe(0);
    expect(agit(["verify", SID2, "--dir", dir]).code).toBe(0);
    const one = mktemp();
    const picked = agit(["import", DB, "--thread", SID2, "--dir", one]);
    expect(picked.out).toContain(`imported ${SID2}`);
    expect(agit(["show", SID2, "--dir", one]).out).toContain("runtime     hermes");
    expect(agit(["export", SID, "--markdown", "--dir", dir]).code).toBe(0);
    const fork = agit(["fork", SID, "--at", "21", "--out", join(dir, "fork"), "--dir", dir]);
    expect(fork.code, fork.out).toBe(0);
    expect(readFileSync(join(dir, "fork", "tree", "README.md"), "utf8")).toBe(
      "# hello\n\nGreets the whole world.\n",
    );

    const home = mktemp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "state.db"), readFileSync(DB));
    const linux = discoverSessionLogs(home, {}, "linux");
    expect(linux.logs.filter((l) => l.runtime === "hermes").map((l) => l.path)).toEqual([
      join(home, ".hermes", "state.db"),
    ]);
    expect(
      discoverSessionLogs(home, { HERMES_HOME: join(home, "h") }, "linux").roots.find(
        (x) => x.runtime === "hermes",
      )!.dir,
    ).toBe(join(home, "h"));
    expect(
      discoverSessionLogs(home, { LOCALAPPDATA: join(home, "Local") }, "win32").roots.find(
        (x) => x.runtime === "hermes",
      )!.dir,
    ).toBe(join(home, "Local", "hermes"));
    expect(discoverSessionLogs(home, {}, "win32").roots.find((x) => x.runtime === "hermes")!.dir).toBe(
      join(home, "AppData", "Local", "hermes"),
    );
  });
});
