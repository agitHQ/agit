/**
 * The write-ahead log folded over the main file the way SQLite reads it:
 * a real pair copied while the writer held the WAL open (fixtures/hermes/
 * live), frames built by hand with the format's own checksum chain, the
 * sidecar over hostile bytes, and a database whose schema has not reached
 * its main file yet.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { startRelay, type RelayHandle } from "../src/relay/relay.js";
import { applyWal, readSqliteWithWal, SqliteError, SqliteFile } from "../src/sqlite.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const LIVE = join(ROOT, "fixtures", "hermes", "live", "state.db");
const MAIN = join(ROOT, "fixtures", "hermes", "state.db");
const LIVE_SID = "d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "agit-wal-"));
const read = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

function agit(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, ...env },
      }),
    };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** A WAL built by hand: header, then frames of (pageNo, commitSize, page), checksums chained as wal.c chains them. */
function buildWal(
  pageSize: number,
  frames: { pageNo: number; commit: number; page: Uint8Array }[],
  opts: { salt?: [number, number]; breakChecksumAt?: number; badSaltAt?: number } = {},
): Uint8Array {
  const [salt1, salt2] = opts.salt ?? [0x11111111, 0x22222222];
  const out = new Uint8Array(32 + frames.length * (24 + pageSize));
  const v = new DataView(out.buffer);
  let s1 = 0;
  let s2 = 0;
  const sum = (at: number, len: number): void => {
    for (let i = 0; i < len; i += 8) {
      s1 = (s1 + v.getUint32(at + i, true) + s2) >>> 0;
      s2 = (s2 + v.getUint32(at + i + 4, true) + s1) >>> 0;
    }
  };
  v.setUint32(0, 0x377f0682);
  v.setUint32(4, 3007000);
  v.setUint32(8, pageSize);
  v.setUint32(12, 1);
  v.setUint32(16, salt1);
  v.setUint32(20, salt2);
  sum(0, 24);
  v.setUint32(24, s1);
  v.setUint32(28, s2);
  frames.forEach((f, i) => {
    const at = 32 + i * (24 + pageSize);
    v.setUint32(at, f.pageNo);
    v.setUint32(at + 4, f.commit);
    v.setUint32(at + 8, i === opts.badSaltAt ? salt1 ^ 1 : salt1);
    v.setUint32(at + 12, salt2);
    out.set(f.page, at + 24);
    sum(at, 8);
    sum(at + 24, pageSize);
    v.setUint32(at + 16, i === opts.breakChecksumAt ? s1 ^ 1 : s1);
    v.setUint32(at + 20, s2);
  });
  return out;
}

describe("applyWal", () => {
  it("folds a real sidecar's committed frames in, so the session that lives only there is read", () => {
    const main = read(LIVE);
    const wal = read(`${LIVE}-wal`);
    expect(hermesAdapter.sessionsIn!(main)).toHaveLength(2);
    const r = applyWal(main, wal);
    expect(r).toMatchObject({ frames: 4, committed: 1 });
    expect(hermesAdapter.sessionsIn!(r.bytes)).toHaveLength(3);
    expect(hermesAdapter.sessionsIn!(r.bytes)).toContain(LIVE_SID);
    expect(new SqliteFile(r.bytes).pageCount).toBe(r.bytes.length / 4096);
    // The main file is untouched.
    expect(hermesAdapter.sessionsIn!(main)).toHaveLength(2);
  });

  it("stops at the first frame whose salt or checksum breaks the chain, and applies only committed frames", () => {
    const main = read(MAIN);
    const db = new SqliteFile(main);
    const page = (n: number): Uint8Array => main.subarray((n - 1) * db.pageSize, n * db.pageSize);
    const blank = new Uint8Array(db.pageSize);
    // One committed frame carrying page 1 unchanged: the result reads the same.
    const same = applyWal(main, buildWal(db.pageSize, [{ pageNo: 1, commit: db.pageCount, page: page(1) }]));
    expect(same).toMatchObject({ frames: 1, committed: 1 });
    expect(Buffer.from(same.bytes).equals(Buffer.from(main))).toBe(true);
    // A blank page 2 committed: the tables are gone, which is what the WAL says.
    const wiped = applyWal(main, buildWal(db.pageSize, [{ pageNo: 2, commit: db.pageCount, page: blank }]));
    expect(wiped.committed).toBe(1);
    expect(Buffer.from(wiped.bytes.subarray(db.pageSize, 2 * db.pageSize)).equals(Buffer.from(blank))).toBe(
      true,
    );
    // The same blank page but never committed: nothing applied.
    const open = applyWal(main, buildWal(db.pageSize, [{ pageNo: 2, commit: 0, page: blank }]));
    expect(open).toMatchObject({ frames: 1, committed: 0 });
    expect(open.bytes).toBe(main);
    // A broken checksum on the first frame ends the log before it; a bad salt too.
    for (const bad of [{ breakChecksumAt: 0 }, { badSaltAt: 0 }]) {
      const r = applyWal(
        main,
        buildWal(db.pageSize, [{ pageNo: 2, commit: db.pageCount, page: blank }], bad),
      );
      expect(r).toMatchObject({ frames: 0, committed: 0 });
    }
    // A good commit, then a frame from another generation: the first stands, the second is ignored.
    const two = applyWal(
      main,
      buildWal(
        db.pageSize,
        [
          { pageNo: 1, commit: db.pageCount, page: page(1) },
          { pageNo: 2, commit: db.pageCount, page: blank },
        ],
        { badSaltAt: 1 },
      ),
    );
    expect(two).toMatchObject({ frames: 1, committed: 1 });
    expect(Buffer.from(two.bytes).equals(Buffer.from(main))).toBe(true);
    // A commit that shrinks the database truncates the result.
    const shrunk = applyWal(main, buildWal(db.pageSize, [{ pageNo: 1, commit: 2, page: page(1) }]));
    expect(shrunk.bytes.length).toBe(2 * db.pageSize);
  });

  it("refuses a sidecar that is not a WAL, and treats a header-only one as empty", () => {
    const main = read(MAIN);
    expect(applyWal(main, new Uint8Array(32))).toMatchObject({ frames: 0, committed: 0 });
    expect(() => applyWal(main, new Uint8Array(32 + 4096 + 24))).toThrow(SqliteError);
    // A sidecar for a database with another page size would land its frames
    // at the wrong offsets: refused before any frame is read.
    expect(() =>
      applyWal(main, buildWal(1024, [{ pageNo: 1, commit: 1, page: new Uint8Array(1024) }])),
    ).toThrow(/page size 1024 does not match the database's 4096/);
    // A header is only checked once it has frames behind it.
    const one = [{ pageNo: 1, commit: 1, page: new Uint8Array(4096) }];
    const wal = buildWal(4096, one);
    new DataView(wal.buffer).setUint32(4, 3007001);
    expect(() => applyWal(main, wal)).toThrow(/3007000/);
    const bad = buildWal(4096, one);
    new DataView(bad.buffer).setUint32(28, 0);
    expect(() => applyWal(main, bad)).toThrow(/checksum/);
  });

  it("answers every mutation of the real sidecar with SqliteError or a value, never a built-in error", () => {
    const main = read(LIVE);
    const wal = read(`${LIVE}-wal`);
    let a = 0x5eed;
    const next = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let values = 0;
    for (let i = 0; i < 300; i++) {
      const m = new Uint8Array(wal);
      const kind = next();
      if (kind < 0.5) {
        for (let k = 0; k < 1 + Math.floor(next() * 8); k++)
          m[Math.floor(next() * m.length)] = Math.floor(next() * 256);
      } else if (kind < 0.8) {
        // Truncate somewhere.
        const cut = Math.floor(next() * m.length);
        try {
          const r = applyWal(main, m.subarray(0, cut));
          if (r) values++;
        } catch (err) {
          expect(err instanceof SqliteError, String(err)).toBe(true);
        }
        continue;
      } else {
        // Corrupt a header field wholesale.
        new DataView(m.buffer).setUint32(4 * Math.floor(next() * 8), Math.floor(next() * 0xffffffff));
      }
      try {
        const r = applyWal(main, m);
        if (r.committed > 0) new SqliteFile(r.bytes).tables();
        values++;
      } catch (err) {
        expect(err instanceof SqliteError, String(err)).toBe(true);
      }
    }
    expect(values).toBeGreaterThan(0);
  });
});

describe("readSqliteWithWal and the CLI", () => {
  it("imports a live database with its sidecar folded in, says so, and still refuses a sidecar it cannot read", () => {
    const { bytes, note } = readSqliteWithWal(LIVE);
    expect(note).toContain("4 frames in 1 commit folded in");
    expect(hermesAdapter.sessionsIn!(bytes)).toHaveLength(3);
    expect(readSqliteWithWal(MAIN).note).toBeNull();

    const dir = mktemp();
    const r = agit(["import", LIVE, "--dir", dir]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("folded in");
    expect(r.out).toContain("3 sessions");
    expect(agit(["verify", LIVE_SID, "--dir", dir]).code).toBe(0);

    // import --all finds the same pair in a Hermes home and folds it in too.
    const home = mktemp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "state.db"), readFileSync(LIVE));
    writeFileSync(join(home, ".hermes", "state.db-wal"), readFileSync(`${LIVE}-wal`));
    const all = agit(["import", "--all", "--dir", mktemp()], {
      HOME: home,
      USERPROFILE: home,
      HERMES_HOME: join(home, ".hermes"),
      APPDATA: join(home, "r"),
      LOCALAPPDATA: join(home, "l"),
      XDG_CONFIG_HOME: join(home, "c"),
      XDG_DATA_HOME: join(home, "d"),
      CLINE_DIR: join(home, "cl"),
      KIMI_SHARE_DIR: join(home, "k"),
      OPENCLAW_STATE_DIR: join(home, "o"),
      PI_CODING_AGENT_DIR: join(home, "p"),
    });
    expect(all.out).toContain("folded in");
    expect(all.out).toContain(`imported   ${LIVE_SID.slice(0, 20)}`);

    // A sidecar that is not a WAL: refused, naming the checkpoint command.
    const broken = mktemp();
    writeFileSync(join(broken, "state.db"), readFileSync(MAIN));
    writeFileSync(join(broken, "state.db-wal"), new Uint8Array(32 + 4096 + 24));
    const refused = agit(["import", join(broken, "state.db"), "--dir", mktemp()]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("wal_checkpoint");
    expect(refused.out).toContain("bad magic");
  });
});

/**
 * The pair SQLite leaves when a database goes into WAL mode before its first
 * table exists, as a runtime's first run does: the main file is page 1 alone,
 * its header naming no schema and no text encoding yet (0) over an empty
 * table leaf, and every page of the database is in the sidecar until the
 * first checkpoint. Hermes keeps its connection open and skips the close-time
 * checkpoint (fixtures/hermes/generate/live.py), so this can last. The pages
 * here are the checkpointed fixture's, which is what the sidecar folds to.
 */
function walOnlyPair(dir: string, opts: { committed?: boolean } = {}): string {
  const full = read(MAIN);
  const pageSize = new SqliteFile(full).pageSize;
  const pages = full.length / pageSize;
  const main = new Uint8Array(pageSize);
  main.set(full.subarray(0, 24)); // magic, page size, reserved space, payload fractions
  main[18] = 2; // file format versions: WAL
  main[19] = 2;
  const v = new DataView(main.buffer);
  v.setUint32(24, 1); // change counter
  v.setUint32(28, 1); // database size: one page
  v.setUint32(92, 1); // version-valid-for
  main.set(full.subarray(96, 100), 96); // SQLite version number
  main.set([0x0d, 0, 0, 0, 0, (pageSize >> 8) & 0xff, pageSize & 0xff, 0], 100);
  const db = join(dir, "state.db");
  writeFileSync(db, main);
  const commit = opts.committed ?? true;
  writeFileSync(
    `${db}-wal`,
    buildWal(
      pageSize,
      Array.from({ length: pages }, (_, i) => ({
        pageNo: i + 1,
        commit: commit && i === pages - 1 ? pages : 0,
        page: full.subarray(i * pageSize, (i + 1) * pageSize),
      })),
    ),
  );
  return db;
}

/** The environment `import --all` sees with nothing installed but this Hermes home. */
function onlyHermes(hermesHome: string): Record<string, string> {
  const home = mktemp();
  return {
    HOME: home,
    USERPROFILE: home,
    HERMES_HOME: hermesHome,
    APPDATA: join(home, "r"),
    LOCALAPPDATA: join(home, "l"),
    XDG_CONFIG_HOME: join(home, "c"),
    XDG_DATA_HOME: join(home, "d"),
    CLINE_DIR: join(home, "cl"),
    KIMI_SHARE_DIR: join(home, "k"),
    OPENCLAW_STATE_DIR: join(home, "o"),
    PI_CODING_AGENT_DIR: join(home, "p"),
  };
}

function agitAsync(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const code = (err as { code?: number } | null)?.code;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin!.end("");
  });
}

describe("a database whose schema is still only in its WAL", () => {
  const relays: RelayHandle[] = [];
  afterEach(async () => {
    for (const r of relays.splice(0)) await r.close();
  });
  const SESSIONS = hermesAdapter.sessionsIn!(read(MAIN));
  const events = (store: string, id: string): string =>
    readFileSync(join(store, ".agit", "sessions", id, "events.jsonl"), "utf8");

  it("is recognized from what SQLite reads, and imports exactly as its checkpointed copy does", () => {
    const db = walOnlyPair(mktemp());
    // The state itself: the main file alone names no table, and folding the
    // sidecar in gives back the checkpointed fixture byte for byte.
    expect(() => new SqliteFile(read(db))).toThrow(/text encoding 0/);
    expect(hermesAdapter.detectBytes!(read(db))).toBe(false);
    expect(Buffer.from(readSqliteWithWal(db).bytes).equals(Buffer.from(read(MAIN)))).toBe(true);
    expect(SESSIONS).toHaveLength(2);

    const store = mktemp();
    const r = agit(["import", db, "--dir", store]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("no adapter recognizes");
    expect(r.out).toMatch(/\d+ frames in 1 commit folded in/);
    expect(r.out).toContain("2 sessions");
    const ref = mktemp();
    expect(agit(["import", MAIN, "--dir", ref]).code).toBe(0);
    for (const id of SESSIONS) {
      expect(events(store, id)).toBe(events(ref, id));
      expect(agit(["verify", id, "--dir", store]).code).toBe(0);
    }
  });

  it("is imported by import --all, not skipped", () => {
    const home = mktemp();
    walOnlyPair(home);
    const all = agit(["import", "--all", "--dir", mktemp()], onlyHermes(home));
    expect(all.code, all.out).toBe(0);
    expect(all.out).not.toContain("no adapter recognizes");
    expect(all.out).toContain("folded in");
    expect(all.out).toContain("2 imported, 0 updated, 0 unchanged, 0 skipped, 0 failed");
  });

  it("is shared: refused without --thread since it holds two sessions, and published with one", async () => {
    const relay = await startRelay({ port: 0 });
    relays.push(relay);
    const base = `http://127.0.0.1:${relay.port}`;
    const dir = mktemp();
    const db = walOnlyPair(dir);
    const many = await agitAsync(["share", db, "--static", "--detach", "--relay", base, "--dir", dir]);
    expect(many.code, many.stdout + many.stderr).toBe(2);
    expect(many.stderr).toContain("2 sessions");
    expect(many.stderr).toContain("--thread");
    const id = SESSIONS[0]!;
    const one = await agitAsync([
      "share",
      db,
      "--thread",
      id,
      "--static",
      "--detach",
      "--relay",
      base,
      "--dir",
      dir,
    ]);
    expect(one.code, one.stdout + one.stderr).toBe(0);
    const link = /http:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(one.stdout)?.[0];
    expect(link).toBeTruthy();
    const res = await fetch(`${base}/api/shares/${link!.split("/s/")[1]!}/events.jsonl`);
    expect(res.ok).toBe(true);
    const shared = (await res.text())
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type: string; session: string });
    expect(shared[0]).toMatchObject({ type: "session.start", session: id });
    expect(shared.at(-1)!.type).toBe("session.end");
  });

  it("with a sidecar that is not a WAL, is refused naming the checkpoint command, and --all counts it failed", () => {
    const home = mktemp();
    const db = walOnlyPair(home);
    writeFileSync(`${db}-wal`, new Uint8Array(32 + 4096 + 24));
    const refused = agit(["import", db, "--dir", mktemp()]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("wal_checkpoint");
    expect(refused.out).toContain("bad magic");
    expect(refused.out).not.toContain("no adapter recognizes");
    const all = agit(["import", "--all", "--dir", mktemp()], onlyHermes(home));
    expect(all.code).toBe(1);
    expect(all.out).toContain("bad magic");
    expect(all.out).toContain("0 imported, 0 updated, 0 unchanged, 0 skipped, 1 failed");
  });

  it("whose frames were never committed is still the empty main file, and nothing is guessed from them", () => {
    const home = mktemp();
    const db = walOnlyPair(home, { committed: false });
    const r = agit(["import", db, "--dir", mktemp()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no adapter recognizes this file");
    const all = agit(["import", "--all", "--dir", mktemp()], onlyHermes(home));
    expect(all.code).toBe(0);
    expect(all.out).toContain("0 imported, 0 updated, 0 unchanged, 1 skipped, 0 failed");
  });
});
