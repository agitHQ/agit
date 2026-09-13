/**
 * Adapter for Cline's VS Code-era task directories (#63): the layout every
 * Cline release up to 3.89 wrote, and the one an installed history still
 * sits in after the 4.0 move to the SDK messages file (`cline-sdk`).
 *
 * Read from Cline's own source at v3.89.2, the last release of this layout
 * (paths under `apps/vscode/src/`):
 *
 *   - `core/storage/disk.ts` — a task lives at `<globalStorage>/tasks/<taskId>/`
 *     (`ensureTaskDirectoryExists`), with `api_conversation_history.json`,
 *     the model-facing transcript, saved as one `JSON.stringify` line of
 *     `ClineStorageMessage[]`, and `ui_messages.json`, the timeline the
 *     webview shows, saved the same way as `ClineMessage[]`. For the VS
 *     Code extension `<globalStorage>` is the editor's
 *     `User/globalStorage/saoudrizwan.claude-dev`; for the 3.x CLI it is
 *     `$CLINE_DIR/data` (`standalone/vscode-context.ts`, default `~/.cline`).
 *   - `core/controller/index.ts` — `taskId` is `Date.now().toString()` at
 *     creation, so the directory name is the session id and the adapter reads
 *     it from `ConvertOptions.path`; without a path one is derived from the
 *     first message, deterministically, and the report says so.
 *   - `shared/messages/content.ts` — a storage message is an Anthropic
 *     `MessageParam` (`role`, `content` as a string or blocks: `text`,
 *     `image`, `document`, `tool_use`, `tool_result`, `thinking`,
 *     `redacted_thinking`) plus Cline's own `ts` (epoch ms), `id`, `modelInfo`
 *     (`modelId`, `providerId`, `mode`) and `metrics` (`tokens.prompt`,
 *     `tokens.completion`, `tokens.cached`, `cost`). `core/task/index.ts`
 *     stamps `ts` on every message it appends and `metrics` / `modelInfo` on
 *     assistant messages, but only since 3.7x and 3.4x respectively: older
 *     tasks carry none, which is why the timeline file is read too.
 *   - `core/task/message-state.ts` — `addToClineMessages` stamps each UI
 *     message with `conversationHistoryIndex`, "the index of the last added
 *     message" of the transcript at that moment. So a transcript message
 *     with no `ts` is dated by the first UI message written after it (the
 *     first with an index at or past its own); a UI file that predates that
 *     field is paired by request order instead — the k-th `api_req_started`
 *     is the request the k-th user message opened (`recursivelyMakeClineRequests`
 *     says `api_req_started` then appends the user message) and the k-th
 *     assistant message closed. Either way the report counts it, and a task
 *     with no timestamp anywhere is refused (SPEC §7).
 *   - `shared/ExtensionMessage.ts` — an `api_req_started` UI message's `text`
 *     is JSON `ClineApiReqInfo`: `tokensIn`, `tokensOut`, `cacheWrites`,
 *     `cacheReads`, `cost`. That is the per-request usage for an assistant
 *     message that has no `metrics`; a message that has them uses its own
 *     (`cached` there folds cache writes and reads into one number, carried
 *     as `cacheReadInputTokens` and flagged in `native`). Dollar `cost` is
 *     counted, not stored (SPEC §5.9).
 *   - `core/assistant-message/parse-assistant-message.ts` and `shared/tools.ts`
 *     — before native tool calling (3.4x) a tool call is XML inside the
 *     assistant's text: `<write_to_file><path>…</path><content>…</content>
 *     </write_to_file>`, recognized only for the tool names in
 *     `ClineDefaultTool` and the parameter names in `toolParamNames`, values
 *     trimmed, `write_to_file`'s content taken between its first `<content>`
 *     and last `</content>`. `parseAssistantXml` below is that parser, so a
 *     transcript is split the way Cline split it. Both shapes can appear in
 *     one task, and each message is read for whichever it carries.
 *   - `core/task/tools/utils/ToolResultUtils.ts` — a result is written into
 *     the next user message as `"${description} Result:\n${text}"`, where
 *     `description` is `[name for '…']` (or `[name]`); as a `tool_result`
 *     block when the call had a native id, as a plain `text` block when it
 *     was XML. A text result is paired with the XML calls of the assistant
 *     message before it, in order, and the pairing carries a synthesized id
 *     (`xml:<message index>:<n>`, flagged in `native`); a result that pairs
 *     with nothing keeps a null id and is counted. `core/prompts/responses.ts`
 *     `toolError` opens with "The tool execution failed with the following
 *     error:", which is what marks `isError`.
 *   - `core/task/index.ts` `getEnvironmentDetails` — every user message
 *     carries a `text` block that is entirely `<environment_details>…
 *     </environment_details>`: Cline's own injected context (file tree, open
 *     tabs, time), not the person's words. Counted, not filed as a message.
 *     The first message opens with `<task>`, which is what `detect` looks for.
 *
 * **No `file.diff`, and the reason is exact.** The research that opened #63
 * expected this layout to be the one where edits verify, because
 * `<final_file_content>` in a write result carries the whole file. It does
 * not carry the file: `integrations/editor/DiffViewProvider.ts`
 * `saveChanges` builds it from the saved document with every line ending
 * rewritten to whichever the model used, trailing whitespace trimmed, and
 * exactly one newline appended — a normalized view for the model's next
 * edit, not the bytes on disk. A file saved without a trailing newline, or
 * with CRLF on Windows where the model wrote LF, hashes differently from that
 * text. Same rule as `cline-sdk`: a hash agit did not compute over bytes it
 * holds is not emitted. `write_to_file`, `replace_in_file`, `apply_patch`
 * and `new_rule` calls are recorded as the calls they are and counted as
 * edits agit cannot verify.
 *
 * Derived from the source above and validated against fixtures built to
 * it — including one in each tool-call shape — not against a real task
 * directory. A real task that disagrees names its unmapped blocks in the
 * import report. Roo Code forked this layout and is not claimed here: its
 * tool names and result strings are its own.
 *
 * A running task is shared from the same file, which Cline rewrites in place
 * on every message; under `ConvertOptions.live` the synthesized
 * `session.end` is held back so each poll extends the previous one.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "cline-classic";
const ADAPTER_VERSION = "0.1.0";

/** `ClineDefaultTool` in shared/tools.ts at v3.89.2: the only names the XML parser recognizes. */
export const XML_TOOL_NAMES: readonly string[] = [
  "ask_followup_question",
  "attempt_completion",
  "execute_command",
  "replace_in_file",
  "read_file",
  "write_to_file",
  "search_files",
  "list_files",
  "list_code_definition_names",
  "browser_action",
  "use_mcp_tool",
  "access_mcp_resource",
  "load_mcp_documentation",
  "new_task",
  "plan_mode_respond",
  "act_mode_respond",
  "focus_chain",
  "web_fetch",
  "web_search",
  "condense",
  "summarize_task",
  "report_bug",
  "new_rule",
  "apply_patch",
  "generate_explanation",
  "use_skill",
  "use_subagents",
];

/** `toolParamNames` in core/assistant-message/index.ts at v3.89.2. */
const XML_PARAM_NAMES: readonly string[] = [
  "command",
  "requires_approval",
  "path",
  "absolutePath",
  "content",
  "diff",
  "regex",
  "file_pattern",
  "recursive",
  "action",
  "url",
  "coordinate",
  "text",
  "query",
  "allowed_domains",
  "blocked_domains",
  "prompt",
  "server_name",
  "tool_name",
  "arguments",
  "uri",
  "question",
  "options",
  "response",
  "result",
  "context",
  "title",
  "what_happened",
  "steps_to_reproduce",
  "api_request_output",
  "additional_context",
  "needs_more_exploration",
  "task_progress",
  "timeout",
  "input",
  "from_ref",
  "to_ref",
  "skill_name",
  "prompt_1",
  "prompt_2",
  "prompt_3",
  "prompt_4",
  "prompt_5",
  "start_line",
  "end_line",
];

/** Tools whose call edits a file; see the header for why none becomes a file.diff. */
const FILE_EDITING_TOOLS = new Set(["write_to_file", "replace_in_file", "apply_patch", "new_rule"]);

/** responses.ts `toolError`: the one prefix that marks a result as an error. */
const TOOL_ERROR_PREFIX = "The tool execution failed with the following error:";

/** ToolResultUtils: `"${description} Result:\n${text}"`, description `[name for '…']` or `[name]`. */
const RESULT_PREFIX = /^\[([a-z_]+)(?: [^\n]*?)?\] Result:\n/;

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

/** ISO form of an epoch-ms `ts` inside the years 0000–9999; null for anything else (see cline-sdk). */
function isoTs(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < MIN_TS_MS || v > MAX_TS_MS) return null;
  return new Date(v).toISOString();
}

export interface XmlText {
  type: "text";
  text: string;
}

export interface XmlTool {
  type: "tool";
  name: string;
  params: Record<string, string>;
  /** The message ended before the closing tag: Cline records the call anyway. */
  partial: boolean;
}

function endsAt(s: string, tag: string, i: number): boolean {
  return i >= tag.length - 1 && s.startsWith(tag, i - tag.length + 1);
}

/**
 * Cline's `parseAssistantMessageV2`, block for block: a scan that, at each
 * position, asks whether a known tag ends there. Outside a tool, a tool's
 * opening tag starts one and closes the text before it; inside a tool, a
 * parameter's opening tag starts a value that only that parameter's closing
 * tag ends, and the tool's own closing tag finishes the call. Text and
 * values are trimmed, empty text dropped, and `write_to_file`'s content is
 * re-cut between its first `<content>` and last `</content>` so a closing
 * tag inside the file does not truncate it. Every tag ends in `>`, so only
 * those positions are examined — the one shortcut, and it changes nothing.
 */
export function parseAssistantXml(s: string): (XmlText | XmlTool)[] {
  const out: (XmlText | XmlTool)[] = [];
  let textStart = 0;
  let tool: XmlTool | undefined;
  let toolStart = 0;
  let param: string | undefined;
  let paramStart = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) !== 62 /* > */) continue;
    if (tool !== undefined && param !== undefined) {
      const close = `</${param}>`;
      if (!endsAt(s, close, i)) continue;
      tool.params[param] = s.slice(paramStart, i - close.length + 1).trim();
      param = undefined;
    }
    if (tool !== undefined) {
      let started = false;
      for (const p of XML_PARAM_NAMES) {
        if (endsAt(s, `<${p}>`, i)) {
          param = p;
          paramStart = i + 1;
          started = true;
          break;
        }
      }
      if (started) continue;
      const close = `</${tool.name}>`;
      if (!endsAt(s, close, i)) continue;
      const inner = s.slice(toolStart, i - close.length + 1);
      if (tool.name === "write_to_file" && inner.includes("<content>")) {
        const a = inner.indexOf("<content>");
        const b = inner.lastIndexOf("</content>");
        if (a !== -1 && b !== -1 && b > a)
          tool.params.content = inner.slice(a + "<content>".length, b).trim();
      }
      tool.partial = false;
      out.push(tool);
      tool = undefined;
      textStart = i + 1;
      continue;
    }
    for (const name of XML_TOOL_NAMES) {
      const tag = `<${name}>`;
      if (!endsAt(s, tag, i)) continue;
      const text = s.slice(textStart, i - tag.length + 1).trim();
      if (text !== "") out.push({ type: "text", text });
      tool = { type: "tool", name, params: {}, partial: true };
      toolStart = i + 1;
      break;
    }
  }
  if (tool !== undefined) {
    if (param !== undefined) tool.params[param] = s.slice(paramStart).trim();
    out.push(tool);
  } else {
    const text = s.slice(textStart).trim();
    if (text !== "") out.push({ type: "text", text });
  }
  return out;
}

function parseDocument(lines: string[]): unknown {
  try {
    return JSON.parse(lines.join("\n"));
  } catch {
    return undefined;
  }
}

/** The text a user message opens with: a string content, or its first text block. */
function openingText(m: Rec): string | null {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return null;
  for (const b of m.content) {
    const r = asRec(b);
    if (r !== undefined && r.type === "text") return str(r.text);
  }
  return null;
}

/**
 * Is this a Cline task transcript? A non-empty array of `{role, content}`
 * whose first entry is the user's `<task>` — the shape `startTask` writes and
 * the one entry context truncation never removes. A role other than the two
 * Cline writes is counted at conversion, not refused here. The other single-document
 * formats agit reads (Cline SDK, ATIF, Gemini's legacy `.json`) are objects,
 * and the JSONL runtimes are not one document at all.
 */
function isClassicTranscript(doc: unknown): doc is Rec[] {
  if (!Array.isArray(doc) || doc.length === 0) return false;
  for (const m of doc) {
    const r = asRec(m);
    if (r === undefined) return false;
    if (typeof r.role !== "string") return false;
    if (typeof r.content !== "string" && !Array.isArray(r.content)) return false;
  }
  const first = doc[0] as Rec;
  return first.role === "user" && (openingText(first)?.startsWith("<task>") ?? false);
}

interface UiMessage {
  ts: string | null;
  say: string | null;
  index: number | null;
  /** `ClineApiReqInfo` on an `api_req_started`, when its text parses. */
  req: Rec | null;
}

/** `ui_messages.json` beside the transcript, in file order; null when absent or unreadable. */
function readUiMessages(transcriptPath: string | undefined): UiMessage[] | null {
  if (transcriptPath === undefined) return null;
  const p = join(dirname(transcriptPath), "ui_messages.json");
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: UiMessage[] = [];
  for (const m of parsed) {
    const r = asRec(m);
    if (r === undefined) continue;
    const say = str(r.say);
    let req: Rec | null = null;
    if (say === "api_req_started" && typeof r.text === "string") {
      try {
        req = asRec(JSON.parse(r.text)) ?? null;
      } catch {
        req = null;
      }
    }
    const index =
      typeof r.conversationHistoryIndex === "number" && Number.isInteger(r.conversationHistoryIndex)
        ? r.conversationHistoryIndex
        : null;
    out.push({ ts: isoTs(r.ts), say, index, req });
  }
  return out;
}

/**
 * Per transcript message: the UI-derived timestamp and the `api_req_started`
 * info for the request that produced it, by whichever pairing the UI file
 * supports (see the header). `byIndex` says which.
 */
interface UiPairing {
  ts: (string | null)[];
  req: (Rec | null)[];
  byIndex: boolean;
}

function pairUi(ui: UiMessage[], messages: Rec[]): UiPairing {
  const n = messages.length;
  const ts: (string | null)[] = new Array<string | null>(n).fill(null);
  const req: (Rec | null)[] = new Array<Rec | null>(n).fill(null);
  const byIndex = ui.some((m) => m.index !== null);
  if (byIndex) {
    // Message i is dated by the first UI message written after it: the
    // earliest, in file order, whose index is i or more. An index of -1
    // (nothing appended yet: the `task` line and the first request) dates
    // the first message, which is the task's own submission; indices past
    // the end count as the last message's.
    const firstPos: number[] = new Array<number>(n).fill(-1);
    for (let pos = 0; pos < ui.length; pos++) {
      const m = ui[pos]!;
      if (m.index === null || m.ts === null) continue;
      const k = Math.min(Math.max(m.index, 0), n - 1);
      if (firstPos[k] === -1) firstPos[k] = pos;
    }
    let best = -1;
    for (let i = n - 1; i >= 0; i--) {
      const p = firstPos[i]!;
      if (p !== -1 && (best === -1 || p < best)) best = p;
      if (best !== -1) ts[i] = ui[best]!.ts;
    }
    // An api_req_started is said before the request's user message is
    // appended, so its index is the message before that one; the assistant
    // message it produced is two past it.
    for (const m of ui) {
      if (m.req === null || m.index === null) continue;
      const assistant = m.index + 2;
      if (assistant >= 0 && assistant < n && messages[assistant]!.role === "assistant")
        req[assistant] = m.req;
    }
    return { ts, req, byIndex };
  }
  // No index anywhere: the k-th request is the k-th user message and the
  // k-th assistant message. A user message is dated by its api_req_started;
  // an assistant message by the last UI message before the next request.
  const starts: number[] = [];
  for (let pos = 0; pos < ui.length; pos++) if (ui[pos]!.say === "api_req_started") starts.push(pos);
  const lastTsBefore = (pos: number): string | null => {
    for (let p = pos - 1; p >= 0; p--) if (ui[p]!.ts !== null) return ui[p]!.ts;
    return null;
  };
  let users = 0;
  let assistants = 0;
  for (let i = 0; i < n; i++) {
    const role = messages[i]!.role;
    if (role === "user") {
      const pos = starts[users];
      if (pos !== undefined) ts[i] = ui[pos]!.ts;
      users++;
    } else if (role === "assistant") {
      const k = assistants;
      if (k < starts.length) {
        const next = starts[k + 1];
        ts[i] = lastTsBefore(next ?? ui.length);
        req[i] = ui[starts[k]!]!.req;
      }
      assistants++;
    }
  }
  return { ts, req, byIndex };
}

/** A tool_result's content is a string or blocks: flatten to text. */
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

/** The result's body after the `[name for '…'] Result:\n` framing, and the name. */
function splitResult(text: string): { tool: string; body: string } | null {
  const m = RESULT_PREFIX.exec(text);
  if (m === null) return null;
  return { tool: m[1]!, body: text.slice(m[0].length) };
}

function isEnvironmentDetails(text: string): boolean {
  const t = text.trim();
  return t.startsWith("<environment_details>") && t.endsWith("</environment_details>");
}

interface XmlCall {
  id: string;
  name: string;
}

export const clineClassicAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    return isClassicTranscript(parseDocument(lines));
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const doc = parseDocument(lines);
    if (!isClassicTranscript(doc))
      throw new Error("not a Cline task transcript (api_conversation_history.json)");
    const messages = doc;
    const skipped: Record<string, number> = {};
    const skip = (what: string, n = 1): void => {
      skipped[what] = (skipped[what] ?? 0) + n;
    };

    const ui = readUiMessages(opts?.path);
    if (opts?.path !== undefined && ui === null && existsSync(join(dirname(opts.path), "ui_messages.json"))) {
      skip("ui-messages-unreadable");
    }
    const paired = ui === null ? null : pairUi(ui, messages);

    // Every message's date, before anything is emitted: the first one dates
    // session.start, and a transcript with none at all is refused rather than
    // dated from the clock (SPEC §7).
    const dated: (string | null)[] = messages.map((m, i) => isoTs(m.ts) ?? paired?.ts[i] ?? null);
    const firstTs = dated.find((t) => t !== null);
    if (firstTs === undefined || firstTs === null) {
      throw new Error(
        "this Cline task carries no timestamp agit can read: no message has `ts`, and no readable " +
          "ui_messages.json sits beside the transcript to date it from (SPEC §7)",
      );
    }

    // The directory's name, from an absolute form of the path so a relative
    // `api_conversation_history.json` still names its task.
    const taskId = opts?.path !== undefined ? basename(dirname(resolve(opts.path))) : null;
    let sessionId: string;
    if (taskId !== null && taskId !== "") {
      sessionId = taskId;
    } else {
      sessionId = `cline-${createHash("sha256").update(JSON.stringify(messages[0]), "utf8").digest("hex").slice(0, 12)}`;
      skip("session-id-derived-without-path");
    }

    const drafts: DraftEvent[] = [];
    let ts = firstTs;
    drafts.push({
      ts,
      type: "session.start",
      payload: {
        runtime: "cline",
        runtimeVersion: null,
        nativeSessionId: sessionId,
        cwd: null,
        gitBranch: null,
        adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
        native: { taskId: sessionId, layout: "api_conversation_history" },
      },
    });

    let fromUi = 0;
    let byOrder = 0;
    let inherited = 0;
    let outOfRange = 0;
    // XML calls of the latest assistant message, for the text results that follow.
    let pendingXml: XmlCall[] = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const own = isoTs(m.ts);
      if (own !== null) ts = own;
      else if (typeof m.ts === "number") {
        outOfRange++;
        if (dated[i] !== null) ts = dated[i]!;
        else inherited++;
      } else if (dated[i] !== null) {
        ts = dated[i]!;
        fromUi++;
        if (paired !== null && !paired.byIndex) byOrder++;
      } else {
        inherited++;
      }

      const id = str(m.id);
      const entries: Json[] =
        typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Json[]);
      const blocks = entries.filter((b): b is Rec => asRec(b) !== undefined);
      if (blocks.length < entries.length) skip("malformed-block:non-object", entries.length - blocks.length);

      if (m.role === "user") {
        const texts: string[] = [];
        const results: { toolUseId: string | null; output: string; isError: boolean; native: Rec }[] = [];
        let xmlAt = 0;
        for (const b of blocks) {
          if (b.type === "text") {
            const text = str(b.text);
            if (text === null) {
              skip("malformed-block:text");
              continue;
            }
            if (text === "") continue;
            const split = splitResult(text);
            if (split !== null) {
              // A text result belongs to the k-th XML call of the message
              // before, when the names agree; anything else is a result of
              // nothing this adapter saw.
              const call = pendingXml[xmlAt];
              let toolUseId: string | null = null;
              if (call !== undefined && call.name === split.tool) {
                toolUseId = call.id;
                xmlAt++;
              } else {
                skip("tool-result-unpaired");
              }
              results.push({
                toolUseId,
                output: text,
                isError: false,
                native: { index: i, tool: split.tool, xml: true },
              });
            } else if (isEnvironmentDetails(text)) {
              skip("environment-details");
            } else {
              texts.push(text);
            }
          } else if (b.type === "tool_result") {
            const toolUseId = str(b.tool_use_id);
            if (toolUseId === null) skip("tool-result-without-id");
            const output = resultText(b.content);
            // Cline never sets is_error on its own results; a file that does is believed.
            results.push({
              toolUseId,
              output,
              isError: b.is_error === true,
              native: { index: i, tool: splitResult(output)?.tool ?? null, xml: false },
            });
          } else {
            skip(`unknown-block:${str(b.type) ?? "(untyped)"}`);
          }
        }
        const text = texts.join("\n");
        if (text !== "") {
          drafts.push({ ts, type: "message.user", payload: { text, native: { index: i, messageId: id } } });
        }
        for (const r of results) {
          const body = splitResult(r.output)?.body ?? r.output;
          drafts.push({
            ts,
            type: "tool.result",
            payload: {
              toolUseId: r.toolUseId,
              isError: r.isError || body.startsWith(TOOL_ERROR_PREFIX),
              output: r.output,
              structured: null,
              native: r.native,
            },
          });
        }
        pendingXml = [];
      } else if (m.role === "assistant") {
        const modelInfo = asRec(m.modelInfo);
        const model = modelInfo ? str(modelInfo.modelId) : null;
        const out: Json[] = [];
        const calls: { toolUseId: string | null; name: string; input: Rec; native: Rec }[] = [];
        let xmlN = 0;
        for (const b of blocks) {
          if (b.type === "thinking") {
            const thinking = str(b.thinking);
            if (thinking === null) skip("malformed-block:thinking");
            else if (thinking !== "") out.push({ type: "thinking", text: thinking });
          } else if (b.type === "redacted_thinking") {
            skip("redacted-thinking");
          } else if (b.type === "text") {
            const text = str(b.text);
            if (text === null) {
              skip("malformed-block:text");
              continue;
            }
            for (const part of parseAssistantXml(text)) {
              if (part.type === "text") {
                out.push({ type: "text", text: part.text });
                continue;
              }
              const toolUseId = `xml:${i}:${xmlN++}`;
              if (part.partial) skip("xml-tool-partial");
              calls.push({
                toolUseId,
                name: part.name,
                input: { ...part.params },
                native: { index: i, messageId: id, xml: true, partial: part.partial },
              });
            }
          } else if (b.type === "tool_use") {
            const name = str(b.name) ?? "(unnamed)";
            const toolUseId = str(b.id);
            if (toolUseId === null) skip("tool-use-without-id");
            const input = asRec(b.input);
            if (input === undefined && b.input !== undefined) skip("malformed-block:tool_use(input)");
            calls.push({
              toolUseId,
              name,
              input: input ?? {},
              native: { index: i, messageId: id, xml: false },
            });
          } else {
            skip(`unknown-block:${str(b.type) ?? "(untyped)"}`);
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
                index: i,
                messageId: id,
                ...(modelInfo ? { provider: str(modelInfo.providerId), mode: str(modelInfo.mode) } : {}),
              },
            },
          });
        }
        pendingXml = [];
        for (const c of calls) {
          drafts.push({
            ts,
            type: "tool.call",
            payload: { toolUseId: c.toolUseId, name: c.name, input: c.input, native: c.native },
          });
          if (FILE_EDITING_TOOLS.has(c.name)) skip("file-edit-unverifiable");
          if (c.native.xml === true && c.toolUseId !== null)
            pendingXml.push({ id: c.toolUseId, name: c.name });
        }

        const metrics = asRec(m.metrics);
        const tokens = metrics ? asRec(metrics.tokens) : undefined;
        if (metrics !== undefined) {
          if (metrics.cost !== undefined && metrics.cost !== null) skip("cost-usd-not-stored (SPEC §5.9)");
          drafts.push({
            ts,
            type: "cost",
            payload: {
              model,
              usage: {
                inputTokens: num(tokens?.prompt),
                outputTokens: num(tokens?.completion),
                // Cline sums cache writes and reads into one number.
                cacheReadInputTokens: num(tokens?.cached),
                cacheCreationInputTokens: 0,
              },
              native: { index: i, messageId: id, requestId: null, cachedTokensIncludeWrites: true },
            },
          });
        } else {
          const req = paired?.req[i] ?? null;
          if (req !== null && (typeof req.tokensIn === "number" || typeof req.tokensOut === "number")) {
            if (req.cost !== undefined && req.cost !== null) skip("cost-usd-not-stored (SPEC §5.9)");
            skip("cost-from-ui-messages");
            drafts.push({
              ts,
              type: "cost",
              payload: {
                model,
                usage: {
                  inputTokens: num(req.tokensIn),
                  outputTokens: num(req.tokensOut),
                  cacheReadInputTokens: num(req.cacheReads),
                  cacheCreationInputTokens: num(req.cacheWrites),
                },
                native: { index: i, messageId: id, requestId: null, source: "ui_messages.json" },
              },
            });
          }
        }
      } else {
        skip(`unknown-role:${str(m.role) ?? "(absent)"}`);
      }
    }

    if (fromUi > 0) skip("message-timestamp-from-ui-messages", fromUi);
    if (byOrder > 0) skip("message-timestamp-by-request-order", byOrder);
    if (inherited > 0) skip("message-timestamp-inherited", inherited);
    if (outOfRange > 0) skip("message-timestamp-out-of-range", outOfRange);

    if (!opts?.live) {
      drafts.push({ ts, type: "session.end", payload: { reason: "messages-end", synthesized: true } });
    }

    return { sessionId, drafts, records: messages.length, skipped };
  },
};
