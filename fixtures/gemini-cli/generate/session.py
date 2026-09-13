"""Build fixtures/gemini-cli/session.jsonl (and legacy.json) the way Gemini
CLI's ChatRecordingService writes a recording.

Record shapes are from packages/core/src/services/chatRecordingTypes.ts in
google-gemini/gemini-cli; the sequence of appends mirrors the service:
`recordMessage` appends a message, `recordMessageTokens` and
`recordToolCalls` re-append the *last* message with the new fields
(`pushMessage`), `updateMetadata` appends `{"$set": …}` after each message,
and a rewind appends `{"$rewindTo": id}`. The legacy form is the whole
ConversationRecord as one JSON document, which the loader still reads.
Content is synthetic.

    python fixtures/gemini-cli/generate/session.py fixtures/gemini-cli
"""
import json, os, sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

SID = "0c3d7a1e-5b2f-4c8a-9d6e-1f2a3b4c5d6e"
HASH = "9f2c1e8a7b6d5c4f3e2d1c0b9a8f7e6d5c4b3a291807f6e5d4c3b2a1f0e9d8c7"
T = "2026-04-02T09:15:{:02d}.000Z"

records = []


def append(rec):
    records.append(rec)


def touch(t):
    append({"$set": {"lastUpdated": T.format(t)}})


append({"sessionId": SID, "projectHash": HASH, "startTime": T.format(0), "lastUpdated": T.format(0), "kind": "main"})

# turn 1: user asks; gemini thinks, answers, calls a tool, gets its result
append({"id": "u1", "timestamp": T.format(1), "type": "user", "content": [{"text": "List the files in this directory."}]})
touch(1)
g1 = {
    "id": "g1", "timestamp": T.format(3), "type": "gemini",
    "content": [{"text": "I'll list them."}],
    "thoughts": [{"subject": "Plan", "description": "One shell call is enough.", "timestamp": T.format(2)}],
    "model": "gemini-2.5-pro",
}
append(g1)
touch(3)
# tokens arrive, the last message is re-pushed with them
g1 = {**g1, "tokens": {"input": 340, "output": 21, "cached": 120, "thoughts": 9, "tool": 0, "total": 490}}
append(g1)
# the tool call is scheduled, then runs, then succeeds: each a re-push
call = {"id": "call-run-shell-1", "name": "run_shell_command", "args": {"command": "ls"},
        "status": "executing", "timestamp": T.format(4), "displayName": "Shell", "description": "Runs a shell command"}
g1 = {**g1, "toolCalls": [call]}
append(g1)
call = {**call, "status": "success", "result": [{"functionResponse": {"id": "call-run-shell-1", "name": "run_shell_command", "response": {"output": "README.md\nsrc\n"}}}]}
g1 = {**g1, "toolCalls": [call]}
append(g1)

# turn 2: an error and a cancellation on the same message, and a warning line
append({"id": "u2", "timestamp": T.format(10), "type": "user", "content": "Now delete the build directory and read notes.txt"})
touch(10)
g2 = {
    "id": "g2", "timestamp": T.format(12), "type": "gemini", "content": [{"text": "On it."}],
    "model": "gemini-2.5-pro",
    "tokens": {"input": 410, "output": 12, "cached": 400, "thoughts": 0, "tool": 0, "total": 822},
    "toolCalls": [
        {"id": "call-rm-1", "name": "run_shell_command", "args": {"command": "rm -rf build"}, "status": "cancelled", "timestamp": T.format(13)},
        {"id": "call-read-1", "name": "read_file", "args": {"absolute_path": "/work/notes.txt"}, "status": "error", "timestamp": T.format(14),
         "result": [{"functionResponse": {"id": "call-read-1", "name": "read_file", "response": {"error": "File not found: /work/notes.txt"}}}]},
    ],
}
append(g2)
touch(12)
append({"id": "w1", "timestamp": T.format(15), "type": "warning", "content": "Tool call cancelled by user."})
append({"$set": {"summary": "Listed files; a delete was cancelled."}})

# turn 3, then rewound: the user takes it back, so neither message survives
append({"id": "u3", "timestamp": T.format(20), "type": "user", "content": [{"text": "Actually, never mind."}, {"inlineData": {"mimeType": "image/png", "data": "AAAA"}}]})
touch(20)
append({"id": "g3", "timestamp": T.format(21), "type": "gemini", "content": [{"text": "Okay."}], "model": "gemini-2.5-pro"})
append({"$rewindTo": "u3"})

with open(os.path.join(out, "session.jsonl"), "w", encoding="utf-8", newline="\n") as f:
    for r in records:
        f.write(json.dumps(r) + "\n")

# The legacy single-document form: the folded record, messages as they stand.
legacy = {
    "sessionId": SID, "projectHash": HASH, "startTime": T.format(0), "lastUpdated": T.format(12),
    "kind": "main", "summary": "Listed files; a delete was cancelled.",
    "messages": [
        {"id": "u1", "timestamp": T.format(1), "type": "user", "content": [{"text": "List the files in this directory."}]},
        g1,
        {"id": "u2", "timestamp": T.format(10), "type": "user", "content": "Now delete the build directory and read notes.txt"},
        g2,
        {"id": "w1", "timestamp": T.format(15), "type": "warning", "content": "Tool call cancelled by user."},
    ],
}
with open(os.path.join(out, "legacy.json"), "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps(legacy, indent=2) + "\n")
print(len(records), "records")
