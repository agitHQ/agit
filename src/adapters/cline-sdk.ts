/**
 * Adapter for Cline's SDK session format, `<sessionId>.messages.json` (#63).
 *
 * The second adapter, after ATIF, that reads a *published contract* rather
 * than one runtime's private layout. Cline documents this file in
 * `sdk/packages/core/docs/messages-contract-v1.md` as "the canonical
 * replay/export artifact", states that "downstream consumers ... should be
 * able to reconstruct a full session trajectory from this file alone", and
 * ships a golden fixture with contract tests. Every field name below is from
 * that document and checked against that fixture.
 *
 * It is the format new Cline sessions land in from 4.0 onward, at
 * `~/.cline/data/sessions/<id>/<id>.messages.json`. It is *not* the older
 * VS Code globalStorage layout (`api_conversation_history.json`), which is
 * undocumented, unversioned, and deliberately not read here.
 *
 * **This adapter emits no `file.diff`, and the reason is specific.** The
 * `editor` tool's create path writes `new_text` through
 * `normalizeNewFileLineEndings()`, which converts LF to CRLF when, and only
 * when, the *operating system* Cline ran on is Windows. The log does not
 * record which OS that was. Hashing `new_text` would therefore be right on
 * Linux and wrong on Windows, which is a hash agit did not compute over bytes
 * it holds: the one thing every adapter here refuses to emit. Edits are worse
 * still, since the result carries only a diff that the executor truncates at
 * 200 lines. So `editor` and `apply_patch` calls are recorded as the tool
 * calls they are, counted in the import report as edits agit cannot verify,
 * and no hash is invented.
 *
 * What that costs: `blame`, `why`, `fork`, `merge` and `diff` have nothing to
 * work with. What survives: `verify`, `replay`, `grep`, `show`, `stats`,
 * `sign`, `share`, `export` and the MCP server.
 *
 * Timestamps are epoch milliseconds on the message, and the golden fixture
 * omits them on user messages. A message without one inherits the last seen,
 * deterministically; the count is reported. One outside the years 0000 to
 * 9999 is treated the same way and counted on its own: past that, Date
 * either throws or prints an extended-year form that is not the shape SPEC
 * §2 documents. A file with none anywhere is refused rather than dated from
 * the clock (SPEC §7).
 *
 * The contract says unknown keys may appear without a version bump and
 * consumers should tolerate them. Tolerated here means counted, not dropped:
 * a content block of a type this adapter does not know, an entry that is not
 * a block at all, or a block whose text is not text is named in the skip
 * counts so nobody reads its absence as "nothing was there".
 *
 * A running session is shared from this same file, which Cline rewrites in
 * place as messages land. Under `ConvertOptions.live` the synthesized
 * `session.end` is held back, and the document's `updated_at` (its own
 * last-write time, bumped on every rewrite) stays out of `session.start`, so
 * each poll extends the previous one instead of rewriting streamed history.
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "cline-sdk";
const ADAPTER_VERSION = "0.1.0";

/** The only contract version published. A bump means breaking changes. */
export const CLINE_MESSAGES_VERSION = 1;

/** Tool names from sdk/packages/core/src/extensions/tools/constants.ts. */
const FILE_EDITING_TOOLS = new Set(["editor", "apply_patch"]);

type Rec = { [k: string]: Json };

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: Json | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Epoch milliseconds of 0000-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z. */
const MIN_TS_MS = -62167219200000;
const MAX_TS_MS = 253402300799999;

/**
 * The ISO form of a message's `ts`, or null when there is nothing usable.
 * Only epoch milliseconds inside the years 0000 to 9999 qualify. Past
 * 8.64e15 Date throws a bare "Invalid time value", which ended the whole
 * import without naming a message; inside Date's range but outside those
 * years it prints an extended year such as -001199-02-15T..., which is not
 * the shape SPEC §2 documents and which fixed-offset readers garble. Either
 * is treated as no timestamp at all, and the caller counts it.
 */
function isoTs(v: Json | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < MIN_TS_MS || v > MAX_TS_MS) return null;
  return new Date(v).toISOString();
}

function parseDocument(lines: string[]): Rec | undefined {
  try {
    return asRec(JSON.parse(lines.join("\n")));
  } catch {
    return undefined;
  }
}

/**
 * Is this a Cline SDK messages file? `version`, `sessionId` and `messages`
 * are all required by the contract, and the combination of a numeric version,
 * a string session id, and messages carrying `role` and `content` arrays does
 * not describe any other format agit reads. ATIF has `schema_version`; the
 * JSONL runtimes are not single documents at all.
 */
function isClineMessages(doc: Rec | undefined): boolean {
  if (doc === undefined) return false;
  if (typeof doc.version !== "number") return false;
  if (typeof doc.sessionId !== "string") return false;
  if (!Array.isArray(doc.messages)) return false;
  return doc.messages.every((m) => {
    const r = asRec(m);
    return r !== undefined && typeof r.role === "string" && Array.isArray(r.content);
  });
}

/** A tool_result's content is `unknown` in the contract: flatten whatever it is to text. */
function resultText(v: Json | undefined): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    return v
      .map((part) => {
        const p = asRec(part);
        if (p === undefined) return typeof part === "string" ? part : "";
        if (p.type === "text") return str(p.text) ?? "";
        return `[${str(p.type) ?? "content"}]`;
      })
      .filter((s) => s !== "")
      .join("\n");
  }
  return JSON.stringify(v);
}

export const clineSdkAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    return isClineMessages(parseDocument(lines));
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const doc = parseDocument(lines);
    if (!isClineMessages(doc)) throw new Error("not a Cline SDK messages file");
    const t = doc!;

    if (t.version !== CLINE_MESSAGES_VERSION) {
      // The contract bumps the version only for breaking changes, so this is
      // not a file this adapter knows how to read, and guessing at it would
      // mean guessing at what broke.
      throw new Error(
        `this file declares messages contract version ${String(t.version)}; ` +
          `this adapter reads version ${CLINE_MESSAGES_VERSION}, and a bump means breaking changes`,
      );
    }

    const messages = (t.messages as Json[]).filter((m): m is Rec => asRec(m) !== undefined);
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    if (messages.length === 0) throw new Error("this Cline SDK session has no messages");

    const firstTs = messages.map((m) => isoTs(m.ts)).find((iso) => iso !== null);
    if (firstTs === undefined) {
      throw new Error(
        "this Cline SDK session carries no timestamps on any message, and agit will not date events " +
          "from the clock (two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const sessionId = t.sessionId as string;
    const drafts: DraftEvent[] = [];
    let ts = firstTs;

    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime: "cline",
        // The contract records the model, not the Cline version. Absent, not guessed.
        runtimeVersion: null,
        nativeSessionId: sessionId,
        cwd: null,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        // Not the document's updated_at: that is the file's own last-write
        // time, bumped on every rewrite, so a live share of a running session
        // would see session.start change between polls and stop as a rewrite
        // of streamed history. The message timestamps already date the work.
        native: {
          contractVersion: CLINE_MESSAGES_VERSION,
          ...(str(t.agent) !== null ? { agent: str(t.agent) } : {}),
          ...(str(t.taskType) !== null ? { taskType: str(t.taskType) } : {}),
        },
      },
    });

    // agit has no system-message event (SPEC §5). Counted, not silently
    // dropped, and not filed as a user message it is not.
    if (typeof t.system_prompt === "string" && t.system_prompt !== "") skip("system-prompt");

    let inheritedTs = 0;
    let outOfRangeTs = 0;
    for (const m of messages) {
      const own = isoTs(m.ts);
      if (own !== null) ts = own;
      else if (typeof m.ts === "number") outOfRangeTs++;
      else inheritedTs++;

      const role = str(m.role);
      const id = str(m.id);
      const entries = m.content as Json[];
      const blocks = entries.filter((b): b is Rec => asRec(b) !== undefined);
      // A bare string or number where a block belongs is content the log
      // held and this adapter cannot read. Counted, so the report does not
      // claim a clean import over a message that lost its text.
      if (blocks.length < entries.length) skip("malformed-block:non-object", entries.length - blocks.length);
      const modelInfo = asRec(m.modelInfo);
      const model = modelInfo ? str(modelInfo.id) : null;

      if (role === "user") {
        // Text blocks are the user's message; tool_result blocks ride on user
        // messages in this format because there is no tool role at rest.
        const texts: string[] = [];
        for (const b of blocks) {
          if (b.type !== "text") continue;
          const text = str(b.text);
          if (text === null) skip("malformed-block:text");
          else if (text !== "") texts.push(text);
        }
        const text = texts.join("\n");
        if (text !== "") {
          drafts.push({
            ts,
            type: "message.user",
            payload: { text, native: { messageId: id } },
          });
        }
        for (const b of blocks) {
          if (b.type === "text") continue;
          if (b.type === "tool_result") {
            // No id means no pairing: null, never a shared placeholder, which
            // the exporters would read as one id and pair every id-less
            // result with every id-less call.
            const toolUseId = str(b.tool_use_id);
            if (toolUseId === null) skip("tool-result-without-id");
            drafts.push({
              ts,
              type: "tool.result",
              payload: {
                toolUseId,
                isError: b.is_error === true,
                output: resultText(b.content),
                structured: null,
                native: { messageId: id },
              },
            });
          } else {
            skip(`unknown-block:${str(b.type) ?? "(untyped)"}`);
          }
        }
      } else if (role === "assistant") {
        const out: Json[] = [];
        for (const b of blocks) {
          if (b.type === "thinking") {
            const thinking = str(b.thinking);
            if (thinking === null) skip("malformed-block:thinking");
            else if (thinking !== "") out.push({ type: "thinking", text: thinking });
          } else if (b.type === "text") {
            const text = str(b.text);
            if (text === null) skip("malformed-block:text");
            else if (text !== "") out.push({ type: "text", text });
          }
        }
        if (out.length > 0) {
          drafts.push({
            ts,
            type: "message.assistant",
            payload: {
              model,
              blocks: out,
              stopReason: null,
              native: {
                messageId: id,
                ...(modelInfo ? { provider: str(modelInfo.provider), family: str(modelInfo.family) } : {}),
              },
            },
          });
        }
        for (const b of blocks) {
          if (b.type === "thinking" || b.type === "text") continue;
          if (b.type === "tool_use") {
            const name = str(b.name) ?? "(unnamed)";
            // Same rule as tool_result: an id-less call gets null, so that
            // nothing downstream pairs it with a result it never had.
            const toolUseId = str(b.id);
            if (toolUseId === null) skip("tool-use-without-id");
            // SPEC §5.5 makes input an object. Anything else is recorded as
            // the empty call it is not, and the loss is named.
            const input = asRec(b.input);
            if (input === undefined && b.input !== undefined) skip("malformed-block:tool_use(input)");
            drafts.push({
              ts,
              type: "tool.call",
              payload: {
                toolUseId,
                name,
                input: input ?? {},
                native: { messageId: id },
              },
            });
            // The runtime edited a file here. Its content cannot be hashed
            // from this format (see the header), so the edit is named in the
            // report rather than turned into a file.diff over a guess.
            if (FILE_EDITING_TOOLS.has(name)) skip("file-edit-unverifiable");
          } else {
            skip(`unknown-block:${str(b.type) ?? "(untyped)"}`);
          }
        }

        const metrics = asRec(m.metrics);
        if (metrics !== undefined) {
          drafts.push({
            ts,
            type: "cost",
            payload: {
              model,
              usage: {
                inputTokens: num(metrics.inputTokens),
                outputTokens: num(metrics.outputTokens),
                cacheReadInputTokens: num(metrics.cacheReadTokens),
                cacheCreationInputTokens: num(metrics.cacheWriteTokens),
              },
              native: {
                messageId: id,
                requestId: null,
                // Only a number the source held. A null, a string or a
                // boolean here used to land as cost: 0, a figure the log
                // never stated, inside a hashed payload.
                ...(typeof metrics.cost === "number" && Number.isFinite(metrics.cost)
                  ? { cost: metrics.cost }
                  : {}),
              },
            },
          });
        }
      } else {
        skip(`unknown-role:${role ?? "(absent)"}`);
      }
    }

    if (inheritedTs > 0) skip("message-timestamp-inherited", inheritedTs);
    if (outOfRangeTs > 0) skip("message-timestamp-out-of-range", outOfRangeTs);

    // Live mode: the session has not ended, and a session.end here would
    // move on every poll that found a new message (ConvertOptions.live).
    if (!opts?.live) {
      drafts.push({
        ts,
        type: "session.end",
        payload: { reason: "messages-end", synthesized: true },
      });
    }

    return { sessionId, drafts, records: messages.length, skipped };
  },
};
