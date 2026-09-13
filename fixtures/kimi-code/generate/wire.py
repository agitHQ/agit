"""Build fixtures/kimi-code/<session-id>/wire.jsonl the way Kimi Code CLI's
WireFile.append_message writes it.

Record shapes are from src/kimi_cli/wire/file.py (WireFileMetadata,
WireMessageRecord), src/kimi_cli/wire/types.py (the Event union and
WireMessageEnvelope, `type` = class name, `payload` = model_dump) and the
kosong package (TextPart, ThinkPart, ToolCall, ToolCallPart, ToolResult,
TokenUsage) in MoonshotAI/kimi-cli. The event order within a step mirrors
the agent loop: StepBegin, streamed ThinkPart/TextPart pieces, a ToolCall
whose arguments arrive in ToolCallParts, the StatusUpdate with the step's
token_usage, then the ToolResults, then the next StepBegin. The session id
is the directory name, as the docs say. Content is synthetic.

    python fixtures/kimi-code/generate/wire.py fixtures/kimi-code
"""
import json, os, sys

root = sys.argv[1]
SID = "01JRZ3K2Y7Q8W6X5V4T3S2R1P0"
out = os.path.join(root, SID)
os.makedirs(out, exist_ok=True)

T0 = 1775030400.0  # 2026-04-01T08:00:00Z
records = []


def emit(t, type_, payload):
    records.append({"timestamp": T0 + t, "message": {"type": type_, "payload": payload}})


def usage(input_other, output, cache_read=0, cache_creation=0):
    return {"input_other": input_other, "output": output, "input_cache_read": cache_read, "input_cache_creation": cache_creation}


# turn 1: a question answered with one tool call whose arguments stream in
emit(0.0, "TurnBegin", {"user_input": "What does the Makefile build?"})
emit(0.1, "StepBegin", {"n": 1})
emit(0.5, "ThinkPart", {"type": "think", "think": "I should read the ", "encrypted": None})
emit(0.6, "ThinkPart", {"type": "think", "think": "Makefile first.", "encrypted": None})
emit(0.8, "TextPart", {"type": "text", "text": "Let me look at "})
emit(0.9, "TextPart", {"type": "text", "text": "the Makefile."})
emit(1.0, "ToolCall", {"type": "function", "id": "call_read_1", "function": {"name": "ReadFile", "arguments": '{"path": "Make'}, "extras": None})
emit(1.05, "ToolCallPart", {"arguments_part": 'file"}'})
emit(1.2, "StatusUpdate", {"context_usage": 0.02, "context_tokens": 1800, "max_context_tokens": 128000,
                           "token_usage": usage(1500, 42, 300, 0), "message_id": "cmpl_a1", "plan_mode": None, "mcp_status": None})
emit(1.5, "ToolResult", {"tool_call_id": "call_read_1", "return_value": {"is_error": False, "output": "all: build\nbuild:\n\tgo build ./...\n", "message": "", "display": [{"type": "brief", "text": "3 lines"}], "extras": None}})
emit(1.6, "StepBegin", {"n": 2})
emit(2.0, "TextPart", {"type": "text", "text": "It builds every Go package with `go build ./...`."})
emit(2.2, "StatusUpdate", {"token_usage": usage(1600, 18, 1500, 0), "message_id": "cmpl_a2"})
emit(2.3, "TurnEnd", {})

# turn 2: an edit with a diff display block, a failed shell call, a steer, a retry
emit(10.0, "TurnBegin", {"user_input": [{"type": "text", "text": "Add a test target."}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]})
emit(10.1, "StepBegin", {"n": 3})
emit(10.5, "ToolCall", {"type": "function", "id": "call_edit_1", "function": {"name": "StrReplaceFile", "arguments": json.dumps({"path": "Makefile", "old_str": "all: build", "new_str": "all: build test\ntest:\n\tgo test ./..."})}, "extras": None})
emit(10.6, "StatusUpdate", {"token_usage": usage(1700, 60), "message_id": "cmpl_b1"})
emit(10.9, "ToolResult", {"tool_call_id": "call_edit_1", "return_value": {"is_error": False, "output": "Edited Makefile", "message": "", "display": [{"type": "diff", "path": "Makefile", "old_text": "all: build", "new_text": "all: build test\ntest:\n\tgo test ./...", "old_start": 1, "new_start": 1, "is_summary": False}], "extras": None}})
emit(11.0, "SteerInput", {"user_input": "and run it"})
emit(11.1, "StepBegin", {"n": 4})
emit(11.3, "StepRetry", {"n": 4, "next_attempt": 2, "max_attempts": 3, "wait_s": 1.0, "error_type": "APIConnectionError", "status_code": None})
emit(12.4, "StepBegin", {"n": 4})
emit(12.8, "ToolCall", {"type": "function", "id": "call_sh_1", "function": {"name": "Shell", "arguments": '{"command": "make test"}'}, "extras": None})
emit(12.9, "StatusUpdate", {"token_usage": usage(1800, 15), "message_id": "cmpl_b2"})
emit(14.0, "ToolResult", {"tool_call_id": "call_sh_1", "return_value": {"is_error": True, "output": "go: no test files", "message": "exit status 1", "display": [], "extras": None}})
emit(14.1, "Notification", {"level": "warning", "message": "make test failed"})
emit(14.2, "StepBegin", {"n": 5})
emit(14.6, "TextPart", {"type": "text", "text": "There are no tests yet; the target is in place."})
emit(14.7, "StatusUpdate", {"token_usage": usage(1900, 12), "message_id": "cmpl_b3"})
emit(14.8, "TurnEnd", {})

with open(os.path.join(out, "wire.jsonl"), "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps({"type": "metadata", "protocol_version": "1.10"}) + "\n")
    for r in records:
        f.write(json.dumps(r) + "\n")
print(len(records) + 1, "lines ->", os.path.join(out, "wire.jsonl"))
