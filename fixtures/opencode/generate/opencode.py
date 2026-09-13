"""Build fixtures/opencode/opencode.sqlite: two synthetic OpenCode sessions in
the database layout OpenCode itself writes.

The DDL is the generated schema, verbatim, from
packages/core/src/database/schema.gen.ts in anomalyco/opencode (the
`project`, `session`, `message` and `part` tables and their indexes). The
`data` JSON in `message` and `part` rows follows packages/schema/src/v1/
session.ts — `SessionV1.Info` minus `id`/`sessionID`, `SessionV1.Part` minus
`id`/`sessionID`/`messageID`, which is exactly what the projector strips
(packages/core/src/session/projector.ts, `messageData` / `partData`).
Rows are inserted out of the order OpenCode reads them in, so a reader that
trusted rowid order would produce a different chain. Content is synthetic.

    python fixtures/opencode/generate/opencode.py fixtures/opencode/opencode.sqlite
"""
import json, os, sqlite3, sys

out = sys.argv[1]
if os.path.exists(out):
    os.remove(out)

conn = sqlite3.connect(out)
conn.executescript(
    """
CREATE TABLE `project` (
  `id` text PRIMARY KEY,
  `worktree` text NOT NULL,
  `vcs` text,
  `name` text,
  `icon_url` text,
  `icon_url_override` text,
  `icon_color` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_initialized` integer,
  `sandboxes` text NOT NULL,
  `commands` text
);
CREATE TABLE `session` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `parent_id` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `path` text,
  `title` text NOT NULL,
  `version` text NOT NULL,
  `share_url` text,
  `summary_additions` integer,
  `summary_deletions` integer,
  `summary_files` integer,
  `summary_diffs` text,
  `metadata` text,
  `cost` real DEFAULT 0 NOT NULL,
  `tokens_input` integer DEFAULT 0 NOT NULL,
  `tokens_output` integer DEFAULT 0 NOT NULL,
  `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL,
  `tokens_cache_write` integer DEFAULT 0 NOT NULL,
  `revert` text,
  `permission` text,
  `agent` text,
  `model` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_compacting` integer,
  `time_archived` integer,
  CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
CREATE TABLE `message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE TABLE `part` (
  `id` text PRIMARY KEY,
  `message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
CREATE INDEX `session_project_idx` ON `session` (`project_id`);
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
"""
)

T0 = 1772697600000  # 2026-03-05T08:00:00.000Z
PROJECT = "prj_fixture0001"
conn.execute(
    "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, 'git', 'demo', ?, ?, '[]')",
    (PROJECT, "/home/dev/demo", T0, T0),
)

MODEL = {"providerID": "anthropic", "modelID": "claude-sonnet-5"}


def session(sid, title, t):
    conn.execute(
        "INSERT INTO session (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated) "
        "VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'build', ?, ?, ?)",
        (sid, PROJECT, title.lower().replace(" ", "-"), "/home/dev/demo", title, "1.2.3", json.dumps({"id": MODEL["modelID"], "providerID": MODEL["providerID"]}), t, t),
    )


rows_m, rows_p = [], []


def user(sid, mid, t, text, extra_parts=()):
    rows_m.append((mid, sid, t, t, json.dumps({"role": "user", "time": {"created": t}, "agent": "build", "model": MODEL})))
    rows_p.append((f"prt_{mid[4:]}_00", mid, sid, t, t, json.dumps({"type": "text", "text": text})))
    for i, p in enumerate(extra_parts, 1):
        rows_p.append((f"prt_{mid[4:]}_{i:02d}", mid, sid, t, t, json.dumps(p)))


def assistant(sid, mid, parent, t, parts, tokens, finish="stop"):
    # A part row is created when the part is: a tool part at its start, a
    # step-finish after the step's last part, markers a beat after the
    # previous one. `completed` is stamped after the last part.
    now = t
    stamped = []
    for i, p in enumerate(parts):
        time = p.get("time") or (p.get("state") or {}).get("time") or {}
        if "start" in time:
            now = time["start"]
        else:
            now += 50
        stamped.append((f"prt_{mid[4:]}_{i:02d}", mid, sid, now, now, json.dumps(p)))
        if "end" in time:
            now = time["end"]
    completed = now + 400
    rows_m.append(
        (
            mid, sid, t, completed,
            json.dumps({
                "role": "assistant", "time": {"created": t, "completed": completed}, "parentID": parent,
                "modelID": MODEL["modelID"], "providerID": MODEL["providerID"], "mode": "build", "agent": "build",
                "path": {"cwd": "/home/dev/demo", "root": "/home/dev/demo"}, "cost": 0.0042,
                "tokens": tokens, "finish": finish,
            }),
        )
    )
    rows_p.extend(stamped)


# --- session A: a read, an edit through a tool, a second turn ---------------
A = "ses_fixtureaaaa0001"
session(A, "Fix the parser test", T0)
user(A, "msg_a000", T0 + 1000, "The parser test is failing, can you look?")
assistant(
    A, "msg_a001", "msg_a000", T0 + 2000,
    [
        {"type": "step-start", "snapshot": "abc123"},
        {"type": "reasoning", "text": "Read the test first, then the parser.", "time": {"start": T0 + 2100, "end": T0 + 2400}},
        {"type": "text", "text": "Let me look at the failing test.", "time": {"start": T0 + 2500}},
        {"type": "tool", "callID": "call_read_1", "tool": "read",
         "state": {"status": "completed", "input": {"filePath": "test/parser.test.ts"}, "output": "expect(parse('1+1')).toBe(2)", "title": "test/parser.test.ts", "metadata": {}, "time": {"start": T0 + 2600, "end": T0 + 2700}}},
        {"type": "step-finish", "reason": "tool-calls", "cost": 0.0021, "tokens": {"input": 120, "output": 40, "reasoning": 12, "cache": {"read": 300, "write": 20}}},
        {"type": "step-start"},
        {"type": "tool", "callID": "call_edit_1", "tool": "edit",
         "state": {"status": "completed", "input": {"filePath": "src/parser.ts", "oldString": "a + b", "newString": "Number(a) + Number(b)"}, "output": "Edit applied", "title": "src/parser.ts", "metadata": {"diff": "-a + b\n+Number(a) + Number(b)"}, "time": {"start": T0 + 3000, "end": T0 + 3100}}},
        {"type": "patch", "hash": "def456", "files": ["src/parser.ts"]},
        {"type": "text", "text": "The parser was concatenating strings; fixed.", "time": {"start": T0 + 3200}},
        {"type": "step-finish", "reason": "stop", "cost": 0.0021, "tokens": {"input": 200, "output": 55, "reasoning": 0, "cache": {"read": 320, "write": 0}}},
    ],
    {"input": 320, "output": 95, "reasoning": 12, "cache": {"read": 620, "write": 20}},
)
user(A, "msg_a002", T0 + 9000, "Thanks. Run the tests.", extra_parts=[{"type": "text", "text": "Attached media from tool result:", "synthetic": True}])
assistant(
    A, "msg_a003", "msg_a002", T0 + 10000,
    [
        {"type": "tool", "callID": "call_bash_1", "tool": "bash",
         "state": {"status": "error", "input": {"command": "npm test"}, "error": "Command timed out", "metadata": {}, "time": {"start": T0 + 10100, "end": T0 + 40100}}},
        {"type": "tool", "callID": "call_bash_2", "tool": "bash",
         "state": {"status": "running", "input": {"command": "npm test -- --run"}, "time": {"start": T0 + 40200}}},
        {"type": "file", "mime": "text/plain", "url": "file:///tmp/out.txt"},
    ],
    {"input": 80, "output": 10, "reasoning": 0, "cache": {"read": 0, "write": 0}},
    finish="tool-calls",
)

# --- session B: no step-finish parts at all; usage lives on the message -----
B = "ses_fixturebbbb0002"
session(B, "Quick question", T0 + 100000)
user(B, "msg_b000", T0 + 101000, "What does the config flag do?")
assistant(
    B, "msg_b001", "msg_b000", T0 + 102000,
    [{"type": "text", "text": "It toggles verbose logging.", "time": {"start": T0 + 102100}}],
    {"input": 30, "output": 8, "reasoning": 0, "cache": {"read": 0, "write": 0}},
)

# Out of read order on purpose: the reader must sort as OpenCode does.
for r in reversed(rows_m):
    conn.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)", r)
for r in rows_p[::-1]:
    conn.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)", r)
conn.commit()
for r in conn.execute("SELECT session_id, count(*) FROM message GROUP BY session_id"):
    print(r)
print("parts:", conn.execute("SELECT count(*) FROM part").fetchone()[0])
conn.close()
