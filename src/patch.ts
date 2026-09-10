/**
 * Minimal unified-diff applier for agit's own file.diff payloads (SPEC §5.7):
 * creates synthesized as one +N hunk, modifies carried over from the
 * runtime's structured patches. Strict by design — any context mismatch
 * throws rather than fuzzy-matching, because the caller verifies every
 * result against the event's afterHash anyway. Never applies diffs from a
 * log to arbitrary paths; this operates on strings only.
 */

export class PatchError extends Error {}

export interface Hunk {
  oldStart: number;
  lines: string[]; // ' ' context, '-' delete, '+' add, '\' no-newline marker
}

export function applyUnifiedDiff(base: string | null, diff: string): string {
  const hunks = parseHunks(diff);
  const { lines: baseLines, trailingNewline: baseTrail } = splitLines(base ?? "");

  const out: string[] = [];
  let cursor = 0; // index into baseLines
  let noNewlineAtEnd = false;

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) throw new PatchError("hunks overlap or are out of order");
    // Copy the untouched span before this hunk.
    while (cursor < start) {
      if (cursor >= baseLines.length) throw new PatchError("hunk start beyond end of base");
      out.push(baseLines[cursor++]!);
    }
    for (let i = 0; i < hunk.lines.length; i++) {
      const l = hunk.lines[i]!;
      const tag = l[0];
      const text = l.slice(1);
      if (tag === "\\") {
        // "\ No newline at end of file" — applies to the previous emitted line.
        noNewlineAtEnd = true;
        continue;
      }
      noNewlineAtEnd = false;
      if (tag === " " || tag === "-") {
        if (cursor >= baseLines.length || baseLines[cursor] !== text) {
          throw new PatchError(
            `context mismatch at base line ${cursor + 1}: expected ${JSON.stringify(text)}, ` +
              `found ${JSON.stringify(baseLines[cursor] ?? "<eof>")}`,
          );
        }
        if (tag === " ") out.push(text);
        cursor++;
      } else if (tag === "+") {
        out.push(text);
      } else if (l === "") {
        // Tolerate a bare empty line as empty context (some emitters trim
        // trailing whitespace off a ' ' context line down to nothing) — but a
        // genuine mismatch still throws, exactly like every other context
        // line, per this module's "strict by design" contract above.
        if (cursor >= baseLines.length || baseLines[cursor] !== "") {
          throw new PatchError(
            `context mismatch at base line ${cursor + 1}: expected ${JSON.stringify("")}, ` +
              `found ${JSON.stringify(baseLines[cursor] ?? "<eof>")}`,
          );
        }
        out.push("");
        cursor++;
      } else {
        throw new PatchError(`unrecognized diff line: ${JSON.stringify(l)}`);
      }
    }
  }
  // Copy the rest of the base.
  while (cursor < baseLines.length) out.push(baseLines[cursor++]!);

  if (out.length === 0) return "";
  const trail = noNewlineAtEnd ? "" : base === null || base === "" ? "\n" : baseTrail ? "\n" : "";
  return out.join("\n") + trail;
}

export function parseHunks(diff: string): Hunk[] {
  const rawLines = diff.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (m) {
      current = { oldStart: Number(m[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue; // ---/+++/index headers
    // `diff.split("\n")` on a trailing-newline string produces one final ""
    // element that isn't a real diff line — drop it by position. A genuine
    // bare-empty context/add/delete line earlier in the diff has the same
    // value ("") but is not the last element, and must be kept: comparing by
    // value here (the previous bug) silently dropped every such line.
    if (raw === "" && i === rawLines.length - 1 && diff.endsWith("\n")) continue;
    current.lines.push(raw);
  }
  if (hunks.length === 0) throw new PatchError("diff contains no hunks");
  return hunks;
}

function splitLines(s: string): { lines: string[]; trailingNewline: boolean } {
  if (s === "") return { lines: [], trailingNewline: false };
  const trailingNewline = s.endsWith("\n");
  const lines = s.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}
