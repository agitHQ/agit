"""Build fixtures/openclaw/agent.sqlite: the two synthetic OpenClaw transcripts
stored the way OpenClaw's agent database stores them.

The table is OpenClaw's own DDL, verbatim from src/state/openclaw-agent-schema.sql
(`transcript_events` and the `session_windows` row it references), and the
rows are what its reader reads back — `SELECT event_json FROM transcript_events
WHERE session_id = ? ORDER BY seq ASC` (src/config/sessions/session-accessor.sqlite-read.ts).
The events themselves are the existing synthetic JSONL fixtures, one row per
line, so this file adds no content the text fixtures do not already have;
it adds the container.

    python fixtures/openclaw/generate/sqlite.py fixtures/openclaw/agent.sqlite
"""
import json, os, sqlite3, sys

out = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
if os.path.exists(out):
    os.remove(out)

conn = sqlite3.connect(out)
conn.executescript(
    """
CREATE TABLE IF NOT EXISTS session_windows (
  session_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  previous_session_id TEXT,
  reason TEXT CHECK (reason IS NULL OR reason IN ('initial', 'reset', 'rollover', 'fork', 'rewind', 'switch', 'recovery', 'compaction')),
  session_scope TEXT NOT NULL DEFAULT 'conversation' CHECK (session_scope IN ('conversation', 'shared-main', 'group', 'channel')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS transcript_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE
) STRICT;
"""
)

for name in ("simple.jsonl", "edits.jsonl"):
    lines = [l for l in open(os.path.join(here, "..", name), encoding="utf-8").read().split("\n") if l.strip()]
    header = json.loads(lines[0])
    sid = header["id"]
    t0 = 1757325600000
    conn.execute(
        "INSERT INTO session_windows (session_id, session_key, reason, created_at, updated_at) VALUES (?, ?, 'initial', ?, ?)",
        (sid, f"agent:main:{sid}", t0, t0 + len(lines) * 1000),
    )
    # Rows inserted out of seq order on purpose: a reader must order by seq,
    # not trust rowid order, exactly as OpenClaw's own reader does.
    order = list(range(len(lines)))
    order = order[::2] + order[1::2]
    for seq in order:
        conn.execute(
            "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
            (sid, seq, lines[seq], t0 + seq * 1000),
        )
conn.commit()
for r in conn.execute("SELECT session_id, count(*), min(seq), max(seq) FROM transcript_events GROUP BY session_id"):
    print(r)
conn.close()
