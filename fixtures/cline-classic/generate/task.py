"""Build fixtures/cline-classic/<taskId>/{api_conversation_history,ui_messages}.json
the way Cline's VS Code-era task directory holds them (cline/cline v3.89.2,
apps/vscode/src/core/storage/disk.ts: each file is one JSON.stringify line).

Two tasks, one per tool-call shape:

  1736589300000  XML era (early 3.x). The transcript's messages carry no
                 `ts`, `metrics` or `modelInfo`; tool calls are XML inside
                 the assistant's text (parse-assistant-message.ts) and each
                 result is a text block "[name for '...'] Result:\n..."
                 (ToolResultUtils.pushToolResult). Dating and usage come
                 from ui_messages.json: `conversationHistoryIndex` on every
                 UI message (message-state.ts addToClineMessages) and
                 `api_req_started` with ClineApiReqInfo in `text`.
  1789136000000  Native era (3.89). Every message stamped `ts`, assistant
                 messages with `id`, `modelInfo`, `metrics` (content.ts);
                 tool calls are `tool_use` blocks and results `tool_result`
                 blocks whose content keeps the same "[name for '...']
                 Result:" framing.

The <final_file_content> in a write result is the normalized text
DiffViewProvider.saveChanges returns (line endings unified, trailing
whitespace trimmed, one newline appended) — which is why no file.diff comes
of it. Content is synthetic; the task ids are Date.now() at creation, as
the controller assigns them.

    python fixtures/cline-classic/generate/task.py fixtures/cline-classic
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
    "# Current Time\n1/11/2025, 9:55:00 AM (UTC, UTC+0:00)\n\n# Current Working Directory (/home/dev/hello) Files\n"
    "package.json\nsrc/\nsrc/index.ts\n\n# Current Mode\nACT MODE\n</environment_details>"
)

GREET = 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}'
SAVED_TAIL = (
    "\n\nIMPORTANT: For any future changes to this file, use the final_file_content shown above as your "
    "reference. This content reflects the current state of the file, including any auto-formatting "
    "(e.g., if you used single quotes but the formatter converted them to double quotes). Always base your "
    "SEARCH/REPLACE operations on this final version to ensure accuracy.\n\n"
)


def saved(path, content):
    return (
        f"The content was successfully saved to {path}.\n\nHere is the full, updated content of the file that was saved:\n\n"
        f'<final_file_content path="{path}">\n{content}\n</final_file_content>' + SAVED_TAIL
    )


def text(t):
    return {"type": "text", "text": t}


# ---------------------------------------------------------------------------
# Task 1: XML era.
T1 = 1736589300000  # 2025-01-11T09:55:00Z
XML_API = [
    {"role": "user", "content": [text("<task>\nAdd a greeting helper in src/greet.ts and use it from src/index.ts\n</task>"), text(ENV)]},
    {"role": "assistant", "content": [text("I'll look at the entry point first.\n\n<read_file>\n<path>src/index.ts</path>\n</read_file>")]},
    {"role": "user", "content": [text("[read_file for 'src/index.ts'] Result:\nconsole.log(\"hi\");\n"), text(ENV)]},
    {"role": "assistant", "content": [text(
        "Now the helper.\n\n<write_to_file>\n<path>src/greet.ts</path>\n<content>\n" + GREET + "\n</content>\n</write_to_file>"
    )]},
    {"role": "user", "content": [text("[write_to_file for 'src/greet.ts'] Result:\n" + saved("src/greet.ts", GREET)), text(ENV)]},
    {"role": "assistant", "content": [text(
        "<replace_in_file>\n<path>src/index.ts</path>\n<diff>\n------- SEARCH\nconsole.log(\"hi\");\n=======\n"
        "import { greet } from \"./greet\";\nconsole.log(greet(\"world\"));\n+++++++ REPLACE\n</diff>\n</replace_in_file>"
    )]},
    {"role": "user", "content": [text(
        "[replace_in_file for 'src/index.ts'] Result:\n"
        + saved("src/index.ts", 'import { greet } from "./greet";\nconsole.log(greet("world"));')
    ), text(ENV)]},
    {"role": "assistant", "content": [text(
        "Let me run the tests.\n\n<execute_command>\n<command>npm test</command>\n<requires_approval>false</requires_approval>\n</execute_command>"
    )]},
    {"role": "user", "content": [text(
        "[execute_command for 'npm test'] Result:\nThe tool execution failed with the following error:\n<error>\nCommand timed out after 30s\n</error>"
    ), text(ENV)]},
    {"role": "assistant", "content": [text(
        "The test runner hung, but the change itself is complete.\n\n<attempt_completion>\n<result>\n"
        "Added greet() in src/greet.ts and wired it into src/index.ts.\n</result>\n</attempt_completion>"
    )]},
    {"role": "user", "content": [text(
        "[attempt_completion] Result:\nThe user has provided feedback on the results. Consider their input to continue the task, "
        "and then attempt completion again.\n<feedback>\nlooks good, thanks\n</feedback>"
    ), text(ENV)]},
    {"role": "assistant", "content": [text("Glad it works.\n\n<attempt_completion>\n<result>\nDone.\n</result>\n</attempt_completion>")]},
]


def req(tokens_in, tokens_out, cache_writes, cache_reads, cost):
    return json.dumps(
        {"request": "(request elided)", "tokensIn": tokens_in, "tokensOut": tokens_out, "cacheWrites": cache_writes,
         "cacheReads": cache_reads, "cost": cost},
        separators=(",", ":"),
    )


def ui(ts, kind, sub, index, text_=None, **extra):
    m = {"ts": ts, "type": kind, kind: sub}
    if text_ is not None:
        m["text"] = text_
    m.update(extra)
    m["conversationHistoryIndex"] = index
    return m


XML_UI = [
    ui(T1, "say", "task", -1, "Add a greeting helper in src/greet.ts and use it from src/index.ts"),
    ui(T1 + 400, "say", "api_req_started", -1, req(1200, 40, 0, 0, 0.0042)),
    ui(T1 + 2100, "say", "text", 0, "I'll look at the entry point first."),
    ui(T1 + 2600, "say", "tool", 0, json.dumps({"tool": "readFile", "path": "src/index.ts", "content": "/home/dev/hello/src/index.ts"}, separators=(",", ":"))),
    ui(T1 + 3000, "say", "api_req_started", 1, req(1300, 90, 0, 1100, 0.0051)),
    ui(T1 + 4500, "say", "text", 2, "Now the helper."),
    ui(T1 + 5200, "ask", "tool", 2, json.dumps({"tool": "newFileCreated", "path": "src/greet.ts", "content": GREET}, separators=(",", ":"))),
    ui(T1 + 9000, "say", "api_req_started", 3, req(1500, 120, 200, 1200, 0.0066)),
    ui(T1 + 11000, "ask", "tool", 4, json.dumps({"tool": "editedExistingFile", "path": "src/index.ts"}, separators=(",", ":"))),
    ui(T1 + 14000, "say", "api_req_started", 5, req(1700, 60, 0, 1500, 0.0058)),
    ui(T1 + 15500, "say", "text", 6, "Let me run the tests."),
    ui(T1 + 16000, "ask", "command", 6, "npm test"),
    ui(T1 + 46500, "say", "api_req_started", 7, req(1800, 70, 0, 1600, 0.0060)),
    ui(T1 + 48000, "say", "text", 8, "The test runner hung, but the change itself is complete."),
    ui(T1 + 48800, "ask", "completion_result", 8, "Added greet() in src/greet.ts and wired it into src/index.ts."),
    ui(T1 + 60000, "say", "user_feedback", 8, "looks good, thanks"),
    ui(T1 + 60400, "say", "api_req_started", 9, req(1900, 30, 0, 1700, 0.0055)),
    ui(T1 + 61500, "say", "text", 10, "Glad it works."),
    ui(T1 + 61900, "ask", "completion_result", 10, "Done."),
]

write(str(T1), XML_API, XML_UI)

# ---------------------------------------------------------------------------
# Task 2: native era.
T2 = 1789136000000  # 2026-09-11T14:13:20Z
MODEL = {"modelId": "claude-sonnet-5", "providerId": "anthropic", "mode": "act"}


def metrics(prompt, completion, cached, cost):
    return {"tokens": {"prompt": prompt, "completion": completion, "cached": cached}, "cost": cost}


PATCH = (
    "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-console.log(\"hi\");\n"
    "+import { greet } from \"./greet\";\n+console.log(greet(\"world\"));\n*** End Patch\n"
)

NATIVE_API = [
    {"role": "user", "ts": T2, "content": [text("<task>\nUse the greet helper from src/index.ts\n</task>"), text(ENV)]},
    {
        "role": "assistant", "ts": T2 + 3200, "id": "msg_01native0001", "modelInfo": MODEL,
        "metrics": metrics(2100, 85, 1400, 0.0071),
        "content": [
            {"type": "thinking", "thinking": "The helper exists already; read the entry point, then patch it.", "signature": "sig-elided"},
            text("Reading the entry point."),
            {"type": "tool_use", "id": "toolu_01readidx", "name": "read_file", "input": {"path": "src/index.ts"}},
        ],
    },
    {"role": "user", "ts": T2 + 3400, "content": [
        {"type": "tool_result", "tool_use_id": "toolu_01readidx", "call_id": "c1", "content": "[read_file for 'src/index.ts'] Result:\nconsole.log(\"hi\");\n"},
        text(ENV),
    ]},
    {
        "role": "assistant", "ts": T2 + 7900, "id": "msg_01native0002", "modelInfo": MODEL,
        "metrics": metrics(2300, 140, 2000, 0.0084),
        "content": [
            {"type": "tool_use", "id": "toolu_01patch", "name": "apply_patch", "input": {"input": PATCH}},
        ],
    },
    {"role": "user", "ts": T2 + 9100, "content": [
        {"type": "tool_result", "tool_use_id": "toolu_01patch", "call_id": "c2", "content": "[apply_patch for patch application] Result:\nPatch applied successfully:\n- Updated: src/index.ts\n"},
        text(ENV),
    ]},
    {
        "role": "assistant", "ts": T2 + 12600, "id": "msg_01native0003", "modelInfo": MODEL,
        "metrics": metrics(2500, 40, 2300, 0.0062),
        "content": [
            {"type": "tool_use", "id": "toolu_01done", "name": "attempt_completion", "input": {"result": "index.ts now greets through the helper."}},
        ],
    },
]

NATIVE_UI = [
    ui(T2, "say", "task", -1, "Use the greet helper from src/index.ts"),
    ui(T2 + 300, "say", "api_req_started", -1, req(2100, 85, 0, 1400, 0.0071), modelInfo=MODEL),
    ui(T2 + 2000, "say", "reasoning", 0, "The helper exists already; read the entry point, then patch it."),
    ui(T2 + 2400, "say", "text", 0, "Reading the entry point."),
    ui(T2 + 2900, "say", "tool", 0, json.dumps({"tool": "readFile", "path": "src/index.ts"}, separators=(",", ":"))),
    ui(T2 + 3500, "say", "api_req_started", 1, req(2300, 140, 600, 1400, 0.0084), modelInfo=MODEL),
    ui(T2 + 7000, "ask", "tool", 2, json.dumps({"tool": "editedExistingFile", "path": "src/index.ts"}, separators=(",", ":"))),
    ui(T2 + 9200, "say", "api_req_started", 3, req(2500, 40, 300, 2000, 0.0062), modelInfo=MODEL),
    ui(T2 + 12000, "ask", "completion_result", 4, "index.ts now greets through the helper."),
]

write(str(T2), NATIVE_API, NATIVE_UI)
print("wrote", os.path.join(root, str(T1)), "and", os.path.join(root, str(T2)))
