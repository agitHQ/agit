# Regenerating the LangGraph fixtures

Both databases here were written by the real runtime, not by hand:

    python -m venv venv && ./venv/bin/pip install langgraph==1.2.11 langgraph-checkpoint-sqlite==3.1.1 langchain-core==1.6.3
    ./venv/bin/python generate/simple.py simple.sqlite
    ./venv/bin/python generate/edges.py  edges.sqlite

Both graphs run a fake chat model (`FakeMessagesListChatModel`), so no API
key is involved and every message is synthetic. Regenerating produces new
checkpoint ids and timestamps, so `simple.golden.jsonl` must be regenerated
in the same commit (`agit import simple.sqlite`, copy the stored
`events.jsonl`) and the adapter test's counts re-checked.
