import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");
const CODEX = join(ROOT, "fixtures", "codex", "edits.jsonl");
const SUBAGENT_PARENT = join(ROOT, "fixtures", "claude-code", "subagent-parent.jsonl");
const SUBAGENT_CHILD = join(ROOT, "fixtures", "claude-code", "subagent-child.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function storeWith(...fixtures: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agit-hyg-"));
  for (const f of fixtures) expect(agit(["import", f, "--dir", dir]).code).toBe(0);
  return dir;
}

describe("grep flags are validated (#57)", () => {
  it("an unknown --type is an error that lists the real ones, not an empty result", () => {
    const store = storeWith(DEMO);
    const r = agit(["grep", "command", "--type", "tool.cal", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('unknown event type "tool.cal"');
    expect(r.out).toContain("tool.call");
    expect(r.out).toContain("file.delete");
  });

  it("--path with a --type that is not a file event is a contradiction", () => {
    const store = storeWith(DEMO);
    const r = agit(["grep", "ratelimit", "--path", "--type", "tool.call", "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("cannot combine with --type tool.call");
    expect(agit(["grep", "ratelimit", "--path", "--type", "file.diff", "--dir", store]).code).toBe(0);
  });
});

describe("range and directory handling (#58)", () => {
  it("replay --at outside the session is refused like fork, not clamped", () => {
    const store = storeWith(DEMO);
    for (const at of ["999", "-1"]) {
      const r = agit(["replay", "demo", "--at", at, "--state", "--dir", store]);
      expect(r.code, at).toBe(2);
      expect(r.out).toContain(`--at ${at} is outside this session (0..30)`);
    }
    expect(agit(["replay", "demo", "--at", "30", "--state", "--dir", store]).code).toBe(0);
  });

  it("a --dir that does not exist is named, not reported as an empty store", () => {
    const missing = join(tmpdir(), "agit-does-not-exist-" + Date.now());
    const ls = agit(["ls", "--dir", missing]);
    expect(ls.code).toBe(1);
    expect(ls.out).toContain(`no such directory: ${missing}`);
    const show = agit(["show", "demo", "--dir", missing]);
    expect(show.code).toBe(1);
    expect(show.out).toContain("no such directory");
  });

  it("help lays the grep line out inside the column", () => {
    const help = agit(["help"]).out;
    const line = help.split("\n").find((l) => l.includes("agit grep <pattern>"))!;
    expect(line).toMatch(/^ {2}agit grep <pattern> {2,}search every imported session/);
  });
});

describe("show --by-model on a Codex session (#56)", () => {
  it("credits the edits to the only model named, even though it is named after them", () => {
    const store = storeWith(CODEX);
    const r = agit(["show", "0199", "--by-model", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("(unattributed)");
    // The fixture records no cost events, so tokens cannot be split — say so.
    // Six paths, not five, since the fixture's rename now lands its
    // destination as a file of its own (#86).
    expect(r.out).toMatch(/no cost events in this session — 6 files touched, credited to gpt-5\.5/);
  });
});

describe("show --by-model table", () => {
  it("prints every column, in order", () => {
    const store = storeWith(DEMO);
    const r = agit(["show", "demo", "--by-model", "--dir", store]);
    expect(r.code).toBe(0);
    const header = r.out.split("\n").find((l) => l.includes("MODEL"));
    expect(
      header
        ?.trim()
        .split(/\s{2,}/)
        .map((s) => s.trim()),
    ).toEqual(["MODEL", "CALLS", "IN", "OUT", "CACHE READ", "FILES"]);
  });
});

describe("export-html --at and size (#59)", () => {
  it("exports a prefix, names it, and reports the size", () => {
    const store = storeWith(DEMO);
    const out = join(store, "prefix.html");
    const r = agit(["export-html", "demo", "--at", "10", "--out", out, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/11 events \(of 31, up to --at 10\), \d+\.\d MB/);
    const html = readFileSync(out, "utf8");
    expect(html).toContain('"seq":10,');
    expect(html).not.toContain('"seq":11,');
  });

  it("refuses --at outside the session", () => {
    const store = storeWith(DEMO);
    const r = agit(["export-html", "demo", "--at", "99", "--out", join(store, "x.html"), "--dir", store]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--at 99 is outside this session");
  });

  it("refuses to overwrite an existing --out, unless --force is passed", () => {
    const store = storeWith(DEMO);
    const out = join(store, "again.html");
    expect(agit(["export-html", "demo", "--out", out, "--dir", store]).code).toBe(0);

    const again = agit(["export-html", "demo", "--out", out, "--dir", store]);
    expect(again.code).toBe(1);
    expect(again.out).toContain("refusing to overwrite existing");
    expect(again.out).toContain("--force");

    const forced = agit(["export-html", "demo", "--out", out, "--dir", store, "--force"]);
    expect(forced.code).toBe(0);
  });
});

describe("export-html and show link a spawned subagent to its parent", () => {
  function pairStore(): string {
    const dir = mkdtempSync(join(tmpdir(), "agit-hyg-"));
    expect(agit(["import", SUBAGENT_PARENT, "--dir", dir]).code).toBe(0);
    expect(agit(["import", SUBAGENT_CHILD, "--dir", dir]).code).toBe(0);
    return dir;
  }

  it("agit show names the parent from the subagent, and the subagent from the parent", () => {
    const store = pairStore();

    const child = agit(["show", "fixture-child-agent-01", "--dir", store]);
    expect(child.code).toBe(0);
    expect(child.out).toContain("parent      fixture-parent-0001");

    const parent = agit(["show", "fixture-parent-0001", "--dir", store]);
    expect(parent.code).toBe(0);
    expect(parent.out).toContain("spawned     1 subagent:");
    expect(parent.out).toContain("fixture-child-agent-01");
  });

  it("a full export embeds the linked subagent so the viewer can navigate to it", () => {
    const store = pairStore();
    const out = join(store, "parent.html");
    const r = agit(["export-html", "fixture-parent-0001", "--out", out, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("related     1 linked session embedded");

    const html = readFileSync(out, "utf8");
    const data = JSON.parse(
      html.match(/<script type="application\/json" id="session-data">([\s\S]*?)<\/script>/)![1]!,
    );
    expect(Object.keys(data.related)).toEqual(["fixture-child-agent-01"]);
  });

  it("a --at prefix export embeds no related sessions — only a full export claims the family", () => {
    const store = pairStore();
    const out = join(store, "prefix.html");
    const r = agit(["export-html", "fixture-parent-0001", "--at", "1", "--out", out, "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("related");

    const html = readFileSync(out, "utf8");
    const data = JSON.parse(
      html.match(/<script type="application\/json" id="session-data">([\s\S]*?)<\/script>/)![1]!,
    );
    expect(data.related).toEqual({});
  });
});

describe("fork explains a redacted file honestly (#55)", () => {
  it("names redaction as the reason the file could not be rebuilt", () => {
    // A credential inside file content: redacted on import, so the recorded
    // hash can never be reproduced from what the store holds.
    const key = "sk-ant-api03-" + "Q".repeat(95);
    const log = readFileSync(DEMO, "utf8").replace(/WINDOW/g, `WINDOW_X; const K = \\"${key}\\"`);
    const dir = mkdtempSync(join(tmpdir(), "agit-hyg-secret-"));
    const native = join(dir, "secret.jsonl");
    writeFileSync(native, log, "utf8");
    const store = storeWith(native);
    const r = agit(["fork", "demo", "--at", "24", "--out", join(store, "fk"), "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ratelimit.ts");
    expect(r.out).toContain("content was redacted on import, so its recorded hash cannot be reproduced");
    expect(r.out).not.toContain("with no recorded originalFile");
  });
});
