import { describe, expect, it } from "vitest";
import type { AgitEvent } from "../src/format/events.js";
import { renderSessionHtml } from "../src/html.js";

function event(seq: number, type: AgitEvent["type"], payload: AgitEvent["payload"]): AgitEvent {
  return {
    v: 1,
    seq,
    ts: `2026-01-01T00:00:0${seq}.000Z`,
    session: "test-session",
    type,
    payload,
    prev: seq === 0 ? null : `prev-${seq}`,
    hash: `hash-${seq}`,
  };
}

describe("renderSessionHtml", () => {
  it("renders a self-contained HTML session viewer", () => {
    const events = [
      event(0, "session.start", {
        runtime: "claude",
        runtimeVersion: "1.0",
        cwd: "/tmp/project",
      }),
      event(1, "message.user", {
        text: "Hello",
      }),
    ];

    const html = renderSessionHtml(events);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("agit · session");
    expect(html).toContain("session-data");
    expect(html).toContain("session.start");
    expect(html).toContain("Hello");

    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toContain("connect-src 'none'");
  });

  it("safely embeds script-like session content", () => {
    const malicious = "</script><script>alert('owned')</script>";

    const html = renderSessionHtml([
      event(0, "message.user", {
        text: malicious,
      }),
    ]);

    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).toContain("\\u003cscript\\u003e");
  });

  it("safely handles single quotes in session content", () => {
    const html = renderSessionHtml([
      event(0, "message.user", {
        text: "it's safe; don't break the viewer",
      }),
    ]);

    expect(html).toContain("application/json");
    expect(html).toContain("it's safe; don't break the viewer");
    expect(html).not.toContain("JSON.parse('");
  });

  it("renders untrusted content with textContent rather than innerHTML", () => {
    const html = renderSessionHtml([
      event(0, "message.user", {
        text: "<img src=x onerror=alert(1)>",
      }),
    ]);

    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("\\u003cimg");
  });

  it("is deterministic for identical input", () => {
    const events = [
      event(0, "session.start", {
        runtime: "claude",
      }),
      event(1, "message.assistant", {
        blocks: [{ type: "text", text: "Done" }],
      }),
    ];

    const meta = {
      agitSchema: 1,
      sessionId: "test-session",
      adapter: {
        name: "test",
        version: "1.0.0",
      },
      importedAt: "2026-01-01T00:00:00.000Z",
      source: {
        path: "/tmp/session.jsonl",
        sha256: "abc",
        bytes: 123,
        records: 2,
      },
      skipped: {},
      redactions: {},
      eventCount: 2,
      headHash: "hash-1",
    };

    expect(renderSessionHtml(events, meta)).toBe(renderSessionHtml(events, meta));
  });

  it("emits a viewer script that actually parses", () => {
    // The bug this guards: the page is built from one template literal, so a
    // newline escape written inside a JS string there becomes a real line
    // break in the emitted script, splitting the string. The HTML still
    // *contains* every expected substring, so string assertions pass while
    // the exported page throws SyntaxError and renders nothing at all.
    const html = renderSessionHtml(
      [
        event(0, "session.start", { runtime: "claude", runtimeVersion: "1.0", cwd: "/tmp/p" }),
        event(1, "message.user", { text: "Hello" }),
        event(2, "file.diff", {
          path: "a.ts",
          kind: "modify",
          diff: ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-x", "+y", ""].join("\n"),
          beforeHash: "b",
          afterHash: "a",
        }),
      ],
      null,
    );
    const scripts = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, body] of scripts) {
      expect(() => new Function(body!)).not.toThrow();
    }
  });

  it("keeps newline escapes intact in the emitted script", () => {
    const html = renderSessionHtml(
      [
        event(0, "session.start", { runtime: "claude", runtimeVersion: "1.0", cwd: "/tmp/p" }),
        event(1, "message.user", { text: "Hello" }),
        event(2, "file.diff", {
          path: "a.ts",
          kind: "modify",
          diff: ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-x", "+y", ""].join("\n"),
          beforeHash: "b",
          afterHash: "a",
        }),
      ],
      null,
    );
    const script = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]!)
      .join("\n");
    // A double-quoted string must never span a raw line break, which is what
    // an unescaped newline inside the page template produces.
    for (const line of script.split("\n")) {
      const quotes = (line.match(/(?<!\\)"/g) ?? []).length;
      expect(quotes % 2, `unbalanced quotes: ${line.trim().slice(0, 70)}`).toBe(0);
    }
  });

  it("includes a search box, a type filter and a match count in the navbar", () => {
    const html = renderSessionHtml([event(0, "session.start", { runtime: "claude" })]);
    expect(html).toContain('id="searchBox"');
    expect(html).toContain('id="typeFilter"');
    expect(html).toContain('id="matchCount"');
    // Wired up, not just markup: the filter functions and their listeners exist.
    expect(html).toContain("function applyFilter()");
    expect(html).toContain("function populateTypeFilter()");
    expect(html).toContain("function jumpToMatch(");
    expect(html).toContain('searchBox.addEventListener("input", applyFilter)');
    expect(html).toContain('typeFilter.addEventListener("change", applyFilter)');
  });

  it("embeds related sessions (a spawned subagent, or the parent that spawned this one)", () => {
    const parentEvents = [
      event(0, "session.start", { runtime: "claude" }),
      event(1, "message.user", { text: "hi" }),
    ];
    const subEvents = [
      {
        ...event(0, "session.start", { runtime: "claude", native: { parentSessionId: "test-session" } }),
        session: "sub-1",
      },
    ];
    const html = renderSessionHtml(parentEvents, null, {
      "sub-1": { events: subEvents, meta: null },
    });
    expect(html).toContain('"sub-1"');
    expect(html).toContain("parentSessionId");
  });
});
