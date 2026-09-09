/**
 * A line-based three-way merge, for when `git merge-file` is not on PATH.
 *
 * agit prefers git: it is the implementation everyone's expectations are
 * calibrated against, and matching it exactly is worth more than owning the
 * code. This is the fallback, so that a machine without git turns `agit
 * merge` into a slightly different merge rather than a hard failure at the
 * last step of a handoff.
 *
 * The algorithm is the classic diff3: LCS-match each side against the base,
 * group the resulting change hunks by the base range they touch, and for each
 * group take whichever side changed — or emit a conflict when both did and
 * disagree. Conflict markers are git's own two-way form, the same ones the
 * git path produces, so nothing downstream has to tell the two apart.
 */

/** Lines carry their own newline, so a file with no trailing newline round-trips. */
export function toLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  const last = parts.pop()!; // "" when s ended with a newline
  const lines = parts.map((l) => l + "\n");
  if (last !== "") lines.push(last);
  return lines;
}

interface Hunk {
  /** Half-open range in the base. */
  baseStart: number;
  baseEnd: number;
  /** The corresponding half-open range on this side. */
  sideStart: number;
  sideEnd: number;
}

/**
 * Beyond this many cells the LCS table is not worth the memory, and the whole
 * differing middle becomes one change region instead. That is still correct —
 * it takes one side, or conflicts — just less granular than git would be. In
 * practice the prefix/suffix trim below removes the shared bulk first, so real
 * merges never come near it.
 */
const MAX_LCS_CELLS = 4_000_000;

/** Matched index pairs between two line arrays, longest common subsequence. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) return [];

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** The regions where `side` departs from `base`. */
function changeHunks(base: string[], side: string[]): Hunk[] {
  // Trim the shared head and tail first: it is what keeps the LCS table small
  // on the files people actually merge, which differ in a few places.
  let head = 0;
  while (head < base.length && head < side.length && base[head] === side[head]) head++;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < side.length - head &&
    base[base.length - 1 - tail] === side[side.length - 1 - tail]
  ) {
    tail++;
  }
  const baseMid = base.slice(head, base.length - tail);
  const sideMid = side.slice(head, side.length - tail);
  if (baseMid.length === 0 && sideMid.length === 0) return [];

  const pairs = lcsPairs(baseMid, sideMid);
  const hunks: Hunk[] = [];
  let bi = 0;
  let si = 0;
  const push = (bStart: number, bEnd: number, sStart: number, sEnd: number): void => {
    if (bEnd > bStart || sEnd > sStart) {
      hunks.push({
        baseStart: bStart + head,
        baseEnd: bEnd + head,
        sideStart: sStart + head,
        sideEnd: sEnd + head,
      });
    }
  };
  for (const [pb, ps] of pairs) {
    push(bi, pb, si, ps);
    bi = pb + 1;
    si = ps + 1;
  }
  push(bi, baseMid.length, si, sideMid.length);
  return hunks;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

export interface Merge3Result {
  content: string;
  clean: boolean;
  conflicts: number;
}

export interface Merge3Labels {
  ours: string;
  base: string;
  theirs: string;
}

/**
 * Three-way merge `ours` and `theirs` over their common `base`.
 *
 * Labels match the git path's (`ours` / `fork`), so a conflict written by
 * either implementation reads the same to whoever opens the file.
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  labels: Merge3Labels = { ours: "ours", base: "base", theirs: "fork" },
): Merge3Result {
  const b = toLines(base);
  const o = toLines(ours);
  const t = toLines(theirs);

  const ourHunks = changeHunks(b, o);
  const theirHunks = changeHunks(b, t);

  const out: string[] = [];
  let conflicts = 0;
  let basePos = 0;
  let ourPos = 0;
  let theirPos = 0;
  let oi = 0;
  let ti = 0;

  while (oi < ourHunks.length || ti < theirHunks.length) {
    const nextOur = ourHunks[oi];
    const nextTheir = theirHunks[ti];
    // The earliest base position either side wants to change.
    const groupStart = Math.min(
      nextOur ? nextOur.baseStart : Number.MAX_SAFE_INTEGER,
      nextTheir ? nextTheir.baseStart : Number.MAX_SAFE_INTEGER,
    );

    // Everything before it is untouched by both sides; copy it from the base.
    const stable = groupStart - basePos;
    for (let k = 0; k < stable; k++) out.push(b[basePos + k]!);
    ourPos += stable;
    theirPos += stable;

    // Grow the group while either side's next hunk touches the range. Touching
    // counts, not just overlapping: two insertions at the same base position
    // are a disagreement about that position, not two independent edits.
    let groupEnd = groupStart;
    const ourGroup: Hunk[] = [];
    const theirGroup: Hunk[] = [];
    for (;;) {
      const h = ourHunks[oi];
      const g = theirHunks[ti];
      if (h && h.baseStart <= groupEnd) {
        ourGroup.push(h);
        groupEnd = Math.max(groupEnd, h.baseEnd);
        oi++;
        continue;
      }
      if (g && g.baseStart <= groupEnd) {
        theirGroup.push(g);
        groupEnd = Math.max(groupEnd, g.baseEnd);
        ti++;
        continue;
      }
      break;
    }

    // Map the group's base range onto each side. Where a side has no hunk it
    // tracks the base exactly, so the range is the same length.
    const sideRange = (group: Hunk[], pos: number): [number, number] => {
      if (group.length === 0) return [pos, pos + (groupEnd - groupStart)];
      const first = group[0]!;
      const last = group[group.length - 1]!;
      return [first.sideStart - (first.baseStart - groupStart), last.sideEnd + (groupEnd - last.baseEnd)];
    };
    const [os, oe] = sideRange(ourGroup, ourPos);
    const [ts, te] = sideRange(theirGroup, theirPos);

    const baseSlice = b.slice(groupStart, groupEnd);
    const ourSlice = o.slice(os, oe);
    const theirSlice = t.slice(ts, te);

    if (sameLines(ourSlice, baseSlice)) {
      out.push(...theirSlice); // only they changed it
    } else if (sameLines(theirSlice, baseSlice)) {
      out.push(...ourSlice); // only we changed it
    } else if (sameLines(ourSlice, theirSlice)) {
      out.push(...ourSlice); // both made the same change
    } else {
      conflicts++;
      // A marker has to start its own line. When the side above it ended
      // without a trailing newline -- the last line of a file with no final
      // newline, say -- one is added, which is what git does here too.
      const marker = (text: string): void => {
        const prev = out[out.length - 1];
        if (prev !== undefined && !prev.endsWith("\n")) out[out.length - 1] = prev + "\n";
        out.push(text);
      };
      marker(`<<<<<<< ${labels.ours}\n`);
      out.push(...ourSlice);
      marker(`=======\n`);
      out.push(...theirSlice);
      marker(`>>>>>>> ${labels.theirs}\n`);
    }

    basePos = groupEnd;
    ourPos = oe;
    theirPos = te;
  }

  // Whatever follows the last change is identical on all three sides.
  for (let k = basePos; k < b.length; k++) out.push(b[k]!);

  return { content: out.join(""), clean: conflicts === 0, conflicts };
}
