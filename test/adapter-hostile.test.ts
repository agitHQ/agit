/**
 * Every text adapter over lines that are wrong on purpose. A native log is
 * untrusted input; whatever is done to one — a byte flipped inside a JSON
 * value, a line truncated, a field of the wrong type, a record with the
 * right keys and nonsense values — an adapter either returns a result
 * (with the damage counted) or throws a plain Error that names the
 * problem. Never a TypeError from a dereference, never a RangeError.
 * Mutations are seeded, so a failure here reproduces.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atifAdapter } from "../src/adapters/atif.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { clineSdkAdapter } from "../src/adapters/cline-sdk.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { geminiCliAdapter } from "../src/adapters/gemini-cli.js";
import { kimiCodeAdapter } from "../src/adapters/kimi-code.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import type { Adapter } from "../src/adapters/adapter.js";
import { buildChain } from "../src/format/hash.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const F = (...p: string[]): string => join(ROOT, "fixtures", ...p);

const CASES: { adapter: Adapter; fixture: string }[] = [
  { adapter: claudeCodeAdapter, fixture: F("claude-code", "demo.jsonl") },
  { adapter: codexAdapter, fixture: F("codex", "edits.jsonl") },
  { adapter: openclawAdapter, fixture: F("openclaw", "edits.jsonl") },
  { adapter: atifAdapter, fixture: F("atif", "simple.json") },
  { adapter: clineSdkAdapter, fixture: F("cline-sdk", "simple.messages.json") },
  { adapter: geminiCliAdapter, fixture: F("gemini-cli", "session.jsonl") },
  { adapter: kimiCodeAdapter, fixture: F("kimi-code", "01JRZ3K2Y7Q8W6X5V4T3S2R1P0", "wire.jsonl") },
];

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

/** The only exception an adapter may raise: a plain Error with a message (or a subclass that is not a JS built-in). */
function acceptable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) return false;
  return err.message.length > 0;
}

/** Replace a JSON value somewhere in the document with one of the wrong shape. */
function retype(value: unknown, next: () => number, depth = 0): unknown {
  const choices: unknown[] = [null, 0, -1, 1e300, "", "x", true, [], {}, [null], { a: 1 }];
  if (depth > 6 || next() < 0.15) return choices[Math.floor(next() * choices.length)];
  if (Array.isArray(value)) {
    if (value.length === 0) return value;
    const copy = [...value];
    const i = Math.floor(next() * copy.length);
    copy[i] = retype(copy[i], next, depth + 1);
    return copy;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return value;
    const record = value as Record<string, unknown>;
    const k = keys[Math.floor(next() * keys.length)]!;
    if (next() < 0.2) return Object.fromEntries(Object.entries(record).filter(([key]) => key !== k));
    return { ...record, [k]: retype(record[k], next, depth + 1) };
  }
  return choices[Math.floor(next() * choices.length)];
}

function mutations(lines: string[], seed: number, count: number): string[][] {
  const next = rng(seed);
  const out: string[][] = [];
  for (let i = 0; i < count; i++) {
    const kind = next();
    const m = [...lines];
    const at = Math.floor(next() * m.length);
    if (kind < 0.3) {
      // A byte flipped inside a line: usually broken JSON, sometimes a changed value.
      const line = m[at]!;
      const pos = Math.floor(next() * line.length);
      m[at] = line.slice(0, pos) + String.fromCharCode(Math.floor(next() * 94) + 33) + line.slice(pos + 1);
    } else if (kind < 0.45) {
      m[at] = m[at]!.slice(0, Math.floor(next() * m[at]!.length));
    } else if (kind < 0.55) {
      m.splice(at, 1);
    } else if (kind < 0.65) {
      m.splice(at, 0, m[Math.floor(next() * m.length)]!);
    } else {
      // Right keys, wrong values: the shape a producer bug leaves behind.
      try {
        const parsed = JSON.parse(m[at]!) as unknown;
        m[at] = JSON.stringify(retype(parsed, next));
      } catch {
        m[at] = "{}";
      }
    }
    out.push(m);
  }
  return out;
}

describe("text adapters over hostile lines", () => {
  for (const [i, { adapter, fixture }] of CASES.entries()) {
    it(`${adapter.name}: returns or throws a plain Error, never a built-in one`, () => {
      const lines = readFileSync(fixture, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      let errors = 0;
      let fine = 0;
      for (const m of mutations(lines, 100 + i, 300)) {
        try {
          const r = adapter.convert(m, { path: fixture });
          // Whatever survived still chains.
          buildChain(r.sessionId, r.drafts);
          fine++;
        } catch (err) {
          expect(
            acceptable(err),
            `${adapter.name}: ${(err as Error).constructor.name}: ${(err as Error).message}`,
          ).toBe(true);
          errors++;
        }
      }
      expect(fine).toBeGreaterThan(0);
      // Not every adapter refuses anything (some count every problem); either way the loop ran.
      expect(fine + errors).toBe(300);
    });
  }
});
