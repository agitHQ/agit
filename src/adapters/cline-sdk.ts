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
 * deterministically; the count is reported. A file with none anywhere is
 * refused rather than dated from the clock (SPEC §7).
 *
 * The contract says unknown keys may appear without a version bump and
 * consumers should tolerate them. Tolerated here means counted, not dropped:
 * a content block of a type this adapter does not know is named in the skip
 * counts so nobody reads its absence as "nothing was there".
 */

import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertResult } from "./adapter.js";

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

  convert(lines: string[]): ConvertResult {
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

    const stamped = messages.filter((m) => typeof m.ts === "number");
    if (stamped.length === 0) {
      throw new Error(
        "this Cline SDK session carries no timestamps on any message, and agit will not date events " +
          "from the clock (two imports of the same bytes must produce the same hashes, SPEC §7)",
      );
    }

    const sessionId = t.sessionId as string;
    const drafts: DraftEvent[] = [];
    let ts = new Date(stamped[0]!.ts as number).toISOString();

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
        native: {
          contractVersion: CLINE_MESSAGES_VERSION,
          ...(str(t.agent) !== null ? { agent: str(t.agent) } : {}),
          ...(str(t.taskType) !== null ? { taskType: str(t.taskType) } : {}),
          ...(str(t.updated_at) !== null ? { updatedAt: str(t.updated_at) } : {}),
        },
      },
    });

    // agit has no system-message event (SPEC §5). Counted, not silently
    // dropped, and not filed as a user message it is not.
    if (typeof t.system_prompt === "string" && t.system_prompt !== "") skip("system-prompt");

    let inheritedTs = 0;
    for (const m of messages) {
      if (typeof m.ts === "number") ts = new Date(m.ts).toISOString();
      else inheritedTs++;

      const role = str(m.role);
      const id = str(m.id);
      const blocks = (m.content as Json[]).filter((b): b is Rec => asRec(b) !== undefined);
      const modelInfo = asRec(m.modelInfo);
      const model = modelInfo ? str(modelInfo.id) : null;

      if (role === "user") {
        // Text blocks are the user's message; tool_result blocks ride on user
        // messages in this format because there is no tool role at rest.
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => str(b.text) ?? "")
          .filter((s) => s !== "")
          .join("\n");
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
            drafts.push({
              ts,
              type: "tool.result",
              payload: {
                toolUseId: str(b.tool_use_id) ?? "(missing)",
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
            if (thinking !== null && thinking !== "") out.push({ type: "thinking", text: thinking });
          } else if (b.type === "text") {
            const text = str(b.text);
            if (text !== null && text !== "") out.push({ type: "text", text });
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
            drafts.push({
              ts,
              type: "tool.call",
              payload: {
                toolUseId: str(b.id) ?? "(missing)",
                name,
                input: asRec(b.input) ?? {},
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
                ...(metrics.cost !== undefined ? { cost: num(metrics.cost) } : {}),
              },
            },
          });
        }
      } else {
        skip(`unknown-role:${role ?? "(absent)"}`);
      }
    }

    if (inheritedTs > 0) skip("message-timestamp-inherited", inheritedTs);

    drafts.push({
      ts,
      type: "session.end",
      payload: { reason: "messages-end", synthesized: true },
    });

    return { sessionId, drafts, records: messages.length, skipped };
  },
};
