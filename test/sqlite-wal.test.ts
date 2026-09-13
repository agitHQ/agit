/**
 * The write-ahead log folded over the main file the way SQLite reads it:
 * a real pair copied while the writer held the WAL open (fixtures/hermes/
 * live), frames built by hand with the format's own checksum chain, and
 * the sidecar over hostile bytes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hermesAdapter } from "../src/adapters/hermes.js";
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
