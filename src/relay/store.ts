/**
 * Optional on-disk storage for a relay (issue #72).
 *
 * Without it a relay is in-memory only and a restart drops every share, which
 * is fine for a demo and useless for anything a colleague might come back to
 * tomorrow. `agit relay --store <dir>` is the difference between a relay and
 * a remote.
 *
 * **Two files per share, not a database.** agit ships zero runtime
 * dependencies, and `node:sqlite` needs Node 22 while the package supports
 * Node 20. Two flat files also happen to be the right shape: the events file
 * is append-only, which is what an append-only log wants, and the metadata
 * file is small enough to rewrite whole.
 *
 * **The writer token is a credential and it is written to disk.** Anyone who
 * can read the directory can push events to a share as its owner. The
 * directory is created 0700 and files 0600, which the relay operator should
 * treat as the actual protection — on Windows those modes are advisory, so
 * the real answer there is where you put the directory.
 *
 * A corrupt or half-written share is skipped with a warning rather than
 * taking the relay down at boot. One bad file should cost one share.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Everything about a share that outlives the process. Viewers do not. */
export interface PersistedShare {
  id: string;
  writerToken: string;
  createdAt: number;
  ttlMs: number;
  ended: boolean;
  /** Steering opted in when the share was created. Absent in stores written before it existed: off. */
  steer?: boolean;
  lastHash: string | null;
}

export interface LoadedShare {
  meta: PersistedShare;
  events: string[];
}

export interface RelayStore {
  /** Every unexpired share on disk. Expired ones are deleted as they are found. */
  load(now: number): LoadedShare[];
  create(meta: PersistedShare): void;
  append(id: string, lines: string[], lastHash: string | null): void;
  setEnded(id: string, ended: boolean): void;
  remove(id: string): void;
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** Cut a file back to just after its last newline, discarding a torn final line. */
function truncateToLastCompleteLine(p: string): void {
  const buf = readFileSync(p);
  const cut = buf.lastIndexOf(0x0a);
  truncateSync(p, cut === -1 ? 0 : cut + 1);
}

/** True if the file is absent, empty, or ends in a newline — the states an append may follow. */
function endsWithNewline(p: string): boolean {
  if (!existsSync(p)) return true;
  const size = statSync(p).size;
  if (size === 0) return true;
  const fd = openSync(p, "r");
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Share ids are base64url from the relay; refuse anything that could escape the directory. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{10,64}$/.test(id);
}

export function openRelayStore(dir: string): RelayStore {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const metaPath = (id: string): string => join(dir, `${id}.json`);
  const eventsPath = (id: string): string => join(dir, `${id}.jsonl`);

  /** Rewrite whole, via a temp file, so a crash mid-write cannot leave half a document. */
  function writeMeta(meta: PersistedShare): void {
    const tmp = `${metaPath(meta.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, metaPath(meta.id));
  }

  return {
    load(now: number): LoadedShare[] {
      const out: LoadedShare[] = [];
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (!safeId(id)) continue;
        let meta: PersistedShare;
        try {
          meta = JSON.parse(readFileSync(metaPath(id), "utf8")) as PersistedShare;
          // Every field the relay computes with has to be the right type.
          // Checking only id and writerToken let a meta with no createdAt or
          // ttlMs through: the TTL comparison below was NaN (false), so the
          // share loaded and the reaper never expired it, and every /end and
          // /stream on it threw "Invalid time value" from new Date(NaN).
          if (
            typeof meta.id !== "string" ||
            typeof meta.writerToken !== "string" ||
            !Number.isFinite(meta.createdAt) ||
            !Number.isFinite(meta.ttlMs) ||
            typeof meta.ended !== "boolean"
          )
            throw new Error("shape");
        } catch {
          // One unreadable file costs one share, not the relay's startup.
          console.error(`relay store: skipping ${name} (unreadable)`);
          continue;
        }
        // The TTL applies across a restart. A share that expired while the
        // relay was down is gone, not resurrected with a fresh clock.
        if (now - meta.createdAt > meta.ttlMs) {
          this.remove(id);
          continue;
        }
        let events: string[] = [];
        try {
          if (existsSync(eventsPath(id))) {
            events = readFileSync(eventsPath(id), "utf8")
              .split("\n")
              .filter((l) => l.trim() !== "");
            // A crash mid-append leaves a partial last line. Serving it as an
            // event made the count and the head disagree — /head reported N+1
            // events with the hash of event N-1 — and because the torn line
            // has no newline, the next accepted push was appended onto it and
            // lost on the following restart. A torn tail is dropped, and only
            // the tail: an unparseable line anywhere else is a real corruption
            // that verify will name, not something to silently skip past.
            const last = events[events.length - 1];
            if (last !== undefined && !parses(last)) {
              events.pop();
              // Remove it from the file too. Dropping it from memory alone
              // left it on disk, where the next append put it on its own line
              // and the load after that served it as an event mid-chain.
              truncateToLastCompleteLine(eventsPath(id));
              console.error(`relay store: ${id} ended in a partial line (crash mid-write?); dropped it`);
            }
          }
        } catch {
          console.error(`relay store: ${id} has unreadable events, serving what loaded`);
        }
        out.push({ meta, events });
      }
      return out;
    },

    create(meta: PersistedShare): void {
      if (!safeId(meta.id)) return;
      writeMeta(meta);
    },

    append(id: string, lines: string[], lastHash: string | null): void {
      if (!safeId(id) || lines.length === 0) return;
      // Append-only, matching the thing being stored. If the file does not
      // end in a newline (a torn tail that load() already dropped from
      // memory), start on a fresh line rather than gluing onto the fragment.
      const p = eventsPath(id);
      const lead = endsWithNewline(p) ? "" : "\n";
      appendFileSync(p, lead + lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      try {
        const meta = JSON.parse(readFileSync(metaPath(id), "utf8")) as PersistedShare;
        writeMeta({ ...meta, lastHash });
      } catch {
        /* the events are what matter; a lost head is recomputed on load */
      }
    },

    setEnded(id: string, ended: boolean): void {
      if (!safeId(id)) return;
      try {
        const meta = JSON.parse(readFileSync(metaPath(id), "utf8")) as PersistedShare;
        writeMeta({ ...meta, ended });
      } catch {
        /* nothing to mark */
      }
    },

    remove(id: string): void {
      if (!safeId(id)) return;
      for (const p of [metaPath(id), eventsPath(id)]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* best effort: the reaper runs again */
        }
      }
    },
  };
}
