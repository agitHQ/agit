/**
 * `agit stats` — store-wide usage across every imported session and runtime.
 *
 * A fold over `cost` events, grouped four ways: by day, model, runtime, or
 * project. The tokens are exact; sessions and files are counted per group.
 *
 * Money is deliberately not built in. Prices change, differ per account, and
 * a stale number that looks authoritative is worse than no number at all — so
 * costing requires a rate table the user supplies (`--price`), and any model
 * missing from it is reported as unpriced rather than silently costed at zero.
 *
 * A runtime that records no cost events at all (Codex today) produces a row
 * that says so, rather than a row of zeros that reads like "this was free".
 */

import type { AgitEvent, Json } from "./format/events.js";
import { fileStateAt } from "./state.js";

export type GroupBy = "day" | "model" | "runtime" | "project";

export const GROUP_BY: GroupBy[] = ["day", "model", "runtime", "project"];

export function isGroupBy(s: string): s is GroupBy {
  return (GROUP_BY as string[]).includes(s);
}

export interface StatsRow {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiCalls: number;
  sessions: number;
  files: number;
  /** False when nothing in this group recorded a cost event; the token columns are then unknown, not zero. */
  costRecorded: boolean;
  /** Populated only when a rate table covers every model in the group. */
  cost?: number;
  /** Models seen in this group with no entry in the rate table. */
  unpriced?: string[];
}

export interface StatsResult {
  rows: StatsRow[];
  totals: StatsRow;
  /** Sessions excluded by --since. */
  skippedBySince: number;
  currency?: string;
}

export interface SessionInput {
  id: string;
  events: AgitEvent[];
}

// --- rate tables ------------------------------------------------------------

export interface PriceTable {
  currency: string;
  /** Rates are quoted per this many tokens. */
  per: number;
  models: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
}

export class PriceTableError extends Error {}

/**
 * Parse a user-supplied rate table.
 *
 * The shape is explicit about its unit because getting that wrong is a
 * thousand-fold error in a number someone may put in an invoice.
 */
export function parsePriceTable(raw: string): PriceTable {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new PriceTableError("price table is not valid JSON");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new PriceTableError("price table must be a JSON object");
  }
  const d = doc as Record<string, unknown>;
  const models = d.models;
  if (models === null || typeof models !== "object" || Array.isArray(models)) {
    throw new PriceTableError('price table needs a "models" object: { "<model>": { "input": 15, ... } }');
  }
  const per = d.per === undefined ? 1_000_000 : d.per;
  if (typeof per !== "number" || !Number.isFinite(per) || per <= 0) {
    throw new PriceTableError('"per" must be a positive number of tokens (default 1000000)');
  }
  return {
    currency: typeof d.currency === "string" ? d.currency : "",
    per,
    models: models as PriceTable["models"],
  };
}

// --- the fold ---------------------------------------------------------------

interface Bucket {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiCalls: number;
  sessions: Set<string>;
  files: Set<string>;
  models: Set<string>;
  /** Token cost, accumulated only while every model so far is priced. */
  cost: number;
  unpriced: Set<string>;
}

function emptyBucket(key: string): Bucket {
  return {
    key,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    apiCalls: 0,
    sessions: new Set(),
    files: new Set(),
    models: new Set(),
    cost: 0,
    unpriced: new Set(),
  };
}

const num = (v: Json | undefined): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The project a session belongs to: the last segment of its recorded cwd. */
export function projectOf(events: AgitEvent[]): string {
  const cwd = str((events[0]?.payload as { cwd?: unknown } | undefined)?.cwd);
  if (cwd === "") return "(no cwd recorded)";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

export function runtimeOf(events: AgitEvent[]): string {
  return str((events[0]?.payload as { runtime?: unknown } | undefined)?.runtime) || "(unknown)";
}

export function computeStats(
  sessions: SessionInput[],
  opts: { by: GroupBy; sinceMs?: number; now?: number; prices?: PriceTable } = { by: "day" },
): StatsResult {
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = emptyBucket(key);
      buckets.set(key, b);
    }
    return b;
  };

  const cutoff = opts.sinceMs === undefined ? null : (opts.now ?? Date.now()) - opts.sinceMs;
  let skippedBySince = 0;

  for (const { id, events } of sessions) {
    if (events.length === 0) continue;
    if (cutoff !== null) {
      // A session counts as in-window if its last event is inside it.
      const end = Date.parse(events[events.length - 1]!.ts);
      if (Number.isFinite(end) && end < cutoff) {
        skippedBySince++;
        continue;
      }
    }

    const runtime = runtimeOf(events);
    const project = projectOf(events);
    // For every grouping but "model" and "day", a session belongs to exactly
    // one bucket, so its files and its membership are counted once there.
    const sessionKey = opts.by === "runtime" ? runtime : opts.by === "project" ? project : null;
    const paths = [...fileStateAt(events).keys()];
    if (sessionKey !== null) {
      const b = bucket(sessionKey);
      b.sessions.add(id);
      for (const p of paths) b.files.add(p);
    }

    let sawCost = false;
    for (const e of events) {
      if (e.type !== "cost") continue;
      sawCost = true;
      const p = e.payload as { model?: Json; usage?: { [k: string]: Json } };
      const model = str(p.model) || "(unnamed model)";
      const u = p.usage ?? {};
      const key =
        opts.by === "day"
          ? e.ts.slice(0, 10)
          : opts.by === "model"
            ? model
            : opts.by === "runtime"
              ? runtime
              : project;
      const b = bucket(key);
      b.inputTokens += num(u.inputTokens);
      b.outputTokens += num(u.outputTokens);
      b.cacheReadInputTokens += num(u.cacheReadInputTokens);
      b.cacheCreationInputTokens += num(u.cacheCreationInputTokens);
      b.apiCalls++;
      b.models.add(model);
      b.sessions.add(id);
      if (opts.by === "day" || opts.by === "model") for (const path of paths) b.files.add(path);

      if (opts.prices) {
        const rate = opts.prices.models[model];
        if (rate === undefined) {
          b.unpriced.add(model);
        } else {
          const per = opts.prices.per;
          b.cost +=
            (num(u.inputTokens) * (rate.input ?? 0)) / per +
            (num(u.outputTokens) * (rate.output ?? 0)) / per +
            (num(u.cacheReadInputTokens) * (rate.cacheRead ?? 0)) / per +
            (num(u.cacheCreationInputTokens) * (rate.cacheWrite ?? 0)) / per;
        }
      }
    }

    // A session with no cost events still belongs somewhere, and saying "no
    // cost recorded" is the honest version of a row of zeros.
    if (!sawCost && sessionKey !== null) bucket(sessionKey);
  }

  const toRow = (b: Bucket): StatsRow => ({
    key: b.key,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheReadInputTokens: b.cacheReadInputTokens,
    cacheCreationInputTokens: b.cacheCreationInputTokens,
    apiCalls: b.apiCalls,
    sessions: b.sessions.size,
    files: b.files.size,
    costRecorded: b.apiCalls > 0,
    // A group holding any unpriced model gets no cost at all. A partial sum
    // presented as the cost of the row would understate it, and understating
    // money silently is worse than declining to state it.
    ...(opts.prices && b.apiCalls > 0 && b.unpriced.size === 0 ? { cost: b.cost } : {}),
    ...(b.unpriced.size > 0 ? { unpriced: [...b.unpriced].sort() } : {}),
  });

  const rows = [...buckets.values()]
    .map(toRow)
    // Days read best oldest-first; everything else, biggest spender first.
    .sort((a, b) =>
      opts.by === "day" ? a.key.localeCompare(b.key) : b.apiCalls - a.apiCalls || a.key.localeCompare(b.key),
    );

  const all = emptyBucket("total");
  for (const { id, events } of sessions) {
    if (events.length === 0) continue;
    if (cutoff !== null) {
      const end = Date.parse(events[events.length - 1]!.ts);
      if (Number.isFinite(end) && end < cutoff) continue;
    }
    all.sessions.add(id);
    for (const p of fileStateAt(events).keys()) all.files.add(p);
    for (const e of events) {
      if (e.type !== "cost") continue;
      const u = (e.payload as { usage?: { [k: string]: Json } }).usage ?? {};
      all.inputTokens += num(u.inputTokens);
      all.outputTokens += num(u.outputTokens);
      all.cacheReadInputTokens += num(u.cacheReadInputTokens);
      all.cacheCreationInputTokens += num(u.cacheCreationInputTokens);
      all.apiCalls++;
    }
  }
  const totals = toRow(all);
  if (opts.prices) {
    const unpriced = [...new Set(rows.flatMap((r) => r.unpriced ?? []))].sort();
    // Same rule as a row: a total is only a total if nothing was left out.
    // The totals bucket does not track models, so its cost is decided here.
    if (unpriced.length > 0) {
      totals.unpriced = unpriced;
      delete totals.cost;
    } else if (totals.apiCalls > 0) {
      totals.cost = rows.reduce((n, r) => n + (r.cost ?? 0), 0);
    }
  }

  return { rows, totals, skippedBySince, ...(opts.prices ? { currency: opts.prices.currency } : {}) };
}
