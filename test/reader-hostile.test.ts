/**
 * The SQLite and msgpack readers over bytes that are wrong on purpose. A
 * database or a checkpoint blob is untrusted input; whatever is done to one,
 * the readers answer with their own error type — never a RangeError out of
 * a DataView, an allocation the size a varint asked for, or a blown stack.
 * Mutations are seeded, so a failure here reproduces.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { langgraphAdapter } from "../src/adapters/langgraph.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import { decodeMsgpack, MAX_DEPTH, MsgpackError } from "../src/msgpack.js";
import { rowsOf, SqliteError, SqliteFile } from "../src/sqlite.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const LANGGRAPH = new Uint8Array(readFileSync(join(ROOT, "fixtures", "langgraph", "edges.sqlite")));
const OPENCLAW = new Uint8Array(readFileSync(join(ROOT, "fixtures", "openclaw", "agent.sqlite")));

/** A small deterministic PRNG (mulberry32), so every run mutates the same bytes. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The only exceptions a reader may raise: its own, or a plain Error with a message. */
function acceptable(err: unknown): boolean {
  if (err instanceof SqliteError || err instanceof MsgpackError) return true;
  return err instanceof Error && err.constructor === Error && err.message.length > 0;
}

function walk(bytes: Uint8Array): void {
  const db = new SqliteFile(bytes);
  for (const t of db.tables()) for (const row of rowsOf(db, t)) void row;
}

function mutations(base: Uint8Array, seed: number, count: number): Uint8Array[] {
  const next = rng(seed);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const kind = next();
    if (kind < 0.4) {
      // Flip a handful of bytes anywhere.
      const m = base.slice();
      const flips = 1 + Math.floor(next() * 8);
      for (let f = 0; f < flips; f++) m[Math.floor(next() * m.length)] = Math.floor(next() * 256);
      out.push(m);
    } else if (kind < 0.7) {
      // Truncate.
      out.push(base.slice(0, Math.floor(next() * base.length)));
    } else if (kind < 0.85) {
      // Hit the first pages hard: header, sqlite_master, root pages.
      const m = base.slice();
      const at = Math.floor(next() * Math.min(m.length, 8192));
      for (let f = 0; f < 16; f++) m[(at + f) % m.length] = Math.floor(next() * 256);
      out.push(m);
    } else {
      // Rewrite the page size, reserved bytes, page count or encoding.
      const m = base.slice();
      const field = [16, 20, 28, 56][Math.floor(next() * 4)]!;
      for (let f = 0; f < 4; f++) m[field + f] = Math.floor(next() * 256);
      out.push(m);
    }
  }
  return out;
}

describe("the SQLite reader over hostile bytes", () => {
  it("answers every mutation of a real database with SqliteError or a value", () => {
    let errors = 0;
    let fine = 0;
    for (const bytes of [...mutations(LANGGRAPH, 1, 250), ...mutations(OPENCLAW, 2, 250)]) {
      try {
        walk(bytes);
        fine++;
      } catch (err) {
        expect(acceptable(err), `${(err as Error).constructor.name}: ${(err as Error).message}`).toBe(true);
        errors++;
      }
    }
    // Both outcomes happen; the mutations are not all fatal and not all benign.
    expect(errors).toBeGreaterThan(0);
    expect(fine).toBeGreaterThan(0);
  });

  /** The first table leaf page past page 1 that holds a cell: a place to corrupt one. */
  function firstLeaf(bytes: Uint8Array): { page: number; base: number } {
    const db = new SqliteFile(bytes);
    for (let page = 2; page <= db.pageCount; page++) {
      const base = (page - 1) * db.pageSize;
      if (bytes[base] === 0x0d && new DataView(bytes.buffer).getUint16(base + 3) > 0) return { page, base };
    }
    throw new Error("no leaf page");
  }

  it("refuses a payload larger than the file instead of allocating it", () => {
    // The first cell's payload-size varint is overwritten with nine bytes
    // that spell ~2^63; the reader must not try to allocate that.
    const { base } = firstLeaf(LANGGRAPH);
    const m = LANGGRAPH.slice();
    const cellOff = new DataView(m.buffer).getUint16(base + 8);
    m.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], base + cellOff);
    expect(() => walk(m)).toThrow(SqliteError);
    expect(() => walk(m)).toThrow(/exceeds the file/);
  });

  it("refuses a cell pointer outside its page and a b-tree that loops", () => {
    const { base } = firstLeaf(LANGGRAPH);
    const m = LANGGRAPH.slice();
    new DataView(m.buffer).setUint16(base + 8, 0xffff);
    expect(() => walk(m)).toThrow(/outside page/);

    // Make a table's root an interior page whose only child is itself.
    const db = new SqliteFile(LANGGRAPH);
    const root = db.table("checkpoints")!.rootPage;
    const loop = LANGGRAPH.slice();
    const rootBase = (root - 1) * db.pageSize;
    loop[rootBase] = 0x05;
    new DataView(loop.buffer).setUint16(rootBase + 3, 0);
    new DataView(loop.buffer).setUint32(rootBase + 8, root);
    expect(() => walk(loop)).toThrow(/referenced twice/);
  });
});

describe("the msgpack decoder over hostile bytes", () => {
  it("answers every mutation of real checkpoint blobs with MsgpackError or a value", () => {
    const db = new SqliteFile(LANGGRAPH);
    const blobs = rowsOf(db, db.table("checkpoints")!).map((r) => r.checkpoint as Uint8Array);
    const next = rng(3);
    let errors = 0;
    for (let i = 0; i < 600; i++) {
      const base = blobs[i % blobs.length]!;
      const m = next() < 0.5 ? base.slice(0, Math.floor(next() * base.length)) : base.slice();
      if (m.length === base.length) {
        for (let f = 0; f < 4; f++) m[Math.floor(next() * m.length)] = Math.floor(next() * 256);
      }
      try {
        decodeMsgpack(m);
      } catch (err) {
        expect(acceptable(err), `${(err as Error).constructor.name}: ${(err as Error).message}`).toBe(true);
        errors++;
      }
    }
    expect(errors).toBeGreaterThan(0);
  });

  it("refuses a container that cannot fit, and nesting past the limit, before touching the stack", () => {
    expect(() => decodeMsgpack(new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff]))).toThrow(/cannot fit/);
    expect(() => decodeMsgpack(new Uint8Array([0xdf, 0xff, 0xff, 0xff, 0xff]))).toThrow(/cannot fit/);
    const deep = new Uint8Array(MAX_DEPTH + 10).fill(0x91); // [[[[...
    expect(() => decodeMsgpack(deep)).toThrow(/nesting deeper/);
    // Just under the limit, properly closed, is fine.
    const ok = new Uint8Array(MAX_DEPTH);
    ok.fill(0x91, 0, MAX_DEPTH - 1);
    ok[MAX_DEPTH - 1] = 0x90;
    expect(() => decodeMsgpack(ok)).not.toThrow();
    // Fixed-width reads at the very end.
    for (const head of [0xca, 0xcb, 0xcf, 0xd3, 0xd1, 0xd2, 0xd0, 0xd4]) {
      expect(() => decodeMsgpack(new Uint8Array([head]))).toThrow(MsgpackError);
    }
  });
});

describe("the adapters over hostile databases", () => {
  it("name what they cannot read rather than crashing", () => {
    for (const bytes of mutations(LANGGRAPH, 4, 120)) {
      try {
        if (langgraphAdapter.detectBytes!(bytes)) {
          for (const id of langgraphAdapter.sessionsIn!(bytes))
            langgraphAdapter.convertBytes!(bytes, { select: id });
        }
      } catch (err) {
        expect(acceptable(err), `${(err as Error).constructor.name}: ${(err as Error).message}`).toBe(true);
      }
    }
    for (const bytes of mutations(OPENCLAW, 5, 120)) {
      try {
        if (openclawAdapter.detectBytes!(bytes)) {
          for (const id of openclawAdapter.sessionsIn!(bytes))
            openclawAdapter.convertBytes!(bytes, { select: id });
        }
      } catch (err) {
        expect(acceptable(err), `${(err as Error).constructor.name}: ${(err as Error).message}`).toBe(true);
      }
    }
  });
});

describe("untrusted text reaches the terminal displayed, not executed", () => {
  it("strips terminal control sequences from log text and viewer messages", async () => {
    const { printable, excerpt, clipLine } = await import("../src/state.js");
    const hostile = "before \u001b[2J\u001b[H after \u009b31m x\u0007 tab\tkept";
    expect(printable(hostile)).toBe("before \uFFFD[2J\uFFFD[H after \uFFFD31m x\uFFFD tab\tkept");
    for (const c of ["\u001b", "\u009b", "\u0007"]) {
      expect(excerpt(hostile, 200)).not.toContain(c);
      expect(clipLine(hostile, 200)).not.toContain(c);
    }
    // Newlines are content for clipLine's callers (they split first) and
    // whitespace for excerpt (it collapses); neither is a control to strip.
    expect(printable("a\nb")).toBe("a\nb");
  });
});
