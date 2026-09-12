/**
 * OpenClaw's agent database (fixtures/openclaw/agent.sqlite): the two
 * synthetic transcripts stored in OpenClaw's own `transcript_events` table
 * (DDL verbatim from src/state/openclaw-agent-schema.sql), read the way
 * OpenClaw's reader reads them — `event_json` rows for one session, in `seq`
 * order — and handed to the JSONL mapping. The rows were inserted out of
 * `seq` order on purpose, so a reader that trusted rowid order would
 * produce a different chain.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import { discoverSessionLogs } from "../src/discover.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { readSessionEvents, readSessionMeta } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DB = join(ROOT, "fixtures", "openclaw", "agent.sqlite");
const SIMPLE = join(ROOT, "fixtures", "openclaw", "simple.jsonl");
const EDITS = join(ROOT, "fixtures", "openclaw", "edits.jsonl");
const SIMPLE_ID = "0199openclaw-aaaa-7bbb-8ccc-ddddeeee0001";
const EDITS_ID = "0199openclaw-edit-7bbb-8ccc-ddddeeee0002";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-openclaw-db-"));
const bytes = (): Uint8Array => new Uint8Array(readFileSync(DB));
const linesOf = (p: string): string[] =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");

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

describe("the OpenClaw adapter over the agent database", () => {
  it("recognizes the database by its transcript_events table and lists its sessions", () => {
    expect(openclawAdapter.detectBytes!(bytes())).toBe(true);
    expect(
      openclawAdapter.detectBytes!(
        new Uint8Array(readFileSync(join(ROOT, "fixtures", "langgraph", "simple.sqlite"))),
      ),
    ).toBe(false);
    expect(openclawAdapter.sessionsIn!(bytes())).toEqual([SIMPLE_ID, EDITS_ID]);
  });

  it("produces the same chain from the database as from the JSONL, seq order and all", () => {
    for (const [id, jsonl] of [
      [SIMPLE_ID, SIMPLE],
      [EDITS_ID, EDITS],
    ] as const) {
      const fromDb = openclawAdapter.convertBytes!(bytes(), { select: id });
      const fromText = openclawAdapter.convert(linesOf(jsonl));
      expect(fromDb.sessionId).toBe(id);
      expect(toJsonl(buildChain(fromDb.sessionId, fromDb.drafts))).toBe(
        toJsonl(buildChain(fromText.sessionId, fromText.drafts)),
      );
      expect(fromDb.skipped).toEqual(fromText.skipped);
    }
  });

  it("refuses to guess between sessions without a selection, and names a wrong one", () => {
    expect(() => openclawAdapter.convertBytes!(bytes())).toThrow(/2 sessions.*--thread/);
    expect(() => openclawAdapter.convertBytes!(bytes(), { select: "nope" })).toThrow(/no session "nope"/);
  });
});

describe("agit import on an OpenClaw agent database", () => {
  it("imports every session in the file, one line each, and one by name", () => {
    const dir = mktemp();
    const all = agit(["import", DB, "--dir", dir]);
    expect(all.code, all.out).toBe(0);
    expect(all.out).toContain("2 sessions");
    expect(all.out).toMatch(/imported {3}0199openclaw-aaaa-7b openclaw\s+9 events/);
    expect(all.out).toMatch(/imported {3}0199openclaw-edit-7b openclaw\s+36 events/);
    expect(readSessionMeta(dir, EDITS_ID)!.source.select).toBe(EDITS_ID);
    expect(agit(["verify", EDITS_ID, "--dir", dir]).code).toBe(0);
    // The file events the JSONL import produces are there from the database too.
    expect(readSessionEvents(dir, EDITS_ID).filter((e) => e.type === "file.diff").length).toBeGreaterThan(0);

    // Again: both unchanged. By name: the full single-session report.
    const again = agit(["import", DB, "--dir", dir]);
    expect(again.out).toContain("0 imported, 0 updated, 2 unchanged");
    const one = agit(["import", DB, "--thread", SIMPLE_ID, "--dir", dir]);
    expect(one.out).toContain(`unchanged ${SIMPLE_ID}`);
    const wrong = agit(["import", DB, "--thread", "nope", "--dir", dir]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain("it holds:");
  });

  it("is found by import --all where OpenClaw keeps it, and imported session by session", () => {
    const home = mktemp();
    const agent = join(home, ".openclaw", "agents", "main", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "openclaw-agent.sqlite"), readFileSync(DB));
    // The process-held incognito database beside it is not read.
    writeFileSync(join(agent, "incognito-openclaw-agent.sqlite"), readFileSync(DB));
    const { logs } = discoverSessionLogs(home, {});
    expect(logs.map((l) => [l.runtime, l.path])).toEqual([
      ["openclaw", join(agent, "openclaw-agent.sqlite")],
    ]);

    const dir = mktemp();
    const r = agitEnv(["import", "--all", "--dir", dir], { HOME: home, USERPROFILE: home });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("2 imported");
    expect(r.out).toContain(SIMPLE_ID);
    expect(r.out).toContain(EDITS_ID);
  });
});

function agitEnv(args: string[], env: Record<string, string>): { code: number; out: string } {
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
