"""Build the Cursor fixture the way Cursor's agent writes a transcript.

Record shapes are the observed ones documented in Einsia/agent-git
(docs/mechanism-probing/cursor-kiro-formats.md and samples/cursor/
record-shapes.jsonl, commit 8e222bc0c2c9; Cursor IDE 3.13.25): a
conversation record is `{role, message: {content: [...]}}` with text blocks
for either role and id-less `tool_use` blocks for the assistant, a turn ends
with `{type: "turn_ended", status}`, and a user text carries Cursor's
`<timestamp>` / `<user_query>` framing. Tool inputs use the field names each
tool was observed with. Content is synthetic.

    python fixtures/cursor/generate/transcript.py fixtures/cursor
"""
import json, os, sys

out = sys.argv[1]
SLUG = "Users-alex-Projects-demo"
SID = "3f1c9a2e-7b4d-4e8f-9a1b-2c3d4e5f6a7b"
SUB = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
PROJECT = "/Users/alex/Projects/demo"


def user(text):
    return {"role": "user", "message": {"content": [{"type": "text", "text": text}]}}


def assistant(*blocks):
    return {"role": "assistant", "message": {"content": list(blocks)}}


def text(t):
    return {"type": "text", "text": t}


def tool(name, inp):
    return {"type": "tool_use", "name": name, "input": inp}


def query(stamp, body, extra=""):
    head = f"<timestamp>{stamp}</timestamp>\n" if stamp else ""
    return f"{head}{extra}<user_query>\n{body}\n</user_query>"


main = [
    user(query("Tuesday, Jun 2, 2026, 11:20 AM (UTC+8)", "Summarize the two sales reports and write the totals to summary.md")),
    assistant(text("I'll look for the reports first.")),
    assistant(tool("Glob", {"glob_pattern": "*.csv", "target_directory": PROJECT})),
    assistant(tool("Read", {"path": f"{PROJECT}/q1.csv"})),
    assistant(
        tool(
            "Shell",
            {
                "command": "wc -l q1.csv q2.csv",
                "working_directory": PROJECT,
                "description": "Count rows in both reports",
                "block_until_ms": 30000,
            },
        )
    ),
    assistant(
        tool("Write", {"path": f"{PROJECT}/summary.md", "contents": "# Totals\n\nQ1: 120\nQ2: 140\n"}),
        tool("StrReplace", {"path": f"{PROJECT}/summary.md", "old_string": "Q2: 140", "new_string": "Q2: 141"}),
    ),
    # ApplyPatch's input is the patch text itself, not an object.
    assistant(
        tool(
            "ApplyPatch",
            "*** Begin Patch\n*** Add File: " + PROJECT + "/notes.md\n+Q2 was recounted.\n*** End Patch",
        )
    ),
    assistant(text("Done: summary.md holds the totals, and notes.md says why Q2 moved.")),
    {"type": "turn_ended", "status": "success"},
    user(
        query(
            "Tuesday, Jun 2, 2026, 11:31 AM (UTC+8)",
            "Delete notes.md — the key AKIAIOSFODNN7EXAMPLE leaked into it. Chart attached.",
            extra="<image_files>\n/tmp/chart.png\n</image_files>\n",
        )
    ),
    assistant(
        tool("Delete", {"path": f"{PROJECT}/notes.md"}),
        tool("TodoWrite", {"merge": False, "todos": [{"id": "rotate", "content": "Rotate the leaked key", "status": "pending"}]}),
        {"type": "image", "source": "inline"},  # a block agit has no event for
    ),
    # Cursor's own text, sent when a subagent finished — no <timestamp> on it.
    user(query("", "Perform any necessary follow-up actions in response to the subagent completion above.")),
    assistant(text("Nothing further; the key still needs rotating on your side.")),
    {"type": "turn_ended", "status": "error", "error": "User aborted request"},
    # After an interruption Cursor sends this one without a <user_query> wrapper.
    user("Your previous response was interrupted. Continue from where you left off."),
    assistant(text("Continuing: summary.md is complete.")),
    {"type": "turn_ended", "status": "aborted", "error": "User aborted/interrupted manually."},
    {"kind": "unknown"},  # not a shape Cursor writes; counted, never guessed at
]

subagent = [
    user(query("Tuesday, Jun 2, 2026, 11:25 AM (UTC+8)", "You are the forked subagent; continue executing your task.")),
    assistant(tool("ReadFile", {"path": f"{PROJECT}/q2.csv"})),
    assistant(text("q2.csv has 141 rows.")),
    {"type": "turn_ended", "status": "success"},
]


def write(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


base = os.path.join(out, SLUG, "agent-transcripts", SID)
write(os.path.join(base, f"{SID}.jsonl"), main)
write(os.path.join(base, "subagents", f"{SUB}.jsonl"), subagent)
print(base)
