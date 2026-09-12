import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchShareLog, PULL_BODY_LIMIT } from "../src/share.js";

/**
 * A relay is untrusted by the project's own rules, and `agit pull` used to
 * buffer whatever one streamed: a body that never ended grew the process
 * until the OS killed it, and a finite one past V8's string limit failed
 * with a bare "Cannot create a string longer than ..." only after every
 * byte was held. These tests stand up a relay that misbehaves in each way
 * and expect the pull to refuse with a budget it names.
 */

const open: Server[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

function hostileRelay(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  open.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const BUDGET = 1024 * 1024;

describe("agit pull bounds what it will buffer from a relay", () => {
  it("stops reading a body that never ends once the budget is spent", async () => {
    const chunk = Buffer.alloc(64 * 1024, "x");
    const base = await hostileRelay((_req, res) => {
      res.writeHead(200, { "content-type": "application/jsonl; charset=utf-8" });
      res.on("error", () => undefined);
      const pump = (): void => {
        if (res.destroyed) return;
        while (res.write(chunk)) if (res.destroyed) return;
        res.once("drain", pump);
      };
      pump();
    });
    await expect(fetchShareLog(base, "aaaaaaaaaaaa", BUDGET)).rejects.toThrow(/more than 1MB/);
  });

  it("refuses a finite body past the budget instead of a bare V8 error", async () => {
    const body = Buffer.alloc(BUDGET + 1, "x");
    const base = await hostileRelay((_req, res) => {
      // No content-length, so the client cannot refuse before reading.
      res.writeHead(200, { "content-type": "application/jsonl; charset=utf-8" });
      res.end(body);
    });
    await expect(fetchShareLog(base, "aaaaaaaaaaaa", BUDGET)).rejects.toThrow(/agit pull will not buffer/);
  });

  it("refuses up front when the relay declares a body over the budget", async () => {
    // The relay sends one byte of the body it declared and then nothing:
    // a client that waits for the bytes before deciding waits forever.
    const base = await hostileRelay((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/jsonl; charset=utf-8",
        "content-length": String(BUDGET + 1),
      });
      res.on("error", () => undefined);
      res.write("x");
    });
    await expect(fetchShareLog(base, "aaaaaaaaaaaa", BUDGET)).rejects.toThrow(/more than 1MB/);
  });

  it("the budget is well above what a relay's own limits let one push carry", () => {
    // 25MB per push, so a real share on a well-behaved relay needs several
    // pushes to come near the budget, and pull still takes it whole.
    expect(PULL_BODY_LIMIT).toBeGreaterThan(4 * 25 * 1024 * 1024);
  });
});
