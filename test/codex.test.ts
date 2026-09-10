import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { canonicalJson } from "../src/format/canonical.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { verifyChain } from "../src/format/verify.js";
import type { DraftEvent, Json } from "../src/format/events.js";
import { reconstructTree } from "../src/fork.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const codexLines = readFileSync(join(ROOT, "fixtures", "codex", "simple.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const claudeLines = readFileSync(join(ROOT, "fixtures", "claude-code", "simple.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const editLines = readFileSync(join(ROOT, "fixtures", "codex", "edits.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const payloadOf = (drafts: DraftEvent[], i: number): { [k: string]: Json } =>
  drafts[i]!.payload as { [k: string]: Json };

describe("codex adapter", () => {
  it("detects codex rollouts, and the two adapters never claim each other's files", () => {
    expect(codexAdapter.detect(codexLines)).toBe(true);
    expect(codexAdapter.detect(claudeLines)).toBe(false);
    expect(claudeCodeAdapter.detect(codexLines)).toBe(false);
    expect(codexAdapter.detect(["not json", "{}"])).toBe(false);
  });

  it("maps the fixture to the expected event sequence", () => {
    const res = codexAdapter.convert(codexLines);
    expect(res.sessionId).toBe("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001");
    expect(res.records).toBe(17);
    expect(res.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "tool.call", // exec (custom_tool_call)
      "tool.result",
      "cost",
      "message.assistant", // reasoning summary -> thinking block
      "tool.call", // shell (function_call)
      "tool.result",
      "cost",
      "message.assistant", // the canonical assistant message
      "session.end",
    ]);
  });

  it("skips scaffolding and duplicates, and counts every one", () => {
    const res = codexAdapter.convert(codexLines);
    expect(res.skipped).toEqual({
      "response_item:message(developer)": 1,
      "response_item:message(user)": 1,
      turn_context: 1,
      "event_msg:task_started": 1,
      "response_item:reasoning(encrypted)": 1,
      "event_msg:agent_message": 1,
      "event_msg:task_complete": 1,
    });
    // The duplicated assistant text appears exactly once in the events.
    const texts = JSON.stringify(res.drafts);
    expect(texts.split("suite is green").length - 1).toBe(1);
  });

  it("bills costs to the turn_context model and uses per-response deltas", () => {
    const res = codexAdapter.convert(codexLines);
    const costs = res.drafts.filter((d) => d.type === "cost").map((d) => d.payload as { [k: string]: Json });
    expect(costs).toHaveLength(2);
    expect(costs[0]!.model).toBe("gpt-5.5");
    expect(costs[1]!.usage).toEqual({
      inputTokens: 1200, // last_token_usage, not the cumulative total
      outputTokens: 55,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });
  });

  it("parses function_call arguments and wraps custom_tool_call input", () => {
    const res = codexAdapter.convert(codexLines);
    const calls = res.drafts
      .filter((d) => d.type === "tool.call")
      .map((d) => d.payload as { [k: string]: Json });
    expect(calls[0]!.name).toBe("exec");
    expect(calls[0]!.input).toEqual({ input: "grep -rn discount src/ | head -5\n" });
    expect(calls[1]!.name).toBe("shell");
    expect(calls[1]!.input).toEqual({ command: ["npx", "vitest", "run"], timeout_ms: 120000 });
    // Results pair by call_id and handle both output shapes (array and string).
    const results = res.drafts
      .filter((d) => d.type === "tool.result")
      .map((d) => d.payload as { [k: string]: Json });
    expect(results[0]!.toolUseId).toBe("call_alpha001");
    expect(results[0]!.output).toContain("discunt(total: number)");
    expect(results[1]!.output).toBe("Exit code: 0\nTests 3 passed (3)");
  });

  it("keeps a reasoning summary as a thinking block and drops encrypted-only reasoning", () => {
    const res = codexAdapter.convert(codexLines);
    const thinking = res.drafts.filter(
      (d) => d.type === "message.assistant" && JSON.stringify(d.payload).includes('"thinking"'),
    );
    expect(thinking).toHaveLength(1);
    expect(JSON.stringify(thinking[0]!.payload)).toContain("misspelled");
    expect(JSON.stringify(res.drafts)).not.toContain("gAAAAAB");
  });

  it("is deterministic and chains into a verifiable log", () => {
    const a = codexAdapter.convert(codexLines);
    const b = codexAdapter.convert(codexLines);
    const jsonlA = toJsonl(buildChain(a.sessionId, a.drafts));
    expect(jsonlA).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    expect(verifyChain(jsonlA.trimEnd().split("\n")).ok).toBe(true);
  });

  it("live mode is prefix-stable: every longer read strictly extends every shorter one", () => {
    const liveDrafts = (k: number): string[] => {
      try {
        return codexAdapter
          .convert(codexLines.slice(0, k), { live: true })
          .drafts.map((d) => canonicalJson(d));
      } catch {
        return []; // no session_meta yet
      }
    };
    let prev: string[] = [];
    for (let k = 1; k <= codexLines.length; k++) {
      const now = liveDrafts(k);
      expect(now.length).toBeGreaterThanOrEqual(prev.length);
      expect(now.slice(0, prev.length)).toEqual(prev);
      prev = now;
    }
    const live = codexAdapter.convert(codexLines, { live: true }).drafts;
    const full = codexAdapter.convert(codexLines).drafts;
    expect(full.length).toBe(live.length + 1); // only the synthesized session.end
    expect(payloadOf(full, full.length - 1).reason).toBe("log-end");
  });

  it("skip-counts non-object JSON lines instead of crashing", () => {
    const res = codexAdapter.convert([codexLines[0]!, "null", "[]", '"str"', ...codexLines.slice(1)]);
    expect(res.skipped["<non-object>"]).toBe(3);
    expect(res.drafts.length).toBeGreaterThan(0);
  });

  it("refuses a file with no session_meta", () => {
    expect(() => codexAdapter.convert(codexLines.slice(1))).toThrow(/session_meta/);
  });

  it("emits verified file.diff events from structured patches", () => {
    const res = codexAdapter.convert(editLines);
    const diffs = res.drafts
      .filter((d) => d.type === "file.diff")
      .map((d) => d.payload as { [k: string]: Json });

    const ADDED = 'def main():\n    print("hi")\n';
    const UPDATED = 'def main():\n    print("hello there")\n';

    // Add: full content is recorded, so the create is exactly hashable.
    const create = diffs[0]!;
    expect(create).toMatchObject({
      path: "C:\\work\\app\\hello.py",
      kind: "create",
      beforeHash: null,
      afterHash: sha(ADDED),
      source: "apply_patch",
      toolUseId: "call_add1",
    });
    expect(create.diff).toContain("--- /dev/null");
    expect(create.diff).toContain('+    print("hi")');

    // Update: the base is known from the create, so both hashes are real and
    // the chain links — this is the property fork depends on.
    const modify = diffs[1]!;
    expect(modify).toMatchObject({
      path: "C:\\work\\app\\hello.py",
      kind: "modify",
      beforeHash: sha(ADDED),
      afterHash: sha(UPDATED),
    });
    expect(modify.beforeHash).toBe(create.afterHash);
    // The runtime's own unified diff is kept verbatim, not re-synthesized.
    expect(modify.diff).toContain('+    print("hello there")');

    // Paginated history mode delivers the same data as a FileChange turn item.
    const notes = diffs.find((d) => String(d.path).endsWith("notes.md"))!;
    expect(notes).toMatchObject({ kind: "create", afterHash: sha("# notes\n\n- shipped\n") });
  });

  it("emits a verified file.delete when prior content is known", () => {
    const content = "hello\n";

    const lines = [
      JSON.stringify({
        timestamp: "2026-09-08T11:00:01.000Z",
        type: "session_meta",
        payload: {
          id: "0199delete-0000-7aaa-8bbb-ccccdddd0001",
          timestamp: "2026-09-08T11:00:00.000Z",
          cwd: "C:\\work\\app",
          originator: "Codex CLI",
          cli_version: "0.142.0",
          source: "terminal",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-08T11:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call_add",
          turn_id: "turn-1",
          success: true,
          changes: {
            "C:\\work\\app\\hello.py": {
              type: "add",
              content,
            },
          },
          status: "completed",
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-08T11:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call_delete",
          turn_id: "turn-1",
          success: true,
          changes: {
            "C:\\work\\app\\hello.py": {
              type: "delete",
              content,
            },
          },
          status: "completed",
        },
      }),
    ];

    const res = codexAdapter.convert(lines);
    const deletes = res.drafts.filter((d) => d.type === "file.delete");

    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({
      type: "file.delete",
      payload: {
        path: "C:\\work\\app\\hello.py",
        beforeHash: sha(content),
        toolUseId: "call_delete",
        source: "apply_patch",
      },
    });
  });

  it("records a rename as the filesystem saw it: old path deleted, new one created", () => {
    // Before schema v2 this was skipped -- two paths and no event type that
    // said one became the other. Mirrors the OpenClaw mapping (#52).
    const res = codexAdapter.convert(editLines);
    const fileEvents = res.drafts
      .filter((d) => d.type === "file.diff" || d.type === "file.delete")
      .map((d) => [
        d.type,
        String((d.payload as { path: Json }).path)
          .split("\\")
          .pop(),
      ]);
    const at = fileEvents.findIndex(([, name]) => name === "renamed.py");
    expect(at).toBeGreaterThan(0);
    expect(fileEvents[at - 1]).toEqual(["file.delete", "hello.py"]);
    expect(fileEvents[at]).toEqual(["file.diff", "renamed.py"]);
  });

  it("hashes both sides of a rename against real content", () => {
    const res = codexAdapter.convert(editLines);
    const before = 'def main():\n    print("hello there")\n';
    const after = 'def main():\n    print("renamed")\n';

    const del = res.drafts.find(
      (d) => d.type === "file.delete" && String((d.payload as { path: Json }).path).endsWith("hello.py"),
    )!;
    expect((del.payload as Record<string, Json>).beforeHash).toBe(sha(before));

    const created = res.drafts.find(
      (d) => d.type === "file.diff" && String((d.payload as { path: Json }).path).endsWith("renamed.py"),
    )!;
    const p = created.payload as Record<string, Json>;
    // The destination is new, so it is a create: no prior content at that path.
    expect(p.kind).toBe("create");
    expect(p.beforeHash).toBeNull();
    expect(p.afterHash).toBe(sha(after));
    expect(p.source).toBe("apply_patch");
  });

  it("skips a rename whose base predates the session rather than guessing", () => {
    const res = codexAdapter.convert(editLines);
    expect(res.skipped["patch_apply:update(rename, base content not in log)"]).toBe(1);
    const paths = res.drafts
      .filter((d) => d.type === "file.diff" || d.type === "file.delete")
      .map((d) => String((d.payload as { path: Json }).path));
    expect(paths.some((x) => x.endsWith("legacy.py"))).toBe(false);
    expect(paths.some((x) => x.endsWith("legacy2.py"))).toBe(false);
  });

  it("orders a multi-file patch by path so imports stay byte-identical", () => {
    // Rust serializes `changes` from a HashMap; its order is not stable, and
    // the fixture deliberately lists z, a, m in that order.
    const res = codexAdapter.convert(editLines);
    const singles = res.drafts
      .filter((d) => d.type === "file.diff")
      .map((d) => String((d.payload as { path: Json }).path))
      .filter((p) => /\\[amz]\.py$/.test(p));
    expect(singles).toEqual(["C:\\work\\app\\a.py", "C:\\work\\app\\m.py", "C:\\work\\app\\z.py"]);
  });

  it("skips every change it cannot verify, and says why", () => {
    const res = codexAdapter.convert(editLines);
    expect(res.skipped).toMatchObject({
      // Codex records only the diff for a file that predates the session.
      "patch_apply:update(base content not in log)": 1,
      // Nothing reached disk for these two.
      "patch_apply:failed": 1,
      "patch_apply:declined": 1,
      // A rename whose base predates the session: neither path has content
      // we could hash, so that one is still skipped.
      "patch_apply:update(rename, base content not in log)": 1,
      // Malformed and partial payloads, counted rather than guessed at.
      "patch_apply:add(no content)": 1,
      "patch_apply:update(no diff)": 1,
      "patch_apply:malformed change": 1,
      "patch_apply:teleport": 1,
      "patch_apply:no changes": 1,
      // Our reconstruction and the runtime's diff disagreed.
      "patch_apply:update(diff did not apply)": 1,
    });
    // None of those produced an event.
    const paths = res.drafts
      .filter((d) => d.type === "file.diff")
      .map((d) => String((d.payload as { path: Json }).path));
    expect(paths.some((p) => p.endsWith("existing.py"))).toBe(false);
    expect(paths.some((p) => p.endsWith("obsolete.py"))).toBe(false);
    expect(paths.some((p) => p.endsWith("legacy2.py"))).toBe(false);
  });

  it("a failed patch does not poison the content chain for later updates", () => {
    // call_fail and call_drift both target hello.py; neither may change what
    // agit believes hello.py contains.
    const res = codexAdapter.convert(editLines);
    const hello = res.drafts
      .filter((d) => d.type === "file.diff")
      .map((d) => d.payload as { [k: string]: Json })
      .filter((p) => String(p.path).endsWith("hello.py"));
    expect(hello).toHaveLength(2);
    expect(hello[1]!.afterHash).toBe(sha('def main():\n    print("hello there")\n'));
  });

  it("file.diff payloads match the Claude Code adapter's shape exactly", () => {
    const codexDiff = codexAdapter.convert(editLines).drafts.find((d) => d.type === "file.diff")!
      .payload as Record<string, Json>;
    const claudeDiff = claudeCodeAdapter.convert(claudeLines).drafts.find((d) => d.type === "file.diff")!
      .payload as Record<string, Json>;
    expect(Object.keys(codexDiff).sort()).toEqual(Object.keys(claudeDiff).sort());
  });

  it("the edits fixture is deterministic and chains into a verifiable log", () => {
    const a = codexAdapter.convert(editLines);
    const b = codexAdapter.convert(editLines);
    const jsonl = toJsonl(buildChain(a.sessionId, a.drafts));
    expect(jsonl).toBe(toJsonl(buildChain(b.sessionId, b.drafts)));
    expect(verifyChain(jsonl.trimEnd().split("\n")).ok).toBe(true);
  });

  it("reconstructs a working tree from a Codex session (what fork needs)", () => {
    const res = codexAdapter.convert(editLines);
    const events = buildChain(res.sessionId, res.drafts);
    const { files, skipped } = reconstructTree(events, events.length - 1);
    expect(skipped).toEqual([]);
    const byName = Object.fromEntries(files.map((f) => [f.path.split("\\").pop(), f.content]));
    // hello.py was renamed to renamed.py, so the replayed tree holds the
    // destination and not the source -- what the filesystem actually saw.
    expect(byName["renamed.py"]).toBe('def main():\n    print("renamed")\n');
    expect(byName["hello.py"]).toBeUndefined();
    expect(byName["notes.md"]).toBe("# notes\n\n- shipped\n");
    expect(Object.keys(byName).sort()).toEqual(["a.py", "m.py", "notes.md", "renamed.py", "z.py"]);
  });

  it("session.start carries provenance", () => {
    const res = codexAdapter.convert(codexLines);
    expect(payloadOf(res.drafts, 0)).toMatchObject({
      runtime: "codex",
      runtimeVersion: "0.142.0",
      nativeSessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
      cwd: "C:\\work\\shop",
    });
  });
});
