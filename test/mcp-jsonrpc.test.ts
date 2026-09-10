import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { handleMessage, type JsonRpcResponse } from "../src/mcp.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(ROOT, "fixtures", "claude-code", "demo.jsonl");

let store: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "agit-mcp-rpc-"));
  const r = spawnSync(process.execPath, [CLI, "import", DEMO, "--dir", store], { encoding: "utf8" });
  expect(r.status).toBe(0);
});

const send = (msg: unknown): JsonRpcResponse | null => handleMessage(store, msg);

describe("notifications get no reply", () => {
  // JSON-RPC 2.0: "The Server MUST NOT reply to a Notification." Only the two
  // notifications/* methods honoured that; every other method answered an
  // id-less request with an unsolicited `id: null` response.
  it.each([
    ["ping", { jsonrpc: "2.0", method: "ping" }],
    ["tools/list", { jsonrpc: "2.0", method: "tools/list" }],
    ["initialize", { jsonrpc: "2.0", method: "initialize" }],
    ["tools/call", { jsonrpc: "2.0", method: "tools/call", params: { name: "agit_list" } }],
    ["an unknown method", { jsonrpc: "2.0", method: "nope" }],
    ["notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" }],
  ])("a notification to %s is answered with silence", (_name, msg) => {
    expect(send(msg)).toBeNull();
  });

  it("a request carrying an id always gets a response, id included", () => {
    for (const method of ["ping", "tools/list", "initialize", "notifications/initialized"]) {
      const r = send({ jsonrpc: "2.0", id: 7, method });
      expect(r, `${method} should answer a request`).not.toBeNull();
      expect(r!.id).toBe(7);
    }
  });

  it("id 0 is an id, not a missing one", () => {
    const r = send({ jsonrpc: "2.0", id: 0, method: "ping" });
    expect(r).not.toBeNull();
    expect(r!.id).toBe(0);
  });
});

describe("malformed messages are refused, not swallowed", () => {
  // Both a notification and a malformed message lack an id. Treating them
  // alike left a client that sent something invalid waiting forever.
  it.each([
    ["a batch array", [{ jsonrpc: "2.0", id: 1, method: "ping" }]],
    ["a string", "oops"],
    ["a number", 42],
    ["null", null],
    ["an empty object", {}],
    ["a request with no jsonrpc", { id: 1, method: "ping" }],
    ["a request with no method", { jsonrpc: "2.0", id: 1 }],
  ])("%s gets an Invalid Request error", (_name, msg) => {
    const r = send(msg);
    expect(r).not.toBeNull();
    expect(r!.error?.code).toBe(-32600);
  });

  it("keeps the id when the malformed message had one", () => {
    expect(send({ id: 3, method: "ping" })!.id).toBe(3);
  });

  it("uses a null id when there is none to use", () => {
    expect(send(null)!.id).toBeNull();
    expect(send([])!.id).toBeNull();
  });
});

describe("the server survives what a client sends it", () => {
  /** Feed lines to a real `agit mcp` over stdio and collect the replies. */
  function converse(lines: string[]): { code: number; out: string; replies: JsonRpcResponse[] } {
    const r = spawnSync(process.execPath, [CLI, "mcp", "--dir", store], {
      encoding: "utf8",
      input: lines.join("\n") + "\n",
      timeout: 60_000,
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const replies = (r.stdout ?? "")
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l) as JsonRpcResponse);
    return { code: r.status ?? 1, out, replies };
  }

  it("a bare null line does not take the process down", () => {
    // `JSON.parse("null")` succeeds, so this reached handleMessage, threw,
    // and then threw again inside the catch that reads msg.id. The process
    // died and every later request on the pipe went unanswered.
    const c = converse([
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      "null",
      '{"jsonrpc":"2.0","id":2,"method":"ping"}',
    ]);
    expect(c.out).not.toContain("TypeError");
    expect(c.replies.map((r) => r.id)).toEqual([1, null, 2]);
    expect(c.replies[2]!.result).toEqual({});
  });

  it("keeps answering after a run of junk", () => {
    const c = converse(["null", "[]", '"oops"', "42", "{", "{}", '{"jsonrpc":"2.0","id":9,"method":"ping"}']);
    expect(c.out).not.toContain("TypeError");
    const last = c.replies[c.replies.length - 1]!;
    expect(last.id).toBe(9);
    expect(last.result).toEqual({});
  });

  it("still answers a real conversation", () => {
    const c = converse([
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ]);
    // The notification in the middle must not produce a reply of its own.
    expect(c.replies.map((r) => r.id)).toEqual([1, 2]);
  });
});
