"""A second synthetic fixture, built by the real runtime, for the edge paths:
two threads in one database; a system message; list-shaped content with a
thinking part and an image part; a tool that errors; a subgraph (writes
checkpoints under its own namespace); and a branch made by update_state
against an older checkpoint, which the saver keeps beside the current one.
"""
import os, sys, sqlite3
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

out = sys.argv[1]
if os.path.exists(out):
    os.remove(out)


@tool
def read_note(path: str) -> str:
    """Read a note (synthetic: always fails)."""
    raise FileNotFoundError(f"no such note: {path}")


responses = [
    AIMessage(
        content=[
            {"type": "thinking", "thinking": "The user wants the note; I should read it."},
            {"type": "text", "text": "Let me read it."},
            {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
        ],
        tool_calls=[{"name": "read_note", "args": {"path": "notes/missing.md"}, "id": "call_r1", "type": "tool_call"}],
        usage_metadata={"input_tokens": 30, "output_tokens": 9, "total_tokens": 39, "input_token_details": {"cache_read": 12, "cache_creation": 3}},
        response_metadata={"model_name": "fake-model-2"},
    ),
    AIMessage(content="The note is missing.", usage_metadata={"input_tokens": 50, "output_tokens": 5, "total_tokens": 55}, response_metadata={"model_name": "fake-model-2"}),
    AIMessage(content="After the edit.", usage_metadata={"input_tokens": 20, "output_tokens": 3, "total_tokens": 23}, response_metadata={"model_name": "fake-model-2"}),
]
model = FakeMessagesListChatModel(responses=responses)


def agent(state: MessagesState):
    return {"messages": [model.invoke(state["messages"])]}


def route(state: MessagesState):
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else END


# A subgraph that just annotates: it checkpoints under its own namespace.
sub = StateGraph(MessagesState)
sub.add_node("annotate", lambda s: {"messages": [AIMessage(content="(subgraph ran)", id="sub-ai-1")]})
sub.add_edge(START, "annotate")
subgraph = sub.compile()

g = StateGraph(MessagesState)
g.add_node("agent", agent)
g.add_node("tools", ToolNode([read_note], handle_tool_errors=True))
g.add_node("sub", subgraph)
g.add_edge(START, "agent")
g.add_conditional_edges("agent", route, {"tools": "tools", END: "sub"})
g.add_edge("tools", "agent")
g.add_edge("sub", END)

conn = sqlite3.connect(out, check_same_thread=False)
saver = SqliteSaver(conn)
app = g.compile(checkpointer=saver)

a = {"configurable": {"thread_id": "thread/A with spaces"}}
app.invoke({"messages": [SystemMessage(content="You are terse."), HumanMessage(content="Read my note.")]}, a)
# Branch: update state against an older checkpoint, then continue from it.
history = list(app.get_state_history(a))
older = history[-2].config  # the checkpoint right after the input
app.update_state(older, {"messages": [HumanMessage(content="Edited from an older point.", id="edit-1")]})
app.invoke(None, a)

b = {"configurable": {"thread_id": "thread-B"}}
app.invoke({"messages": [HumanMessage(content="Hello from B.")]}, b)

# A message far larger than a page, so its checkpoint record crosses an
# overflow chain in the file: the reader's overflow path needs real pages.
c = {"configurable": {"thread_id": "thread-long"}}
app.invoke({"messages": [HumanMessage(content="Summarise this: " + ("lorem ipsum " * 1800))]}, c)

conn.commit()
conn.close()
conn = sqlite3.connect(out)
for r in conn.execute("SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, metadata FROM checkpoints ORDER BY thread_id, checkpoint_ns, checkpoint_id").fetchall():
    print(r[0], "|", r[1][:30], "|", r[2][-12:], "<-", (r[3] or "")[-12:], "|", r[4][:60])
