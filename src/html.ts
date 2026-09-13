import type { AgitEvent, SessionMeta } from "./format/events.js";

/**
 * Other sessions to embed alongside the primary one, keyed by session id \u2014
 * subagent sessions spawned from it (or the parent it was spawned from),
 * discovered via `session.start.payload.parentSessionId` and a `tool.result`
 * `structured.agentId` (SPEC \u00a79). The viewer lets you jump into one and back
 * without a second export or a network fetch: everything is already in the
 * page.
 */
export type RelatedSessions = Record<string, { events: AgitEvent[]; meta: SessionMeta | null }>;

export function renderSessionHtml(events: AgitEvent[], meta?: SessionMeta | null, related?: RelatedSessions): string {
  const data = JSON.stringify({ events, meta: meta ?? null, related: related ?? {} })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'">
<title>agit · session</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: #0d1117;
  color: #c9d1d9;
}
header {
  padding: 16px 20px;
  border-bottom: 1px solid #30363d;
  background: #161b22;
}
h1 { margin: 0 0 6px; font-size: 18px; }
.meta {
  color: #8b949e;
  font-size: 12px;
  white-space: pre-wrap;
}
#navbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
#navbar button {
  font: inherit;
  cursor: pointer;
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 3px 10px;
}
#navbar button:hover { background: #30363d; }
#navbar .label { color: #8b949e; font-size: 12px; }
#searchBox, #typeFilter {
  font: inherit;
  background: #0d1117;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 3px 8px;
}
#searchBox { flex: 1; min-width: 120px; }
#matchCount { white-space: nowrap; }
.row[hidden] { display: none; }
.openSub {
  font: inherit;
  cursor: pointer;
  background: #1f2933;
  color: #7ee787;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 4px 10px;
  margin-top: 8px;
}
.openSub:hover { background: #263a2c; }
.layout {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(420px, 1fr);
  height: calc(100vh - 83px);
}
.panel {
  min-width: 0;
  overflow: auto;
}
#timeline {
  border-right: 1px solid #30363d;
}
.row {
  display: grid;
  grid-template-columns: 42px 72px 145px minmax(0, 1fr);
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #21262d;
  cursor: pointer;
}
.row:hover { background: #161b22; }
.row.sel { background: #1f2933; }
.seq, .t { color: #8b949e; }
.sum {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user { color: #79c0ff; }
.assistant { color: #d2a8ff; }
.toolcall { color: #ffa657; }
.toolresult { color: #7ee787; }
.filediff { color: #56d364; }
.cost { color: #a5d6ff; }
.err { background: #2d1b1b; }
.detail {
  padding: 18px;
}
.detail h3 {
  margin-top: 0;
  font-size: 13px;
  color: #8b949e;
  word-break: break-word;
}
pre {
  margin: 10px 0;
  padding: 12px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
}
pre.think {
  color: #8b949e;
}
pre.del { color: #ff7b72; }
pre .add { color: #7ee787; }
pre .del { color: #ff7b72; }
pre .hunk { color: #d2a8ff; }
.files {
  border-top: 1px solid #30363d;
  padding: 12px;
}
.files h2 {
  margin: 0 0 8px;
  font-size: 13px;
}
.file {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 6px;
  padding: 3px 0;
}
.file path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plus { color: #7ee787; }
.minus { color: #ff7b72; }
.muted { color: #8b949e; }
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
    height: auto;
  }
  #timeline {
    max-height: 50vh;
    border-right: 0;
    border-bottom: 1px solid #30363d;
  }
}
</style>
</head>
<body>
<header>
  <h1>agit · session</h1>
  <div id="meta" class="meta"></div>
  <div id="navbar">
    <span id="navLabel" class="label"></span>
    <button id="parentBtn" style="display:none"></button>
    <input id="searchBox" type="text" placeholder="filter events… (Enter: next, Shift+Enter: prev)">
    <select id="typeFilter"></select>
    <span id="matchCount" class="label"></span>
  </div>
</header>

<main class="layout">
  <section class="panel" id="timeline"></section>
  <section class="panel">
    <div id="detail" class="detail">
      <div class="muted">Select an event.</div>
    </div>
    <div class="files">
      <h2>Files</h2>
      <div id="flist" class="muted">No structured file edits.</div>
    </div>
  </section>
</main>

<script type="application/json" id="session-data">${data}</script>
<script>
"use strict";

var DATA = JSON.parse(
  document.getElementById("session-data")?.textContent ?? "{}"
);

var sessions = {};
var rootId = DATA.events && DATA.events.length ? DATA.events[0].session : null;
if (rootId) sessions[rootId] = { events: DATA.events || [], meta: DATA.meta || null };
var relatedData = DATA.related || {};
Object.keys(relatedData).forEach(function (id) {
  sessions[id] = {
    events: relatedData[id].events || [],
    meta: relatedData[id].meta || null
  };
});

var currentId = rootId;
var events = rootId ? sessions[rootId].events : [];
var meta = rootId ? sessions[rootId].meta : null;

var timeline = document.getElementById("timeline");
var detail = document.getElementById("detail");
var metaBox = document.getElementById("meta");
var fileList = document.getElementById("flist");
var navLabel = document.getElementById("navLabel");
var parentBtn = document.getElementById("parentBtn");
var searchBox = document.getElementById("searchBox");
var typeFilter = document.getElementById("typeFilter");
var matchCount = document.getElementById("matchCount");

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function str(v) {
  return typeof v === "string" ? v : "";
}

function oneLine(s, max) {
  s = s.replace(/\\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function chipClass(t) {
  return {
    "message.user": "user",
    "message.assistant": "assistant",
    "tool.call": "toolcall",
    "tool.result": "toolresult",
    "file.diff": "filediff",
    "file.delete": "filediff",
    "cost": "cost"
  }[t] || "";
}

function summary(e) {
  var p = e.payload || {};

  switch (e.type) {
    case "session.start":
      return "runtime " + str(p.runtime) + " " +
        str(p.runtimeVersion) +
        (p.cwd ? " · " + str(p.cwd) : "");

    case "session.end":
      return "reason " + str(p.reason);

    case "message.user":
      return oneLine(str(p.text), 160);

    case "message.assistant": {
      var blocks = Array.isArray(p.blocks) ? p.blocks : [];
      var texts = blocks
        .filter(function (b) { return b && b.type === "text"; })
        .map(function (b) { return str(b.text); })
        .join(" ");
      var kinds = blocks
        .map(function (b) { return str(b.type); })
        .join("+");
      return "[" + (kinds || "empty") + "] " + oneLine(texts, 140);
    }

    case "tool.call": {
      var input = p.input && typeof p.input === "object" ? p.input : {};
      var keys = Object.keys(input);
      var preferred = ["command", "file_path", "pattern", "path", "url", "prompt"]
        .filter(function (x) { return x in input; })[0] || keys[0];
      var value = preferred ? input[preferred] : "";
      return str(p.name) + "  " +
        oneLine(typeof value === "string" ? value : JSON.stringify(value || ""), 130);
    }

    case "tool.result":
      return (p.isError ? "ERROR " : "") +
        oneLine(str(p.output), 150);

    case "file.diff":
      return str(p.kind) + " " + str(p.path);

    case "file.delete":
      return "delete " + str(p.path);

    case "cost": {
      var u = p.usage || {};
      return str(p.model) +
        "  in=" + (u.inputTokens || 0) +
        " out=" + (u.outputTokens || 0);
    }

    default:
      return "";
  }
}

function addEvent(e) {
  var row = el("div", "row");
  row.dataset.seq = String(e.seq);

  if (e.type === "tool.result" && e.payload && e.payload.isError) {
    row.classList.add("err");
  }

  row.appendChild(el("span", "seq", String(e.seq)));
  row.appendChild(el("span", "t", str(e.ts).slice(11, 19)));
  row.appendChild(el("span", "chip " + chipClass(e.type), e.type));
  row.appendChild(el("span", "sum", summary(e)));

  row.addEventListener("click", function () {
    select(e.seq);
  });

  timeline.appendChild(row);
}

function select(seq) {
  var rows = timeline.children;

  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle(
      "sel",
      Number(rows[i].dataset.seq) === seq
    );
  }

  var e = events[seq];
  if (!e) return;

  detail.textContent = "";

  var heading = el(
    "h3",
    "",
    "event " + e.seq +
      " · " + e.ts +
      " · " + e.type +
      " · hash " + str(e.hash).slice(0, 12)
  );

  detail.appendChild(heading);

  var p = e.payload || {};

  if (e.type === "message.user") {
    detail.appendChild(el("pre", "", str(p.text)));

  } else if (e.type === "message.assistant") {
    var blocks = Array.isArray(p.blocks) ? p.blocks : [];

    blocks.forEach(function (b) {
      var thinking = b.type === "thinking";
      detail.appendChild(
        el(
          "pre",
          thinking ? "think" : "",
          (thinking ? "(thinking) " : "") + str(b.text)
        )
      );
    });

  } else if (e.type === "tool.call") {
    detail.appendChild(el("pre", "", str(p.name)));
    detail.appendChild(
      el("pre", "", JSON.stringify(p.input, null, 2))
    );

  } else if (e.type === "tool.result") {
    if (p.isError) {
      detail.appendChild(el("pre", "del", "(error)"));
    }

    detail.appendChild(el("pre", "", str(p.output)));

    if (p.structured) {
      detail.appendChild(
        el(
          "pre",
          "think",
          "structured: " +
            oneLine(JSON.stringify(p.structured), 600)
        )
      );

      var agentId = p.structured && p.structured.agentId;
      if (typeof agentId === "string" && sessions[agentId]) {
        var openBtn = el(
          "button",
          "openSub",
          "→ open subagent " + agentId.slice(0, 8)
        );
        openBtn.addEventListener("click", function () {
          loadSession(agentId);
        });
        detail.appendChild(openBtn);
      }
    }

  } else if (e.type === "file.diff") {
    detail.appendChild(
      el(
        "pre",
        "",
        str(p.kind) + " " + str(p.path) +
        "\\nbefore " + (p.beforeHash || "∅") +
        "\\nafter  " + str(p.afterHash)
      )
    );

    var pre = el("pre", "");

    str(p.diff).split("\\n").forEach(function (line) {
      var cls =
        line.charAt(0) === "+" ? "add" :
        line.charAt(0) === "-" ? "del" :
        line.slice(0, 2) === "@@" ? "hunk" :
        "";

      pre.appendChild(el("span", cls, line + "\\n"));
    });

    detail.appendChild(pre);

  } else {
    detail.appendChild(
      el("pre", "", JSON.stringify(p, null, 2))
    );
  }
}

function renderFiles() {
  var files = Object.create(null);

  events.forEach(function (e) {
    if (e.type === "file.delete") {
      var dp = str((e.payload || {}).path);
      var df = files[dp] || { added: 0, removed: 0, edits: 0, kind: "delete" };
      df.kind = "delete";
      df.edits++;
      files[dp] = df;
      return;
    }
    if (e.type !== "file.diff") return;

    var p = e.payload || {};
    var diff = str(p.diff);
    var added = 0;
    var removed = 0;

    diff.split("\\n").forEach(function (line) {
      if (line.charAt(0) === "+" && line.slice(0, 3) !== "+++") {
        added++;
      } else if (line.charAt(0) === "-" && line.slice(0, 3) !== "---") {
        removed++;
      }
    });

    var path = str(p.path);
    var f = files[path] || {
      added: 0,
      removed: 0,
      edits: 0,
      kind: str(p.kind)
    };

    f.added += added;
    f.removed += removed;
    f.edits++;
    if (f.kind === "delete") f.kind = str(p.kind) || "modify"; // re-created after a deletion
    files[path] = f;
  });

  fileList.textContent = "";

  var paths = Object.keys(files);

  if (paths.length === 0) {
    fileList.className = "muted";
    fileList.textContent = "No structured file edits.";
    return;
  }

  fileList.className = "";

  paths.forEach(function (path) {
    var f = files[path];
    var row = el("div", "file");

    row.appendChild(
      el(
        "span",
        f.kind === "create" ? "plus" : "",
        f.kind === "create" ? "A" : f.kind === "delete" ? "D" : "M"
      )
    );

    row.appendChild(el("path", "", path));

    var counts = el("span", "");

    counts.appendChild(
      el("span", "plus", "+" + f.added + " ")
    );
    counts.appendChild(
      el("span", "minus", "-" + f.removed)
    );

    row.appendChild(counts);
    fileList.appendChild(row);
  });
}

function renderMeta() {
  var first = events[0];
  var last = events[events.length - 1];

  var lines = [
    "session: " + (first ? str(first.session) : "unknown"),
    "events: " + events.length
  ];

  if (first && last) {
    lines.push("started: " + first.ts);
    lines.push("ended: " + last.ts);
  }

  if (meta) {
    lines.push(
      "adapter: " +
      str(meta.adapter && meta.adapter.name) +
      "@" +
      str(meta.adapter && meta.adapter.version)
    );
    lines.push("imported: " + str(meta.importedAt));
    lines.push("chain head: " + str(meta.headHash));
  }

  metaBox.textContent = lines.join("\\n");
}

function renderNav() {
  navLabel.textContent = "session " + currentId;

  var first = events[0];
  var p = (first && first.payload) || {};
  var parentId = typeof p.parentSessionId === "string" ? p.parentSessionId : null;

  if (parentId && sessions[parentId]) {
    parentBtn.style.display = "";
    parentBtn.textContent = "↑ parent " + parentId.slice(0, 8);
    parentBtn.onclick = function () {
      loadSession(parentId);
    };
  } else {
    parentBtn.style.display = "none";
  }
}

function populateTypeFilter() {
  var prev = typeFilter.value || "all";
  var seen = {};
  var types = [];

  events.forEach(function (e) {
    if (!seen[e.type]) {
      seen[e.type] = true;
      types.push(e.type);
    }
  });

  types.sort();

  typeFilter.textContent = "";
  typeFilter.appendChild(el("option", "", "all types"));
  typeFilter.firstChild.value = "all";

  types.forEach(function (t) {
    var opt = el("option", "", t);
    opt.value = t;
    typeFilter.appendChild(opt);
  });

  typeFilter.value = seen[prev] ? prev : "all";
}

function matchesFilter(e, q, type) {
  if (type !== "all" && e.type !== type) return false;
  if (!q) return true;
  return (e.type + " " + summary(e)).toLowerCase().indexOf(q) !== -1;
}

function applyFilter() {
  var q = searchBox.value.trim().toLowerCase();
  var type = typeFilter.value || "all";
  var rows = timeline.children;
  var visible = 0;

  for (var i = 0; i < events.length; i++) {
    var ok = matchesFilter(events[i], q, type);
    if (rows[i]) rows[i].hidden = !ok;
    if (ok) visible++;
  }

  matchCount.textContent = visible + "/" + events.length;
}

function jumpToMatch(dir) {
  var rows = Array.prototype.filter.call(timeline.children, function (r) {
    return !r.hidden;
  });
  if (!rows.length) return;

  var curIdx = -1;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].classList.contains("sel")) curIdx = i;
  }

  var nextIdx = curIdx === -1
    ? 0
    : dir === "prev"
      ? (curIdx - 1 + rows.length) % rows.length
      : (curIdx + 1) % rows.length;

  var target = rows[nextIdx];
  select(Number(target.dataset.seq));
  target.scrollIntoView({ block: "nearest" });
}

searchBox.addEventListener("input", applyFilter);
typeFilter.addEventListener("change", applyFilter);
searchBox.addEventListener("keydown", function (ev) {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  jumpToMatch(ev.shiftKey ? "prev" : "next");
});

/**
 * Switch the whole view to another embedded session — a spawned subagent,
 * or (via the parent button) up to the session that spawned this one. The
 * parent link is data (session.start.payload.parentSessionId), so it is
 * always correct regardless of how you navigated here — unlike a
 * back-in-history stack, it still points the right way through a chain of
 * several subagents (parent -> sub1 -> sub2: sub2's "parent" is sub1's own
 * session, not the root).
 */
function loadSession(id) {
  if (!sessions[id]) return;

  currentId = id;
  events = sessions[id].events;
  meta = sessions[id].meta;

  timeline.textContent = "";
  events.forEach(addEvent);
  renderFiles();
  renderMeta();
  renderNav();
  populateTypeFilter();
  applyFilter();

  if (events.length > 0) {
    select(events[0].seq);
  } else {
    detail.textContent = "";
    detail.appendChild(el("div", "muted", "No events."));
  }
}

if (rootId) loadSession(rootId);
</script>
</body>
</html>
`;
}
