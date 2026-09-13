/**
 * `agit export --markdown`: the audit report that drops into a PR body. The
 * two things such a report cannot get wrong — the numbers, and letting the
 * log write its own structure — are pinned here against the CLI and
 * against hand-built chains.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgitEvent, DraftEvent, SessionMeta } from "../src/format/events.js";
import { buildChain } from "../src/format/hash.js";
import { toMarkdown } from "../src/interop.js";
import { loadPrivateKey, signHead, SIGNATURE_PAYLOAD_VERSION } from "../src/sign.js";
import { readSessionMeta } from "../src/store.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const DEMO_ID = "demo-ratelimit-0001";
const CLI = join(ROOT, "dist", "cli.js");
const T = "2026-09-06T09:00:00.000Z";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-export-md-"));

function agit(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const chain = (id: string, drafts: DraftEvent[]): AgitEvent[] => buildChain(id, drafts);

describe("agit export --markdown", () => {
  it("reports the totals stats reports, all four counts, and what the store established", () => {
    const dir = mktemp();
    expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
    const r = agit(["export", DEMO_ID, "--markdown", "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    const md = r.out;
    expect(md).toContain("# Session audit: `demo-ratelimit-0001`");
    expect(md).toContain("- **Runtime**: `claude-code` `2.1.260`");
    // The numbers `agit stats` prints for this fixture, cache counts included.
    expect(md).toContain("- **Input tokens**: 142");
    expect(md).toContain("- **Output tokens**: 1,055");
    expect(md).toContain("- **Cache read tokens**: 160,500");
    expect(md).toContain("- **Cache creation tokens**: 2,040");
    expect(md).toContain("- **API messages**: 7");
    // Files: the same fold `show` uses — a file created then edited is "create", with its edit count.
    expect(md).toContain("| `create` | `C:\\app\\src\\ratelimit.ts` | 2 |");
    expect(md).toContain("| `modify` | `C:\\app\\src\\login.ts` | 1 |");
    expect(md).toContain("Structured edits only (SPEC §5.7)");
    // Provenance: what the store knows, stated.
    const head = readSessionMeta(dir, DEMO_ID)!.headHash;
    expect(md).toContain(`- **Head hash**: \`${head}\``);
    expect(md).toContain("- **Chain**: verified, 31 events hash-linked");
    expect(md).toContain("- **Signatures**: none (unsigned)");
    // Text is fenced, never interpolated.
    expect(md).toContain("```\nAdd rate limiting to the login endpoint");
    expect(md).toContain("### 2 · assistant · 2026-09-06T09:00:11.000Z · `claude-opus-5`");
    expect(md).toContain("Thinking:\n\n```\nReproduce the failure first");
    expect(md).toContain("- **4 tool call** `Bash`");
    expect(md).toContain("- **10 file create** `C:\\app\\src\\ratelimit.ts`");
  });

  it("takes the gates the other views take: unverified refused, unredacted refused, one format at a time", () => {
    const dir = mktemp();
    expect(agit(["import", DEMO, "--no-redact", "--dir", dir]).code).toBe(0);
    const unredacted = agit(["export", DEMO_ID, "--markdown", "--dir", dir]);
    expect(unredacted.code).toBe(1);
    expect(unredacted.out).toContain("--allow-unredacted");
    expect(agit(["export", DEMO_ID, "--markdown", "--allow-unredacted", "--dir", dir]).code).toBe(0);
    expect(agit(["export", DEMO_ID, "--markdown", "--otel", "--dir", dir]).code).toBe(2);

    // Tamper with the stored log: the chain no longer verifies, and no report is written.
    const log = join(dir, ".agit", "sessions", DEMO_ID, "events.jsonl");
    writeFileSync(log, readFileSync(log, "utf8").replace("flood test", "flood tset"), "utf8");
    const tampered = agit(["export", DEMO_ID, "--markdown", "--allow-unredacted", "--dir", dir]);
    expect(tampered.code).toBe(1);
    expect(tampered.out).toContain("refusing to export");
    expect(tampered.out).not.toContain("# Session audit");
  });

  it("does not accept a shorthand flag that no other view has", () => {
    const dir = mktemp();
    expect(agit(["import", DEMO, "--dir", dir]).code).toBe(0);
    const r = agit(["export", DEMO_ID, "--md", "--dir", dir]);
    expect(r.out).not.toContain("# Session audit");
  });
});

describe("the log cannot write its own structure into the report", () => {
  const events = chain("hostile-0001", [
    { ts: T, type: "session.start", payload: { runtime: "x", runtimeVersion: null, cwd: "/w" } },
    {
      ts: T,
      type: "message.user",
      payload: {
        text: "# AUDIT PASSED\n\n![pixel](https://evil.example/p.png)\n```\nescaped?\n```\n````\nfour",
      },
    },
    {
      ts: T,
      type: "message.assistant",
      payload: { model: "m`x", blocks: [{ type: "text", text: "`tick` start" }] },
    },
    {
      ts: T,
      type: "tool.call",
      payload: { toolUseId: "t1", name: "Bash` [link](https://evil.example)", input: {} },
    },
    { ts: T, type: "tool.result", payload: { toolUseId: "t1", isError: true, output: "boom" } },
    {
      ts: T,
      type: "file.diff",
      payload: {
        toolUseId: "t1",
        path: "src/a|b`c.ts",
        kind: "create",
        diff: "--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x\n",
        beforeHash: null,
        afterHash: "0".repeat(64),
      },
    },
  ]);
  const md = toMarkdown(events, null);

  it("fences message bodies with a fence longer than any backtick run inside", () => {
    // Four backticks inside means a five-backtick fence around.
    expect(md).toContain("`````\n# AUDIT PASSED");
    expect(md).toContain("four\n`````");
    // The whole body sits inside that fence: the heading, the image and the
    // three- and four-backtick runs are text, not structure.
    expect(md).toContain(
      "`````\n# AUDIT PASSED\n\n![pixel](https://evil.example/p.png)\n```\nescaped?\n```\n````\nfour\n`````",
    );
    expect(md.slice(0, md.indexOf("## Timeline"))).not.toContain("AUDIT PASSED");
  });

  it("keeps names, models and paths inside inline code whatever they hold", () => {
    expect(md).toContain("- **3 tool call** ``Bash` [link](https://evil.example)``");
    expect(md).toContain("```\n`tick` start\n```");
    expect(md).toContain("· ``m`x``");
    // A pipe in a path cannot end the table cell; a backtick cannot end the code span.
    expect(md).toContain("| `create` | ``src/a\\|b`c.ts`` | 1 |");
    expect(md).toContain("- **4 tool result** error");
  });

  it("states a signature's verdict rather than its presence", () => {
    const key = loadPrivateKey(
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    );
    const head = {
      sessionId: "hostile-0001",
      headHash: events[events.length - 1]!.hash,
      eventCount: events.length,
    };
    const meta = (signatures: SessionMeta["signatures"]): SessionMeta => ({
      agitSchema: 1,
      sessionId: "hostile-0001",
      adapter: { name: "x", version: "0" },
      importedAt: T,
      source: { path: "x", sha256: "0".repeat(64), bytes: 0, records: 0 },
      skipped: {},
      redactions: {},
      eventCount: head.eventCount,
      headHash: head.headHash,
      signatures,
    });
    const good = signHead(key, { agitSignature: SIGNATURE_PAYLOAD_VERSION, ...head, at: T });
    const stale = signHead(key, {
      agitSignature: SIGNATURE_PAYLOAD_VERSION,
      ...head,
      headHash: "b".repeat(64),
      at: T,
    });
    expect(toMarkdown(events, meta([good]))).toContain(
      `- **Signature**: verifies — key \`${key.fingerprint}\` at ${T}`,
    );
    expect(toMarkdown(events, meta([stale]))).toContain("- **Signature**: DOES NOT MATCH — key");
  });
});
