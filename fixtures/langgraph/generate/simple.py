"""Generate a synthetic LangGraph SQLite checkpoint fixture with the real runtime.

A two-turn ReAct-style loop over MessagesState with a fake chat model (no
API): turn 1 asks for a note, the model calls a tool, the tool answers, the
model summarises; turn 2 is a plain follow-up. Everything is synthetic.
"""
import os, sys, sqlite3
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

out = sys.argv[1]
if os.path.exists(out):
    os.remove(out)


@tool
def write_note(path: str, text: str) -> str:
    """Write a short note to a file (synthetic: nothing is written)."""
    return f"wrote {len(text)} bytes to {path}"


responses = [
    AIMessage(
        content="I'll jot that down.",
        tool_calls=[{"name": "write_note", "args": {"path": "notes/todo.md", "text": "- buy milk\n"}, "id": "call_0001", "type": "tool_call"}],
        usage_metadata={"input_tokens": 41, "output_tokens": 17, "total_tokens": 58},
        response_metadata={"model_name": "fake-model-1"},
    ),
    AIMessage(
        content="Done: the note is in notes/todo.md.",
        usage_metadata={"input_tokens": 66, "output_tokens": 12, "total_tokens": 78},
        response_metadata={"model_name": "fake-model-1"},
    ),
    AIMessage(
        content="It says: buy milk.",
        usage_metadata={"input_tokens": 84, "output_tokens": 6, "total_tokens": 90},
        response_metadata={"model_name": "fake-model-1"},
    ),
]
model = FakeMessagesListChatModel(responses=responses)


def agent(state: MessagesState):
    return {"messages": [model.invoke(state["messages"])]}


def route(state: MessagesState):
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else END


g = StateGraph(MessagesState)
g.add_node("agent", agent)
g.add_node("tools", ToolNode([write_note]))
g.add_edge(START, "agent")
g.add_conditional_edges("agent", route, {"tools": "tools", END: END})
g.add_edge("tools", "agent")

conn = sqlite3.connect(out, check_same_thread=False)
saver = SqliteSaver(conn)
app = g.compile(checkpointer=saver)
cfg = {"configurable": {"thread_id": "thread-agit-fixture-0001"}}
app.invoke({"messages": [HumanMessage(content="Please note that I need to buy milk.")]}, cfg)
app.invoke({"messages": [HumanMessage(content="What does the note say?")]}, cfg)
conn.commit()
conn.close()

conn = sqlite3.connect(out)
rows = conn.execute("SELECT checkpoint_id, parent_checkpoint_id, type, length(checkpoint), metadata FROM checkpoints ORDER BY checkpoint_id").fetchall()
for r in rows:
    print(r[0], r[1], r[2], r[3], r[4][:120])
print("writes:", conn.execute("SELECT count(*) FROM writes").fetchone()[0])
print("journal:", conn.execute("PRAGMA journal_mode").fetchone(), "page_size:", conn.execute("PRAGMA page_size").fetchone())
print("tables:", conn.execute("SELECT name, sql FROM sqlite_master").fetchall())
