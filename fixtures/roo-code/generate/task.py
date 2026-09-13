"""Build fixtures/roo-code/<taskId>/{api_conversation_history,ui_messages}.json
the way Roo Code's task directory holds them (RooCodeInc/Roo-Code, archived
May 2026; src/core/task-persistence/{apiMessages,taskMessages}.ts write each
file with safeWriteJson as one JSON document). Roo forked Cline's layout;
the adapter is fixtures/cline-classic's, in its Roo dialect.

Two tasks, one per tool-call shape:

  0190a1b2-c3d4-7e5f-8a6b-9c0d1e2f3a4b  XML era (Roo 3.0–3.2x). Messages carry
                 no `ts` (3.0.0 stamped none); tool calls are XML with Roo's
                 own names (packages/types/src/tool.ts at v3.20.0), and each
                 result is TWO text blocks — "[name for '...'] Result:" alone,
                 then the content (presentAssistantMessage.ts pushToolResult
                 at v3.20.0). ui_messages.json has no conversationHistoryIndex
                 (Roo never wrote one), so pairing is by request order.
  0192f0e1-d2c3-7b4a-9586-7768594a3b2c  Native era (Roo 3.54). Every message
                 stamped `ts` (Task.ts addToApiConversationHistory); the first
                 is `<user_message>` (Task.ts startTask); tool calls are
                 `tool_use` blocks and results `tool_result` blocks with no
                 framing; a failed tool's result is responses.ts `toolError`
                 JSON; the transcript also holds a condensed summary
                 (`isSummary`), a message it hides (`condenseParent`), a
                 truncation marker and a reasoning item
                 (task-persistence/apiMessages.ts ApiMessage).

Task ids are uuidv7 (Task.ts). Content is synthetic.

    python fixtures/roo-code/generate/task.py fixtures/roo-code
"""
import json, os, sys

root = sys.argv[1]


def write(task_id, api, ui):
    out = os.path.join(root, task_id)
    os.makedirs(out, exist_ok=True)
    for name, doc in (("api_conversation_history.json", api), ("ui_messages.json", ui)):
        with open(os.path.join(out, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))


ENV = (
    "<environment_details>\n# VSCode Visible Files\nsrc/index.ts\n\n# VSCode Open Tabs\nsrc/index.ts\n\n"
    "# Current Time\n2/3/2025, 4:20:00 PM (UTC, UTC+0:00)\n\n# Current Mode\n<slug>code</slug>\n<name>Code</name>\n"
    "</environment_details>"
)


def text(t):
    return {"type": "text", "text": t}


def req(tokens_in, tokens_out, cache_writes, cache_reads, cost):
    return json.dumps(
        {"request": "(request elided)", "tokensIn": tokens_in, "tokensOut": tokens_out, "cacheWrites": cache_writes,
         "cacheReads": cache_reads, "cost": cost},
        separators=(",", ":"),
    )


def ui(ts, kind, sub, text_=None, **extra):
    m = {"ts": ts, "type": kind, kind: sub}
    if text_ is not None:
        m["text"] = text_
    m.update(extra)
    return m


# ---------------------------------------------------------------------------
# Task 1: XML era, request-order pairing.
XML_ID = "0190a1b2-c3d4-7e5f-8a6b-9c0d1e2f3a4b"
T1 = 1738599600000  # 2025-02-03T16:20:00Z
DIFF = (
    "<<<<<<< SEARCH\n:start_line:1\n-------\nconsole.log(\"hi\");\n=======\n"
    "import { greet } from \"./greet\";\nconsole.log(greet(\"world\"));\n>>>>>>> REPLACE"
)
XML_API = [
    {"role": "user", "content": [text("<task>\nWire greet() into src/index.ts\n</task>"), text(ENV)]},
    {"role": "assistant", "content": [text("I'll read the entry point.\n\n<read_file>\n<path>src/index.ts</path>\n</read_file>")]},
    {"role": "user", "content": [
        text("[read_file for 'src/index.ts'] Result:"),
        text("<file><path>src/index.ts</path>\n<content lines=\"1-1\">\n1 | console.log(\"hi\");\n</content>\n</file>"),
        text(ENV),
    ]},
    {"role": "assistant", "content": [text(
        "<apply_diff>\n<path>src/index.ts</path>\n<diff>\n" + DIFF + "\n</diff>\n</apply_diff>"
    )]},
    {"role": "user", "content": [
        text("[apply_diff for 'src/index.ts'] Result:"),
        text("Changes successfully applied to src/index.ts:\n\n\n\n<notice>\n<i>You do not need to re-read the file, as you have seen all changes</i>\n</notice>"),
        text(ENV),
    ]},
    {"role": "assistant", "content": [text(
        "<execute_command>\n<command>npm test</command>\n</execute_command>"
    )]},
    {"role": "user", "content": [
        text("[execute_command for 'npm test'] Result:"),
        text("The tool execution failed with the following error:\n<error>\nCommand timed out after 30s\n</error>"),
        text(ENV),
    ]},
    {"role": "assistant", "content": [text(
        "The tests hung; the change is in.\n\n<switch_mode>\n<mode_slug>ask</mode_slug>\n<reason>done editing</reason>\n</switch_mode>"
    )]},
    {"role": "user", "content": [
        text("[switch_mode to 'ask' because: done editing] Result:"),
        text("Successfully switched from Code mode to Ask mode because: done editing."),
        text(ENV),
    ]},
    {"role": "assistant", "content": [text("<attempt_completion>\n<result>\nindex.ts now greets through the helper.\n</result>\n</attempt_completion>")]},
]
XML_UI = [
    ui(T1, "say", "text", "Wire greet() into src/index.ts"),
    ui(T1 + 300, "say", "api_req_started", req(900, 30, 0, 0, 0.003)),
    ui(T1 + 2000, "say", "text", "I'll read the entry point."),
    ui(T1 + 2300, "ask", "tool", json.dumps({"tool": "readFile", "path": "src/index.ts"}, separators=(",", ":"))),
    ui(T1 + 3000, "say", "api_req_started", req(1100, 80, 200, 700, 0.004)),
    ui(T1 + 5000, "ask", "tool", json.dumps({"tool": "appliedDiff", "path": "src/index.ts"}, separators=(",", ":"))),
    ui(T1 + 7000, "say", "api_req_started", req(1300, 20, 0, 900, 0.003)),
    ui(T1 + 8000, "ask", "command", "npm test"),
    ui(T1 + 38500, "say", "api_req_started", req(1400, 40, 0, 1100, 0.003)),
    ui(T1 + 40000, "say", "text", "The tests hung; the change is in."),
    ui(T1 + 40500, "ask", "tool", json.dumps({"tool": "switchMode", "mode": "ask", "reason": "done editing"}, separators=(",", ":"))),
    ui(T1 + 42000, "say", "api_req_started", req(1500, 25, 0, 1300, 0.003)),
    ui(T1 + 43500, "ask", "completion_result", "index.ts now greets through the helper."),
]
write(XML_ID, XML_API, XML_UI)

# ---------------------------------------------------------------------------
# Task 2: native era, self-dated, with Roo's non-message entries.
NATIVE_ID = "0192f0e1-d2c3-7b4a-9586-7768594a3b2c"
T2 = 1778500000000  # 2026-05-11T11:46:40Z
NATIVE_API = [
    {"role": "user", "ts": T2, "content": [text("<user_message>\nRename greet to hello\n</user_message>"), text(ENV)]},
    {"role": "assistant", "ts": T2 + 2500, "id": "resp_roo_0001", "condenseParent": "cnd_1", "content": [
        {"type": "tool_use", "id": "call_readgreet", "name": "read_file", "input": {"files": [{"path": "src/greet.ts"}]}},
    ]},
    {"role": "user", "ts": T2 + 2700, "condenseParent": "cnd_1", "content": [
        {"type": "tool_result", "tool_use_id": "call_readgreet", "content": "<files>\n<file><path>src/greet.ts</path>\n<content lines=\"1-3\">\n1 | export function greet() {}\n</content>\n</file>\n</files>"},
        text(ENV),
    ]},
    {"role": "assistant", "ts": T2 + 4000, "isSummary": True, "condenseId": "cnd_1", "content": [
        text("Summary: the user wants greet renamed to hello; src/greet.ts exports greet()."),
    ]},
    {"role": "assistant", "ts": T2 + 6000, "id": "resp_roo_0002", "type": "reasoning", "summary": [], "encrypted_content": "opaque"},
    {"role": "assistant", "ts": T2 + 6100, "id": "resp_roo_0003", "content": [
        {"type": "tool_use", "id": "call_edit", "name": "search_replace", "input": {"file_path": "src/greet.ts", "old_string": "greet", "new_string": "hello"}},
    ]},
    {"role": "user", "ts": T2 + 6900, "content": [
        {"type": "tool_result", "tool_use_id": "call_edit", "content": json.dumps({"status": "error", "message": "The tool execution failed", "error": "old_string not found"}, separators=(",", ":"))},
        text(ENV),
    ]},
    {"role": "user", "ts": T2 + 7000, "isTruncationMarker": True, "truncationId": "trn_1", "content": [text("[Earlier messages truncated]")]},
    {"role": "assistant", "ts": T2 + 9000, "id": "resp_roo_0004", "content": [
        text("The identifier was already renamed."),
        {"type": "tool_use", "id": "call_done", "name": "attempt_completion", "input": {"result": "greet is already hello."}},
    ]},
]
NATIVE_UI = [
    ui(T2, "say", "text", "Rename greet to hello"),
    ui(T2 + 200, "say", "api_req_started", req(1800, 60, 0, 1200, 0.006), apiProtocol="anthropic"),
    ui(T2 + 2400, "ask", "tool", json.dumps({"tool": "readFile", "path": "src/greet.ts"}, separators=(",", ":"))),
    ui(T2 + 3900, "say", "condense_context", "", contextCondense={"cost": 0.001, "prevContextTokens": 2000, "newContextTokens": 400, "summary": "…", "condenseId": "cnd_1"}),
    ui(T2 + 4100, "say", "api_req_started", req(700, 90, 0, 0, 0.004), apiProtocol="anthropic"),
    ui(T2 + 4200, "say", "api_req_started", req(700, 90, 0, 0, 0.004), apiProtocol="anthropic"),
    ui(T2 + 6800, "ask", "tool", json.dumps({"tool": "searchReplace", "path": "src/greet.ts"}, separators=(",", ":"))),
    ui(T2 + 7100, "say", "api_req_started", req(900, 40, 0, 600, 0.003), apiProtocol="anthropic"),
    ui(T2 + 9200, "ask", "completion_result", "greet is already hello."),
]
write(NATIVE_ID, NATIVE_API, NATIVE_UI)
print("wrote", os.path.join(root, XML_ID), "and", os.path.join(root, NATIVE_ID))
