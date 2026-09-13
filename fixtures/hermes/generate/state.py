"""Build fixtures/hermes/state.db the way Hermes Agent keeps one
(NousResearch/hermes-agent): the `sessions`, `messages` and
`session_model_usage` tables with the DDL from hermes_state_common.py, rows
shaped as session_persistence.py `_db_flush_row` writes them and
hermes_state_messages.py `_message_row_params` binds them (content a string,
or "\\x00json:" + a JSON part list for multimodal messages; `tool_calls` a
JSON list in the OpenAI shape; `timestamp` epoch seconds).

Two sessions. The first exercises what the adapter maps: a system prompt row
(counted), a user turn, an assistant turn with `reasoning` and a `read_file`
call, the read's result (line-numbered, not replayable), a `write_file` of a
new file whose result carries `verified: true` and a `bytes_written` equal to
the content's UTF-8 length (the bytes on disk are the argument), a `patch`
in replace mode whose result carries the difflib diff, a `write_file` whose
`bytes_written` is one byte larger (a preserved CRLF: transformed, counted),
a multimodal user turn, a compressed-summary row, a retired row
(`active = 0`), a `tool_error` result, and per-model totals. The second is a
one-turn session so the database holds two, one line each in `import --all`.
Content is synthetic. Written in rollback-journal mode so no `-wal` sidecar
is left beside it.

    python fixtures/hermes/generate/state.py fixtures/hermes
"""
import json, os, sqlite3, sys

root = sys.argv[1]
os.makedirs(root, exist_ok=True)
path = os.path.join(root, "state.db")
if os.path.exists(path):
    os.remove(path)

DDL = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    session_key TEXT,
    chat_id TEXT,
    chat_type TEXT,
    thread_id TEXT,
    display_name TEXT,
    origin_json TEXT,
    expiry_finalized INTEGER DEFAULT 0,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    system_prompt_hash TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cwd TEXT,
    git_branch TEXT,
    git_repo_root TEXT,
    git_metadata_generation INTEGER NOT NULL DEFAULT 0,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    title TEXT,
    title_source TEXT,
    last_activity_at REAL,
    last_activity_description TEXT,
    last_activity_provenance TEXT,
    api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT,
    handoff_platform TEXT,
    handoff_error TEXT,
    compression_failure_cooldown_until REAL,
    compression_failure_error TEXT,
    compression_fallback_streak INTEGER NOT NULL DEFAULT 0,
    compression_ineffective_count INTEGER NOT NULL DEFAULT 0,
    compression_recovery_deadline REAL,
    profile_name TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    last_read_at REAL,
    tool_names TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    effect_disposition TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT,
    codex_message_items TEXT,
    platform_message_id TEXT,
    observed INTEGER DEFAULT 0,
    _compressed_summary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0,
    api_content TEXT,
    display_kind TEXT,
    display_metadata TEXT,
    display_identity BLOB,
    display_order INTEGER
);
CREATE TABLE IF NOT EXISTS session_model_usage (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    cost_status TEXT,
    cost_source TEXT,
    first_seen REAL,
    last_seen REAL
);
"""

conn = sqlite3.connect(path)
conn.execute("PRAGMA journal_mode=DELETE")
conn.executescript(DDL)

SID = "a3f9c2e1b7d04c5e8f6a1b2c3d4e5f60"
T0 = 1781000000.0  # 2026-06-09T10:13:20Z
CWD = "/home/dev/hello"
README = "# hello\n\nGreets the world.\n"
README_AFTER = "# hello\n\nGreets the whole world.\n"


def call(cid, name, args):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def unified(path, before, after):
    import difflib
    return "".join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                        fromfile=f"a/{path}", tofile=f"b/{path}"))


rows = [
    # role, content, tool_call_id, tool_calls, tool_name, ts offset, finish_reason, reasoning, compressed, active
    ("system", "You are Hermes.", None, None, None, 0.0, None, None, 0, 1),
    ("user", "Add a README that greets the world, then say it greets the whole world", None, None, None, 1.0, None, None, 0, 1),
    ("assistant", "Let me check what is there.", None, json.dumps([call("call_r1", "read_file", {"path": "src/index.ts"})]), None, 4.0,
     "tool_calls", "Read first, then write the README.", 0, 1),
    ("tool", json.dumps({"content": '1|import { greet } from "./greet";\n2|\n3|console.log(greet("world"));', "total_lines": 3, "file_size": 62},
                        ensure_ascii=False), "call_r1", None, "read_file", 4.2, None, None, 0, 1),
    ("assistant", None, None, json.dumps([call("call_w1", "write_file", {"path": "README.md", "content": README})]), None, 7.0,
     "tool_calls", None, 0, 1),
    ("tool", json.dumps({"bytes_written": len(README.encode("utf-8")), "dirs_created": True, "verified": True,
                         "resolved_path": CWD + "/README.md", "files_modified": [CWD + "/README.md"]}), "call_w1", None, "write_file", 7.3, None, None, 0, 1),
    ("assistant", None, None, json.dumps([call("call_p1", "patch", {"path": "README.md", "old_string": "the world", "new_string": "the whole world"})]), None, 10.0,
     "tool_calls", None, 0, 1),
    ("tool", json.dumps({"success": True, "diff": unified("README.md", README, README_AFTER), "files_modified": [CWD + "/README.md"],
                         "files_created": [], "files_deleted": []}), "call_p1", None, "patch", 10.4, None, None, 0, 1),
    # A write to a file that already had CRLF endings: Hermes preserved them, so one more byte landed than the argument holds.
    ("assistant", None, None, json.dumps([call("call_w2", "write_file", {"path": "src/config.ini", "content": "[app]\nname=hello\n"})]), None, 13.0,
     "tool_calls", None, 0, 1),
    ("tool", json.dumps({"bytes_written": len("[app]\nname=hello\n".encode("utf-8")) + 2, "dirs_created": True, "verified": True,
                         "resolved_path": CWD + "/src/config.ini", "files_modified": [CWD + "/src/config.ini"]}), "call_w2", None, "write_file", 13.3, None, None, 0, 1),
    ("assistant", None, None, json.dumps([call("call_p2", "patch", {"path": "src/missing.ts", "old_string": "a", "new_string": "b"})]), None, 15.0,
     "tool_calls", None, 0, 1),
    ("tool", json.dumps({"error": "Failed to read file: src/missing.ts"}), "call_p2", None, "patch", 15.2, None, None, 0, 1),
    ("user", "\x00json:" + json.dumps([{"type": "text", "text": "Here is a screenshot"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]),
     None, None, None, 20.0, None, None, 0, 1),
    ("assistant", "README.md now says it greets the whole world; the screenshot shows the old page.", None, None, None, 23.0, "stop", None, 0, 1),
    # Context compression: a summary row that stands for the retired turn below it.
    ("user", "[Conversation summary: the README was written and patched.]", None, None, None, 25.0, None, None, 1, 1),
    ("assistant", "An earlier draft answer, retired by compression.", None, None, None, 2.5, "stop", None, 0, 0),
]
conn.execute(
    "INSERT INTO sessions (id, source, model, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, "
    "cache_read_tokens, cache_write_tokens, cwd, git_branch, title, api_call_count, estimated_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (SID, "cli", "claude-sonnet-5", T0, T0 + 30.0, "user_exit", len(rows), 5, 9100, 640, 5200, 800, CWD, "main", "README greeting", 6, 0.0412),
)
for role, content, tcid, tcs, tname, dt, finish, reasoning, compressed, active in rows:
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning, "
        "_compressed_summary, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (SID, role, content, tcid, tcs, tname, T0 + dt, finish, reasoning, compressed, active),
    )
conn.execute(
    "INSERT INTO session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, "
    "estimated_cost_usd) VALUES (?,?,?,?,?,?,?,?)",
    (SID, "claude-sonnet-5", 5, 8000, 600, 5200, 800, 0.04),
)
conn.execute(
    "INSERT INTO session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, "
    "estimated_cost_usd) VALUES (?,?,?,?,?,?,?,?)",
    (SID, "gpt-5.5", 1, 1100, 40, 0, 0, 0.0012),
)

SID2 = "b7e1d0c9a8f74b3e9c2d1e0f6a5b4c3d"
conn.execute(
    "INSERT INTO sessions (id, source, model, started_at, cwd, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?)",
    (SID2, "telegram", "gpt-5.5", T0 + 3600.0, "/home/dev/other", 300, 20),
)
conn.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (SID2, "user", "ping", T0 + 3601.0))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?,?,?,?,?)", (SID2, "assistant", "pong", T0 + 3602.0, "stop"))
# A third session with no messages: nothing to import, listed by nothing.
conn.execute("INSERT INTO sessions (id, source, started_at) VALUES (?,?,?)", ("c0ffee00c0ffee00c0ffee00c0ffee00", "cli", T0 + 7200.0))
conn.commit()
conn.close()
print("wrote", path)
