/**
 * What checking the adapters against real data turned up (Einsia/agent-git's
 * MIT-published format probes, and a real opencode.db imported locally):
 * the runtime's own compaction summary must not read as something a person
 * typed, and a Hermes child session says how it relates to its parent.
 * The OpenCode side is asserted in opencode-adapter.test.ts against its
 * fixture; these cover Claude Code and Hermes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { hermesAdapter } from "../src/adapters/hermes.js";
import type { Json } from "../src/format/events.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const HERMES = join(ROOT, "fixtures", "hermes", "state.db");
const HERMES_A = "a3f9c2e1b7d04c5e8f6a1b2c3d4e5f60";
const HERMES_B = "b7e1d0c9a8f74b3e9c2d1e0f6a5b4c3d";

const linesOf = (p: string): string[] =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");

describe("a Claude Code compaction summary", () => {
  it("is a message.user marked native.compactSummary, and only that record is", () => {
    const lines = linesOf(SIMPLE);
    // The shape a compaction appends: a user record, a string body, isCompactSummary.
    const lastUser = lines
      .map((l) => JSON.parse(l) as Record<string, Json>)
      .filter((r) => r.type === "user")
      .at(-1)!;
    const summary = {
      ...lastUser,
      uuid: "compact-0001",
      parentUuid: lastUser.uuid,
      isCompactSummary: true,
      message: {
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out of context. Summary:\n- fixed the parser",
      },
    };
    const r = claudeCodeAdapter.convert([...lines, JSON.stringify(summary)]);
    const users = r.drafts
      .filter((d) => d.type === "message.user")
      .map((d) => d.payload as { text: string; native: Record<string, Json> });
    const marked = users.filter((u) => u.native.compactSummary === true);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.text.startsWith("This session is being continued")).toBe(true);
    expect(marked[0]!.native).toEqual({
      uuid: "compact-0001",
      parentUuid: lastUser.uuid,
      compactSummary: true,
    });
    // Every other prompt is untouched: no key, not even a false one.
    for (const u of users.filter((u) => u !== marked[0])) expect("compactSummary" in u.native).toBe(false);
  });
});

describe("a Hermes child session", () => {
  it("names the relation model_config marks beside parentSessionId, and a root carries none", () => {
    const bytes = new Uint8Array(readFileSync(HERMES));
    const child = hermesAdapter.convertBytes!(bytes, { select: HERMES_B });
    const start = child.drafts[0]!.payload as { native: Record<string, Json> };
    expect(start.native).toMatchObject({ parentSessionId: HERMES_A, delegatedFrom: HERMES_A });
    expect("branchedFrom" in start.native).toBe(false);
    expect("resetFrom" in start.native).toBe(false);
    const root = hermesAdapter.convertBytes!(bytes, { select: HERMES_A });
    const rootStart = root.drafts[0]!.payload as { native: Record<string, Json> };
    expect(rootStart.native.parentSessionId).toBeNull();
    for (const k of ["branchedFrom", "resetFrom", "delegatedFrom"]) expect(k in rootStart.native).toBe(false);
  });
});
