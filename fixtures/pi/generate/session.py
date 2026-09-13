"""Build fixtures/pi/<timestamp>_<id>.jsonl the way pi's SessionManager writes
one (badlogic/pi-mono, packages/coding-agent/src/core/session-manager.ts,
documented in packages/coding-agent/docs/session-format.md): a version-3
header, then one entry per line with id / parentId / ISO timestamp.

The session exercises what the adapter maps: a user turn; an assistant turn
with thinking, text and a `read` toolCall; the full `read` result (no
offset, limit or truncation — the file's text verbatim, read.ts); an `edit`
whose result carries `details.patch`, the unified patch edit-diff.ts
produces over LF-normalized text; a `write` of a new file (write.ts writes
`content` verbatim); a `bash` call; a `model_change`; a `compaction` with
its own `usage`; a `bashExecution` message (the person ran `!cmd`); a
`custom` extension message; a `label`; and a branch — the last user turn
hangs off an earlier entry, as `/tree` does. Content is synthetic.

    python fixtures/pi/generate/session.py fixtures/pi
"""
import difflib, json, os, sys

root = sys.argv[1]
os.makedirs(root, exist_ok=True)

SID = "8f3b2c1d-4e5a-4b6c-9d7e-0f1a2b3c4d5e"
T0 = 1780000000000  # 2026-05-28T20:26:40Z
CWD = "/home/dev/hello"


def iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


entries = []
ids = iter(["a1b2c3d4", "b2c3d4e5", "c3d4e5f6", "d4e5f6a7", "e5f6a7b8", "f6a7b8c9", "a7b8c9d0", "b8c9d0e1",
            "c9d0e1f2", "d0e1f2a3", "e1f2a3b4", "f2a3b4c5", "a3b4c5d6", "b4c5d6e7", "c5d6e7f8", "d6e7f8a9",
            "e7f8a9b0", "f8a9b0c1"])
last = None


def entry(ms, type_, body, parent="last"):
    global last
    e = {"type": type_, "id": next(ids), "parentId": last if parent == "last" else parent, "timestamp": iso(ms)}
    e.update(body)
    entries.append(e)
    last = e["id"]
    return e["id"]


def usage(i, o, cr=0, cw=0):
    return {"input": i, "output": o, "cacheRead": cr, "cacheWrite": cw, "totalTokens": i + o + cr + cw,
            "cost": {"input": 0.001, "output": 0.002, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.003}}


def assistant(ms, content, stop="stop", model="claude-sonnet-5", u=None):
    return {"role": "assistant", "content": content, "api": "anthropic-messages", "provider": "anthropic",
            "model": model, "usage": u or usage(1200, 80), "stopReason": stop, "timestamp": ms}


INDEX_BEFORE = 'import { greet } from "./greet";\n\nconsole.log("hi");\n'
INDEX_AFTER = 'import { greet } from "./greet";\n\nconsole.log(greet("world"));\n'


def patch(path, before, after):
    lines = list(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                      fromfile=path, tofile=path, n=4))
    return "".join(l if l.endswith("\n") else l + "\n" for l in lines)


header = {"type": "session", "version": 3, "id": SID, "timestamp": iso(T0), "cwd": CWD}

entry(T0 + 1000, "message", {"message": {"role": "user", "content": "Use greet() in src/index.ts and add a README", "timestamp": T0 + 1000}})
entry(T0 + 4000, "message", {"message": assistant(T0 + 4000, [
    {"type": "thinking", "thinking": "Read the entry point first, then a single edit.", "thinkingSignature": "sig-elided"},
    {"type": "text", "text": "Reading the entry point."},
    {"type": "toolCall", "id": "call_read_1", "name": "read", "arguments": {"path": "src/index.ts"}},
], stop="toolUse")})
entry(T0 + 4200, "message", {"message": {"role": "toolResult", "toolCallId": "call_read_1", "toolName": "read",
                                          "content": [{"type": "text", "text": INDEX_BEFORE}], "isError": False, "timestamp": T0 + 4200}})
entry(T0 + 7000, "message", {"message": assistant(T0 + 7000, [
    {"type": "toolCall", "id": "call_edit_1", "name": "edit", "arguments": {
        "path": "src/index.ts", "edits": [{"oldText": 'console.log("hi");', "newText": 'console.log(greet("world"));'}]}},
], stop="toolUse", u=usage(1400, 60, 1100, 200))})
entry(T0 + 7300, "message", {"message": {"role": "toolResult", "toolCallId": "call_edit_1", "toolName": "edit",
                                          "content": [{"type": "text", "text": "Successfully replaced 1 block(s) in src/index.ts."}],
                                          "details": {"diff": "-3 console.log(\"hi\");\n+3 console.log(greet(\"world\"));",
                                                      "patch": patch("src/index.ts", INDEX_BEFORE, INDEX_AFTER), "firstChangedLine": 3},
                                          "isError": False, "timestamp": T0 + 7300}})
README = "# hello\n\nGreets the world.\n"
entry(T0 + 10000, "message", {"message": assistant(T0 + 10000, [
    {"type": "text", "text": "Now the README."},
    {"type": "toolCall", "id": "call_write_1", "name": "write", "arguments": {"path": "README.md", "content": README}},
], stop="toolUse", u=usage(1500, 70, 1300, 0))})
entry(T0 + 10200, "message", {"message": {"role": "toolResult", "toolCallId": "call_write_1", "toolName": "write",
                                           "content": [{"type": "text", "text": "Successfully wrote to README.md"}], "isError": False, "timestamp": T0 + 10200}})
entry(T0 + 13000, "message", {"message": assistant(T0 + 13000, [
    {"type": "toolCall", "id": "call_bash_1", "name": "bash", "arguments": {"command": "npm test"}},
], stop="toolUse", u=usage(1600, 30, 1500, 0))})
entry(T0 + 15000, "message", {"message": {"role": "toolResult", "toolCallId": "call_bash_1", "toolName": "bash",
                                           "content": [{"type": "text", "text": "Command exited with code 1\nError: no test specified"}],
                                           "details": {"truncated": False}, "isError": True, "timestamp": T0 + 15000}})
entry(T0 + 16000, "model_change", {"provider": "openai", "modelId": "gpt-5.5"})
entry(T0 + 18000, "message", {"message": assistant(T0 + 18000, [
    {"type": "text", "text": "index.ts greets through the helper and README.md is in place; the test script is missing, which predates this change."},
], model="gpt-5.5", u=usage(1700, 90, 0, 0))})
entry(T0 + 20000, "message", {"message": {"role": "bashExecution", "command": "git status --short", "output": " M src/index.ts\n?? README.md\n",
                                           "exitCode": 0, "cancelled": False, "truncated": False, "timestamp": T0 + 20000}})
entry(T0 + 21000, "message", {"message": {"role": "custom", "customType": "my-extension", "content": "Injected context.", "display": True, "timestamp": T0 + 21000}})
entry(T0 + 22000, "compaction", {"summary": "The user asked for greet() in index.ts and a README; both done.", "firstKeptEntryId": "d0e1f2a3",
                                 "tokensBefore": 9000, "usage": usage(3000, 120), "details": {"readFiles": ["src/index.ts"], "modifiedFiles": ["src/index.ts", "README.md"]}})
branch_from = entries[7]["id"]  # the bash call: the last user turn hangs off it, as /tree does
entry(T0 + 23000, "label", {"targetId": entries[0]["id"], "label": "start"})
entry(T0 + 25000, "message", {"message": {"role": "user", "content": [{"type": "text", "text": "Actually skip the tests."}], "timestamp": T0 + 25000}}, parent=branch_from)
entry(T0 + 27000, "message", {"message": assistant(T0 + 27000, [{"type": "text", "text": "Skipping them."}], model="gpt-5.5", u=usage(1800, 10, 0, 0))})

name = "2026-05-28T20-26-40-000Z_" + SID + ".jsonl"
with open(os.path.join(root, name), "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps(header, separators=(",", ":"), ensure_ascii=False) + "\n")
    for e in entries:
        f.write(json.dumps(e, separators=(",", ":"), ensure_ascii=False) + "\n")
print("wrote", os.path.join(root, name), len(entries) + 1, "lines")
