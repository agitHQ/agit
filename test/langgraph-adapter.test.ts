/**
 * The LangGraph adapter (src/adapters/langgraph.ts) and the two readers
 * under it. Both fixtures under fixtures/langgraph were written by the real
 * runtime (langgraph 1.2.11 / langgraph-checkpoint-sqlite 3.1.1) over a fake
 * chat model, so what is asserted here is what the writer stored, not what
 * this adapter would like it to have stored.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { langgraphAdapter } from "../src/adapters/langgraph.js";
import type { Json } from "../src/format/events.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { decodeMsgpack, MsgpackError } from "../src/msgpack.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";
import {
  columnsOf,
  decodeRecord,
  looksLikeSqlite,
  readVarint,
  rowsOf,
  SqliteError,
  SqliteFile,
} from "../src/sqlite.js";
import { readSessionEvents, readSessionMeta } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "langgraph", "simple.sqlite");
const EDGES = join(ROOT, "fixtures", "langgraph", "edges.sqlite");
const GOLDEN = join(ROOT, "fixtures", "langgraph", "simple.golden.jsonl");
const THREAD_A = "thread/A with spaces";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-langgraph-"));

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

const bytes = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
const payloads = (drafts: { type: string; payload: Json }[], type: string): Record<string, Json>[] =>
  drafts.filter((d) => d.type === type).map((d) => d.payload as Record<string, Json>);

describe("the SQLite reader", () => {
  it("walks the real checkpointer's tables and columns", () => {
    const db = new SqliteFile(bytes(SIMPLE));
    expect(db.pageSize).toBe(4096);
    expect(db.tables().map((t) => t.name)).toEqual(["checkpoints", "writes"]);
    expect(db.table("checkpoints")!.columns).toEqual([
      "thread_id",
      "checkpoint_ns",
      "checkpoint_id",
      "parent_checkpoint_id",
      "type",
      "checkpoint",
      "metadata",
    ]);
    const rows = rowsOf(db, db.table("checkpoints")!);
    expect(rows.length).toBe(8);
    expect(rows.every((r) => r.type === "msgpack" && r.checkpoint instanceof Uint8Array)).toBe(true);
    // Text, null and blob columns come back as what the format stored.
    expect(rows[0]!.parent_checkpoint_id).toBeNull();
    expect(rows.slice(1).every((r) => typeof r.parent_checkpoint_id === "string")).toBe(true);
  });

  it("reads a payload that spills into overflow pages", () => {
    // The edge fixture's largest checkpoint is bigger than a 4096-byte page
    // can hold locally, so its record crosses an overflow chain.
    const db = new SqliteFile(bytes(EDGES));
    const rows = rowsOf(db, db.table("checkpoints")!);
    const biggest = Math.max(...rows.map((r) => (r.checkpoint as Uint8Array).length));
    expect(biggest).toBeGreaterThan(db.usable - 35);
    for (const r of rows) expect(() => decodeMsgpack(r.checkpoint as Uint8Array)).not.toThrow();
  });

  it("decodes every serial type the record format defines", () => {
    // Header: size, then serial types; body: the values.
    const rec = new Uint8Array([
      0x0e, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x12, 0x15, 0x0c,
      // 1: int8
      0xff,
      // 2: int16
      0x01, 0x00,
      // 3: int24
      0xff, 0xff, 0xfe,
      // 4: int32
      0x00, 0x00, 0x01, 0x00,
      // 5: int48
      0x00, 0x00, 0x00, 0x00, 0x00, 0x2a,
      // 6: int64
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07,
      // 7: float64 (1.5)
      0x3f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // 0x12: blob of 3
      0x01, 0x02, 0x03,
      // 0x15: text of 4
      0x61, 0x67, 0x69, 0x74,
    ]);
    const v = decodeRecord(rec);
    expect(v.slice(0, 10)).toEqual([null, -1, 256, -2, 256, 42, 7, 1.5, 0, 1]);
    expect(Array.from(v[10] as Uint8Array)).toEqual([1, 2, 3]);
    expect(v[11]).toBe("agit");
    expect(v[12]).toEqual(new Uint8Array(0));
  });

  it("reads varints of every length, including the nine-byte form", () => {
    expect(readVarint(new Uint8Array([0x7f]), 0)).toEqual([127n, 1]);
    expect(readVarint(new Uint8Array([0x81, 0x00]), 0)).toEqual([128n, 2]);
    const nine = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(readVarint(nine, 0)).toEqual([-1n, 9]);
    expect(() => readVarint(new Uint8Array([0x80]), 0)).toThrow(SqliteError);
  });

  it("parses column names past quoting and table constraints", () => {
    expect(columnsOf('CREATE TABLE t ("a" TEXT, [b] INT, `c` BLOB, PRIMARY KEY (a, b), UNIQUE (c))')).toEqual(
      ["a", "b", "c"],
    );
  });

  it("refuses what it is not", () => {
    expect(looksLikeSqlite(new Uint8Array(50))).toBe(false);
    expect(() => new SqliteFile(new Uint8Array(200))).toThrow(SqliteError);
    const bad = bytes(SIMPLE).slice();
    bad.set([0, 0, 0, 2], 56); // text encoding UTF-16le
    expect(() => new SqliteFile(bad)).toThrow(/UTF-8/);
  });
});

describe("the msgpack decoder", () => {
  it("decodes the format's scalar, container and extension shapes", () => {
    const b = new Uint8Array([
      0x83, // map of 3
      0xa1,
      0x61,
      0x93,
      0x01,
      0xff,
      0xcb,
      0x40,
      0x09,
      0x21,
      0xfb,
      0x54,
      0x44,
      0x2d,
      0x18, // "a": [1, -1, 3.14159...]
      0xa1,
      0x62,
      0xd6,
      0x05,
      0xde,
      0xad,
      0xbe,
      0xef, // "b": fixext4 type 5
      0xa1,
      0x63,
      0xc4,
      0x02,
      0x00,
      0x01, // "c": bin 2
    ]);
    const v = decodeMsgpack(b) as Record<string, unknown>;
    expect(v.a).toEqual([1, -1, Math.PI]);
    expect(v.b).toEqual({ $ext: 5, data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) });
    expect(v.c).toEqual(new Uint8Array([0, 1]));
  });

  it("keeps a 64-bit integer exact past the double's range, and refuses trailing bytes", () => {
    const big = new Uint8Array([0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(decodeMsgpack(big)).toBe(18446744073709551615n);
    expect(decodeMsgpack(new Uint8Array([0xd3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a]))).toBe(42);
    expect(() => decodeMsgpack(new Uint8Array([0x01, 0x02]))).toThrow(MsgpackError);
    expect(() => decodeMsgpack(new Uint8Array([0xc1]))).toThrow(MsgpackError);
    expect(() => decodeMsgpack(new Uint8Array([0xa5, 0x61]))).toThrow(MsgpackError);
  });
});

describe("the adapter over the runtime's own checkpoints", () => {
  it("is a binary adapter: never text, recognized from the schema", () => {
    expect(langgraphAdapter.detect(["{}"])).toBe(false);
    expect(langgraphAdapter.detectBytes!(bytes(SIMPLE))).toBe(true);
    expect(langgraphAdapter.detectBytes!(new TextEncoder().encode("not sqlite"))).toBe(false);
    expect(() => langgraphAdapter.convert(["{}"])).toThrow(/convertBytes/);
  });

  it("maps the thread's messages onto agit events, dated by the checkpoint that first held them", () => {
    const r = langgraphAdapter.convertBytes!(bytes(SIMPLE));
    expect(r.sessionId).toBe("thread-agit-fixture-0001");
    expect(r.records).toBe(8);
    expect(r.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "tool.call",
      "cost",
      "tool.result",
      "message.assistant",
      "cost",
      "message.user",
      "message.assistant",
      "cost",
      "session.end",
    ]);
    const start = r.drafts[0]!.payload as Record<string, Json>;
    expect(start.runtime).toBe("langgraph");
    expect(start.runtimeVersion).toBeNull();
    expect(start.cwd).toBeNull();
    expect(start.nativeSessionId).toBe("thread-agit-fixture-0001");
    expect((start.native as Record<string, Json>).checkpointFormat).toBe(4);

    const [call] = payloads(r.drafts, "tool.call");
    expect(call).toMatchObject({
      toolUseId: "call_0001",
      name: "write_note",
      input: { path: "notes/todo.md" },
    });
    const [result] = payloads(r.drafts, "tool.result");
    expect(result).toMatchObject({
      toolUseId: "call_0001",
      isError: false,
      output: "wrote 11 bytes to notes/todo.md",
    });
    expect((result!.native as Record<string, Json>).tool).toBe("write_note");
    const costs = payloads(r.drafts, "cost");
    expect(costs.map((c) => (c.usage as Record<string, number>).inputTokens)).toEqual([41, 66, 84]);
    expect(costs.every((c) => c.model === "fake-model-1")).toBe(true);
    // Every message is dated by a checkpoint, and the report says so.
    expect(r.skipped).toEqual({ "message-timestamp-from-checkpoint": 6 });
    // Timestamps are monotonic and millisecond UTC (the checkpoint's own is microsecond +00:00).
    const ts = r.drafts.map((d) => d.ts);
    expect([...ts].sort()).toEqual(ts);
    expect(ts.every((t) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t))).toBe(true);
  });

  it("reproduces the committed golden log exactly", () => {
    const converted = langgraphAdapter.convertBytes!(bytes(SIMPLE));
    const counts: RedactionCounts = {};
    for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
    const produced = toJsonl(buildChain(converted.sessionId, converted.drafts));
    expect(produced).toBe(readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n"));
  });

  it("is deterministic over the same bytes", () => {
    const a = langgraphAdapter.convertBytes!(bytes(SIMPLE));
    const b = langgraphAdapter.convertBytes!(bytes(SIMPLE));
    expect(toJsonl(buildChain(a.sessionId, a.drafts))).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
  });

  it("refuses a database with several threads, names them, and takes --thread", () => {
    expect(() => langgraphAdapter.convertBytes!(bytes(EDGES))).toThrow(
      /3 threads.*thread-B, thread-long, thread\/A with spaces/,
    );
    expect(() => langgraphAdapter.convertBytes!(bytes(EDGES), { select: "nope" })).toThrow(
      /no thread "nope"/,
    );
    const b = langgraphAdapter.convertBytes!(bytes(EDGES), { select: "thread-B" });
    expect(b.sessionId).toBe("thread-B");
    // A thread id that is not a safe directory name gets a derived one.
    const a = langgraphAdapter.convertBytes!(bytes(EDGES), { select: THREAD_A });
    expect(a.sessionId).toMatch(/^langgraph-[0-9a-f]{12}$/);
    expect((a.drafts[0]!.payload as Record<string, Json>).nativeSessionId).toBe(THREAD_A);
  });

  it("follows the branch the saver calls current, and counts what is off it", () => {
    // Thread A ran once, then update_state was applied against an older
    // checkpoint and the graph continued from there. The saver's current
    // checkpoint (greatest id) is on the new branch, so the history is the
    // edit and what followed; the four checkpoints of the abandoned branch
    // and the six a subgraph wrote are counted. Other threads are their own
    // sessions, not skips of this one.
    const a = langgraphAdapter.convertBytes!(bytes(EDGES), { select: THREAD_A });
    expect(payloads(a.drafts, "message.user").map((p) => p.text)).toEqual([
      "Read my note.",
      "Edited from an older point.",
    ]);
    expect(
      payloads(a.drafts, "message.assistant").map((p) => (p.blocks as { text: string }[])[0]!.text),
    ).toEqual(["After the edit.", "(subgraph ran)"]);
    expect(a.records).toBe(15);
    expect(a.skipped).toEqual({
      "subgraph-checkpoint": 6,
      "checkpoint-off-current-branch": 4,
      "message-type:system": 1,
      "message-timestamp-from-checkpoint": 5,
    });
  });

  it("keeps thinking parts, cache token details and a tool error; counts a part it cannot read", () => {
    const b = langgraphAdapter.convertBytes!(bytes(EDGES), { select: "thread-B" });
    const [first] = payloads(b.drafts, "message.assistant");
    expect(first!.blocks).toEqual([
      { type: "thinking", text: "The user wants the note; I should read it." },
      { type: "text", text: "Let me read it." },
    ]);
    const [cost] = payloads(b.drafts, "cost");
    expect(cost!.usage).toEqual({
      inputTokens: 30,
      outputTokens: 9,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 3,
    });
    const [result] = payloads(b.drafts, "tool.result");
    expect(result!.isError).toBe(true);
    expect(result!.output).toContain("no such note: notes/missing.md");
    expect(b.skipped["content-part:image"]).toBe(1);
  });
});

describe("agit import on a LangGraph database", () => {
  it("imports, verifies, replays and exports; a second thread from the same file is its own session", () => {
    const dir = mktemp();
    const r = agit(["import", SIMPLE, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("adapter     langgraph@0.1.0");
    expect(agit(["verify", "thread-agit-fixture-0001", "--dir", dir]).code).toBe(0);
    expect(agit(["replay", "thread-agit-fixture-0001", "--timeline", "--dir", dir]).out).toContain(
      "write_note",
    );
    expect(agit(["export", "thread-agit-fixture-0001", "--atif", "--dir", dir]).code).toBe(0);
    expect(agit(["export", "thread-agit-fixture-0001", "--otel", "--dir", dir]).code).toBe(0);
    // A single-thread database still records which thread it was.
    expect(readSessionMeta(dir, "thread-agit-fixture-0001")!.source.select).toBe("thread-agit-fixture-0001");

    // Several threads: every one is imported, one line each; --thread names one.
    const many = agit(["import", EDGES, "--dir", dir]);
    expect(many.code, many.out).toBe(0);
    expect(many.out).toContain("3 sessions");
    expect(many.out).toContain("3 imported, 0 updated, 0 unchanged");
    expect(agit(["import", EDGES, "--thread", "thread-B", "--dir", dir]).out).toContain("unchanged thread-B");
    expect(agit(["import", EDGES, "--thread", THREAD_A, "--dir", dir]).out).toContain("unchanged langgraph-");
    expect(agit(["import", EDGES, "--thread", "nope", "--dir", dir]).code).toBe(1);
    expect(readSessionMeta(dir, "thread-B")!.source.select).toBe("thread-B");
    expect(readSessionEvents(dir, "thread-B").length).toBe(10);
  });

  it("refuses a database whose WAL sidecar holds pages the main file does not", () => {
    const dir = mktemp();
    const db = join(dir, "checkpoints.sqlite");
    writeFileSync(db, readFileSync(SIMPLE));
    writeFileSync(`${db}-wal`, new Uint8Array(32 + 4096 + 24)); // a header and one frame
    const r = agit(["import", db, "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("wal_checkpoint");
    expect(existsSync(join(dir, ".agit", "sessions"))).toBe(false);
    // An empty sidecar (just the header) is fine.
    writeFileSync(`${db}-wal`, new Uint8Array(32));
    expect(agit(["import", db, "--dir", dir]).code).toBe(0);
  });
});
