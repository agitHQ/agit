/**
 * Credential-pattern redaction (SPEC.md §8). Runs on every payload string at
 * import, before hashing. A seatbelt, not a guarantee — the spec documents
 * exactly what this does and does not catch.
 */

import type { Json } from "./format/events.js";

interface Pattern {
  label: string;
  regexes: RegExp[];
  /** Replacement; $1 preserves a leading kept group (assignment pattern). */
  replacement?: string;
}

// Anchoring: a pattern whose prefix is distinctive on its own (sk-ant-,
// ghp_, AKIA, AIza, xoxb-, sk_live_, npm_) carries no leading \b — the prefix
// is the boundary, and `_` or a letter immediately before a key is exactly
// how a key ends up glued to an identifier or a filename. Only the generic
// `sk-` shape keeps its anchor; unanchored it would eat `disk-usage-report-…`.
//
// Order matters: anthropic-key must run before the generic openai-key shape,
// and specific token shapes before the generic assignment catch-all.
const PATTERNS: Pattern[] = [
  {
    label: "private-key",
    regexes: [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  },
  { label: "anthropic-key", regexes: [/sk-ant-[A-Za-z0-9_-]{16,}/g] },
  { label: "openai-key", regexes: [/sk-proj-[A-Za-z0-9_-]{20,}/g, /\bsk-[A-Za-z0-9_-]{20,}/g] },
  { label: "aws-access-key-id", regexes: [/(?:AKIA|ASIA)[0-9A-Z]{16}\b/g] },
  {
    label: "github-token",
    regexes: [/gh[pousr]_[A-Za-z0-9]{36,}\b/g, /github_pat_[A-Za-z0-9_]{22,}\b/g],
  },
  { label: "slack-token", regexes: [/xox[baprs]-[A-Za-z0-9-]{10,}\b/g] },
  {
    label: "slack-webhook",
    regexes: [/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+\b/g],
  },
  { label: "google-api-key", regexes: [/AIza[0-9A-Za-z_-]{35}\b/g] },
  { label: "stripe-key", regexes: [/(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g] },
  { label: "npm-token", regexes: [/npm_[A-Za-z0-9]{36}\b/g] },
  { label: "jwt", regexes: [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g] },
  { label: "bearer", regexes: [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi] },
  {
    // scheme://user:password@host — connection strings and API URLs commonly
    // carry the credential in the userinfo component. Keep everything but
    // the password itself; the "@" that follows is outside the match.
    label: "url-credentials",
    regexes: [/\b([a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]{1,64}:)([^\s/@]{3,})(?=@)/gi],
    replacement: "$1[REDACTED:url-credentials]",
  },
  {
    // The keyword MUST end the identifier before "=`/`:` — e.g. `password`,
    // `db_password`, `DB_PASSWORD`, `client_secret`, `AUTH_TOKEN` all match.
    // A plain `\bpassword\b` misses every one of those SCREAMING_SNAKE_CASE
    // or prefixed forms: `_` and `-` are word characters to `\b`, so there is
    // no boundary between them and the keyword that follows.
    //
    // The prefix group bounds BOTH the run length (`{1,32}`) and the repeat
    // count (`{0,4}`) — an earlier `(?:[A-Za-z0-9]+[_-])*` here was
    // catastrophically slow (quadratic-or-worse) on any long run of ordinary
    // word characters, secret or not, because the unbounded `+` had to
    // backtrack the full remaining length looking for a `_`/`-` that might
    // never appear, at every position the regex engine anchors to. Real
    // identifier segments are never anywhere near 32 characters or 4 levels
    // deep, so the bound costs no real matches while making the worst case a
    // small constant instead of the whole remaining string.
    label: "assignment",
    regexes: [
      /((?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:api[_-]?key|apikey|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|passwd|password|dsn|connection[_-]?string|authorization)\s*[=:]\s*["']?)([A-Za-z0-9_\-./+]{16,})/gi,
    ],
    replacement: "$1[REDACTED:assignment]",
  },
];

export type RedactionCounts = Record<string, number>;

export function redactString(s: string, counts: RedactionCounts): string {
  let out = s;
  for (const p of PATTERNS) {
    for (const re of p.regexes) {
      out = out.replace(re, (...args) => {
        counts[p.label] = (counts[p.label] ?? 0) + 1;
        if (p.replacement) {
          // Reapply the kept groups manually ($1, $2, ... — as many as the
          // pattern captured).
          const groups = args.slice(1, -2) as string[];
          return p.replacement.replace(/\$(\d)/g, (_m, d: string) => groups[Number(d) - 1] ?? "");
        }
        return `[REDACTED:${p.label}]`;
      });
    }
  }
  return out;
}

type Frame =
  | { kind: "array"; src: Json[]; container: Json[]; keys: number[]; i: number }
  | {
      kind: "object";
      src: { [key: string]: Json };
      container: { [key: string]: Json };
      keys: string[];
      i: number;
    };

function makeFrame(src: Json, container: Json): Frame {
  if (Array.isArray(src)) {
    return { kind: "array", src, container: container as Json[], keys: src.map((_, i) => i), i: 0 };
  }
  const obj = src as { [key: string]: Json };
  return {
    kind: "object",
    src: obj,
    container: container as { [key: string]: Json },
    keys: Object.keys(obj),
    i: 0,
  };
}

/**
 * Recursively redact every string in a JSON value. Values only — object keys
 * are payload structure, not data.
 *
 * Iterative, with an explicit work stack, rather than a recursive walk: a
 * session log is untrusted input and `JSON.parse` places no limit on nesting
 * depth, so a recursive version stack-overflows on a payload nested a few
 * thousand levels deep — reachable from ordinary (not even adversarial)
 * structured tool output, well before any realistic size limit kicks in.
 */
export function redactDeep<T extends Json>(root: T, counts: RedactionCounts): T {
  if (typeof root === "string") return redactString(root, counts) as T;
  if (root === null || typeof root !== "object") return root;

  const out: Json = Array.isArray(root) ? [] : {};
  const stack: Frame[] = [makeFrame(root, out)];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.i >= frame.keys.length) {
      stack.pop();
      continue;
    }

    let v: Json | undefined;
    let assign: (child: Json) => void;
    if (frame.kind === "array") {
      const i = frame.keys[frame.i++]!;
      v = frame.src[i];
      assign = (child) => {
        frame.container[i] = child;
      };
    } else {
      const k = frame.keys[frame.i++]!;
      v = frame.src[k];
      if (v === undefined) continue; // JSON.stringify would drop it; be explicit.
      assign = (child) => {
        frame.container[k] = child;
      };
    }

    if (typeof v === "string") assign(redactString(v, counts));
    // Array elements can legitimately be `undefined` (unlike object
    // properties, already filtered above) — preserved as-is, matching the
    // previous `Array.prototype.map` behavior.
    else if (v === null || typeof v !== "object") assign(v as Json);
    else {
      const child: Json = Array.isArray(v) ? [] : {};
      assign(child);
      stack.push(makeFrame(v, child));
    }
  }
  return out as T;
}
