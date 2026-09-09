import { describe, expect, it } from "vitest";
import { redactDeep, redactString, type RedactionCounts } from "../src/redact.js";

// Credential fixtures are assembled at runtime from concatenated fragments so
// that no string literal in this source file matches a real credential
// format. GitHub secret scanning (deliberately NOT path-excluded for test/)
// would otherwise flag every real-format fixture as a leaked key — a fresh
// false positive for each new pattern this suite covers. The matchable
// string only ever exists in memory. Split inside the provider prefix
// (sk- + ant-, AK + IA, gh + p_, ...) so no fragment carries the signature.
const joined = (...parts: string[]) => parts.join("");

const K = {
  anthropic: joined("sk-", "ant-", "api03-AAAABBBBCCCCDDDD1234"),
  anthropic2: joined("sk-", "ant-", "XXXXYYYYZZZZWWWW1234"),
  openaiProj: joined("sk-", "proj-", "AAAABBBBCCCCDDDDEEEE1234"),
  openaiBare: joined("sk-", "AAAABBBBCCCCDDDDEEEE12"),
  aws: joined("AK", "IA", "IOSFODNN7EXAMPLE"),
  ghp: joined("gh", "p_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
  ghPat: joined("github_", "pat_", "ABCDEFGHIJKLMNOPQRSTUV0123"),
  slack: joined("xo", "xb-", "1234567890-abcdef"),
  google: joined("AI", "za", "SyA1234567890abcdefghijklmnopqrstuv"),
  jwt: joined("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjM0In0.", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"),
  pem: joined("-----BEGIN RSA ", "PRIVATE KEY-----", "\nMIIabc\nxyz\n", "-----END RSA ", "PRIVATE KEY-----"),
  stripe: joined("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  npm: joined("npm_", "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII"),
  webhook: joined("https://hooks.slack.com/services/T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX"),
};

function run(s: string): { out: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  return { out: redactString(s, counts), counts };
}

describe("redaction (SPEC §8)", () => {
  it("anthropic key", () => {
    const { out, counts } = run(`key=${K.anthropic} end`);
    expect(out).toBe("key=[REDACTED:anthropic-key] end");
    expect(counts["anthropic-key"]).toBe(1);
  });

  it("openai key, without eating anthropic keys first", () => {
    expect(run(K.openaiProj).out).toBe("[REDACTED:openai-key]");
    const both = run(`a ${K.anthropic2} b ${K.openaiBare} c`);
    expect(both.out).toBe("a [REDACTED:anthropic-key] b [REDACTED:openai-key] c");
  });

  it("aws access key id", () => {
    expect(run(K.aws).out).toBe("[REDACTED:aws-access-key-id]");
  });

  it("github tokens, both shapes", () => {
    expect(run(K.ghp).out).toBe("[REDACTED:github-token]");
    expect(run(K.ghPat).out).toBe("[REDACTED:github-token]");
  });

  it("slack token", () => {
    expect(run(K.slack).out).toBe("[REDACTED:slack-token]");
  });

  it("google api key", () => {
    expect(run(K.google).out).toBe("[REDACTED:google-api-key]");
  });

  it("private key block", () => {
    expect(run(`before\n${K.pem}\nafter`).out).toBe("before\n[REDACTED:private-key]\nafter");
  });

  it("jwt", () => {
    expect(run(K.jwt).out).toBe("[REDACTED:jwt]");
  });

  it("bearer", () => {
    expect(run("Authorization: Bearer abcdefghij0123456789xyz").out).toContain("[REDACTED:bearer]");
  });

  it("assignment keeps the key and separator", () => {
    const { out } = run('password = "hunter2hunter2hunter2"');
    expect(out).toBe('password = "[REDACTED:assignment]"');
  });

  it("assignment fires on SCREAMING_SNAKE_CASE and prefixed keys, not just the bare keyword", () => {
    // \b does not separate "_"/letters (both are \w), so a plain
    // \bpassword\b never matched these — the dominant real-world .env shape.
    expect(run("DB_PASSWORD=hunter2hunter2hunter2").out).toBe("DB_PASSWORD=[REDACTED:assignment]");
    expect(run('export AUTH_TOKEN="abcdefghijklmnopqrstuvwx"').out).toBe(
      'export AUTH_TOKEN="[REDACTED:assignment]"',
    );
    expect(run("stripe_client_secret: abcdefghijklmnopqrstuvwx").out).toBe(
      "stripe_client_secret: [REDACTED:assignment]",
    );
  });

  it("url-credentials redacts only the password in a connection string", () => {
    const { out, counts } = run("postgres://admin:hunter2hunter2@db.internal:5432/app");
    expect(out).toBe("postgres://admin:[REDACTED:url-credentials]@db.internal:5432/app");
    expect(counts["url-credentials"]).toBe(1);
  });

  it("url-credentials leaves a bare URL (no embedded credentials) untouched", () => {
    const code = "fetch('https://example.com/api?token=short')";
    expect(run(code).out).toBe(code);
  });

  it("stripe key", () => {
    expect(run(K.stripe).out).toBe("[REDACTED:stripe-key]");
  });

  it("npm token", () => {
    expect(run(K.npm).out).toBe("[REDACTED:npm-token]");
  });

  it("slack webhook url", () => {
    expect(run(K.webhook).out).toBe("[REDACTED:slack-webhook]");
  });

  it("does not fire on ordinary code", () => {
    const code = "const skew = 5; // tokens: 123\nfunction api(key: string) { return key; }";
    expect(run(code).out).toBe(code);
  });

  it("redactDeep walks nested payloads and counts", () => {
    const counts: RedactionCounts = {};
    const out = redactDeep({ a: [K.slack, { b: K.aws }], n: 3 }, counts);
    expect(out).toEqual({ a: ["[REDACTED:slack-token]", { b: "[REDACTED:aws-access-key-id]" }], n: 3 });
    expect(counts).toEqual({ "slack-token": 1, "aws-access-key-id": 1 });
  });

  it("redactDeep handles a payload nested far deeper than the call stack allows", () => {
    // Regression for a real bug: session logs are untrusted input and
    // JSON.parse places no limit on nesting depth, so the previous recursive
    // implementation stack-overflowed on ordinary (not even adversarial)
    // deeply-nested structured tool output well under 2,000 levels deep.
    let deep: unknown = "leaf";
    for (let i = 0; i < 50_000; i++) deep = [deep];
    const counts: RedactionCounts = {};
    expect(() => redactDeep(deep as Parameters<typeof redactDeep>[0], counts)).not.toThrow();
    let unwrapped = redactDeep(deep as Parameters<typeof redactDeep>[0], counts);
    let depth = 0;
    while (Array.isArray(unwrapped)) {
      unwrapped = unwrapped[0] as typeof unwrapped;
      depth++;
    }
    expect(depth).toBe(50_000);
    expect(unwrapped).toBe("leaf");
  });

  it("redactDeep drops undefined object properties but preserves undefined array elements", () => {
    // Matches the pre-existing (recursive) implementation's documented
    // behavior exactly — this is a refactor to an iterative walk, not a
    // behavior change.
    const counts: RedactionCounts = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately off-spec input, same as JS callers can pass
    const input: any = { a: undefined, b: 1, c: [undefined, 2] };
    expect(redactDeep(input, counts)).toEqual({ b: 1, c: [undefined, 2] });
  });

  it("assignment does not catastrophically backtrack on a long ordinary string", () => {
    // Regression for a real bug: the earlier `(?:[A-Za-z0-9]+[_-])*` prefix
    // had an unbounded inner `+` that backtracked the full remaining length
    // hunting for a separator that never appears — quadratic-or-worse, and
    // it did not need a real secret or even an underscore to trigger: any
    // long run of ordinary word characters (a base64 blob, a hex hash, a
    // long identifier — all common in real tool output) was enough. A
    // hostile or merely large session log could hang `agit import`/`agit
    // share` for minutes. This must stay well under a second.
    const start = Date.now();
    const out = run("a".repeat(500_000)).out;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toHaveLength(500_000); // untouched: no keyword, nothing to redact
  });
});

describe("redaction boundaries (#53)", () => {
  const glued = (key: string): string => `WINDOW_${key}`;
  const cases: [string, string][] = [
    ["anthropic-key", "sk-ant-api03-" + "A".repeat(40)],
    ["openai-key", "sk-proj-" + "B".repeat(40)],
    ["github-token", "ghp_" + "C".repeat(36)],
    ["github-token", "github_pat_" + "D".repeat(30)],
    ["aws-access-key-id", "AKIA" + "E".repeat(16)],
    ["slack-token", "xoxb-" + "1".repeat(12)],
    ["google-api-key", "AIza" + "F".repeat(35)],
    ["stripe-key", "sk_live_" + "G".repeat(24)],
    ["npm-token", "npm_" + "H".repeat(36)],
  ];
  for (const [label, key] of cases) {
    it(`${label}: a key glued to a preceding identifier is still caught`, () => {
      const counts: RedactionCounts = {};
      const out = redactString(glued(key), counts);
      expect(out).not.toContain(key);
      expect(out).toContain(`[REDACTED:${label}]`);
      expect(counts[label]).toBe(1);
    });
  }

  it("the generic sk- shape keeps its anchor, so ordinary hyphenated words survive", () => {
    const counts: RedactionCounts = {};
    const text = "see disk-usage-report-2026-09-09-final-v2 for details";
    expect(redactString(text, counts)).toBe(text);
    expect(counts).toEqual({});
  });
});
