"""Build fixtures/hermes/live/state.db and state.db-wal: the fixture database as
Hermes leaves it while running — in WAL mode, with a session's rows committed
to the write-ahead log and not yet checkpointed into the main file. The pair
is copied while the connection is open, which is exactly the state an import
finds when Hermes is up (hermes_state.py keeps the WAL open and, where the
runtime allows, disables the close-time checkpoint).

The main file here is the fixture built by state.py plus one more session
whose rows live only in the WAL; a reader that ignores the sidecar sees the
two original sessions and not the third. Salts and checksums are SQLite's
own, so the files are regenerated as a pair.

    python fixtures/hermes/generate/live.py fixtures/hermes
"""
import json, os, shutil, sqlite3, sys

root = sys.argv[1]
src = os.path.join(root, "state.db")
out = os.path.join(root, "live")
os.makedirs(out, exist_ok=True)
work = os.path.join(out, "state.db")
for name in ("state.db", "state.db-wal", "state.db-shm"):
    p = os.path.join(out, name)
    if os.path.exists(p):
        os.remove(p)
shutil.copyfile(src, work)

conn = sqlite3.connect(work)
conn.execute("PRAGMA journal_mode=WAL")
conn.commit()
# Checkpoint so the main file is complete at this point, then keep everything
# after in the WAL only.
conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

SID3 = "d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9"
T = 1781010000.0  # 2026-06-09T13:00:00Z
conn.execute(
    "INSERT INTO sessions (id, source, model, started_at, cwd, input_tokens, output_tokens, api_call_count) VALUES (?,?,?,?,?,?,?,?)",
    (SID3, "cli", "claude-sonnet-5", T, "/home/dev/live", 500, 40, 1),
)
call = {"id": "call_live_w", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "notes.md", "content": "live\n"})}}
conn.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (SID3, "user", "write notes.md", T + 1))
conn.execute("INSERT INTO messages (session_id, role, content, tool_calls, timestamp, finish_reason) VALUES (?,?,?,?,?,?)",
             (SID3, "assistant", None, json.dumps([call]), T + 3, "tool_calls"))
conn.execute("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES (?,?,?,?,?,?)",
             (SID3, "tool", json.dumps({"bytes_written": 5, "verified": True, "resolved_path": "/home/dev/live/notes.md"}), "call_live_w", "write_file", T + 3.2))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?,?,?,?,?)", (SID3, "assistant", "Done.", T + 5, "stop"))
conn.commit()
# Copy the pair while the connection still holds the WAL open.
shutil.copyfile(work, work + ".main")
shutil.copyfile(work + "-wal", work + ".wal")
conn.close()
os.replace(work + ".main", work)
os.replace(work + ".wal", work + "-wal")
if os.path.exists(work + "-shm"):
    os.remove(work + "-shm")
print("wrote", work, os.path.getsize(work), "bytes;", work + "-wal", os.path.getsize(work + "-wal"), "bytes")
