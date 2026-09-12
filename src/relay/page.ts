/**
 * The share page: a single self-contained HTML document, no external
 * resources (the CSP the relay serves it with forbids them anyway).
 *
 * Session logs are untrusted input. Every piece of log-derived text lands in
 * the DOM via textContent — never innerHTML — so nothing in a session can
 * script this page.
 */

export const SHARE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agit · shared session</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3;
    --dim: #8b949e; --accent: #58a6ff; --green: #3fb950; --red: #f85149;
    --chip: #21262d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 13px/1.45 ui-monospace, SFMono-Regular, Consolas, Menlo, monospace; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 14px;
           border-bottom: 1px solid var(--border); background: var(--panel);
           position: sticky; top: 0; }
  header .logo { font-weight: 700; color: var(--accent); }
  header .dim { color: var(--dim); }
  #status.live::before { content: "●"; color: var(--green); margin-right: 5px; }
  #status.ended::before { content: "●"; color: var(--dim); margin-right: 5px; }
  #status.gone::before { content: "●"; color: var(--red); margin-right: 5px; }
  main { display: grid; grid-template-columns: minmax(340px, 1.2fr) minmax(320px, 1fr);
         height: calc(100vh - 38px); }
  #timeline { overflow-y: auto; border-right: 1px solid var(--border); }
  .row { display: flex; gap: 8px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
         overflow: hidden; text-overflow: ellipsis; }
  .row:hover { background: var(--panel); }
  .row.sel { background: #1f2937; }
  .row .seq { color: var(--dim); min-width: 44px; text-align: right; }
  .row .t { color: var(--dim); }
  .chip { background: var(--chip); border: 1px solid var(--border); border-radius: 3px;
          padding: 0 5px; font-size: 11px; min-width: 96px; text-align: center; }
  .chip.user { color: #d2a8ff; } .chip.assistant { color: var(--accent); }
  .chip.toolcall { color: #e3b341; } .chip.toolresult { color: var(--dim); }
  .chip.filediff { color: var(--green); } .chip.cost { color: #f778ba; }
  .row .sum { overflow: hidden; text-overflow: ellipsis; }
  .row.err .sum { color: var(--red); }
  aside { display: flex; flex-direction: column; overflow: hidden; }
  #detail { flex: 1.4; overflow: auto; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  #detail h3 { margin: 0 0 8px; font-size: 12px; color: var(--dim); font-weight: 400; }
  #detail pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  #detail .add { color: var(--green); } #detail .del { color: var(--red); }
  #detail .hunk { color: var(--accent); }
  #detail .think { color: var(--dim); font-style: italic; }
  #side { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #files { overflow: auto; padding: 8px 12px; border-bottom: 1px solid var(--border); max-height: 34%; }
  #files h3, #chat h3 { margin: 0 0 6px; font-size: 11px; color: var(--dim); text-transform: uppercase;
                        letter-spacing: .06em; font-weight: 600; }
  #files .f { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #files .plus { color: var(--green); } #files .minus { color: var(--red); }
  #chat { flex: 1; display: flex; flex-direction: column; padding: 8px 12px; min-height: 120px; }
  #msgs { flex: 1; overflow: auto; margin-bottom: 6px; }
  #msgs .m { margin-bottom: 4px; }
  #msgs .who { color: #e3b341; }
  #msgs .when { color: var(--dim); font-size: 11px; }
  form { display: flex; gap: 6px; }
  input, button { background: var(--chip); color: var(--fg); border: 1px solid var(--border);
                  border-radius: 4px; padding: 5px 8px; font: inherit; }
  input:focus { outline: 1px solid var(--accent); }
  #name { width: 90px; } #text { flex: 1; } #key { width: 110px; display: none; }
  #chat.steer #key { display: inline-block; }
  .m .to { color: var(--dim); }
  button { cursor: pointer; } button:hover { border-color: var(--accent); }
  label.auto { margin-left: auto; color: var(--dim); font-size: 12px; user-select: none; }
  .hint { color: var(--dim); font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <span class="logo">agit</span>
  <span id="sid" class="dim"></span>
  <span id="status" class="live">connecting…</span>
  <span id="viewers" class="dim"></span>
  <span id="tokens" class="dim"></span>
  <label class="auto"><input type="checkbox" id="follow" checked> follow</label>
</header>
<main>
  <div id="timeline"></div>
  <aside>
    <div id="detail"><h3>select an event</h3></div>
    <div id="side">
      <div id="files"><h3>files touched</h3><div id="flist" class="dim">none yet (structured edits only)</div></div>
      <div id="chat">
        <h3>message the sharer</h3>
        <div id="msgs"></div>
        <form id="mform">
          <input id="name" placeholder="name" maxlength="40" autocomplete="off">
          <input id="key" type="password" placeholder="steer key" maxlength="64" autocomplete="off">
          <input id="text" placeholder="lands in their terminal — not injected into the agent" maxlength="4000" autocomplete="off">
          <button>send</button>
        </form>
        <div class="hint">Verify what you watched: append <code>/events.jsonl</code> to this page's API stream URL, then run <code>agit verify</code>.</div>
      </div>
    </div>
  </aside>
</main>
<script>
"use strict";
var shareId = location.pathname.split("/").pop();
var api = "/api/shares/" + shareId;
var $ = function (id) { return document.getElementById(id); };
$("sid").textContent = shareId.slice(0, 8) + "…";

var events = [];
var files = {};   // path -> {added, removed, edits, kind}
var totals = { input: 0, output: 0, msgs: 0 };
var selected = -1;

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function str(v) { return typeof v === "string" ? v : ""; }
function oneLine(s, max) {
  s = s.replace(/\\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function chipClass(t) {
  return { "message.user": "user", "message.assistant": "assistant", "tool.call": "toolcall",
           "tool.result": "toolresult", "file.diff": "filediff", "file.delete": "filediff", "cost": "cost" }[t] || "";
}
function summary(e) {
  var p = e.payload || {};
  switch (e.type) {
    case "session.start": return "runtime " + str(p.runtime) + " " + str(p.runtimeVersion) + (p.cwd ? " · " + p.cwd : "");
    case "session.end": return "reason " + str(p.reason);
    case "message.user": return oneLine(str(p.text), 160);
    case "message.assistant": {
      var texts = (p.blocks || []).filter(function (b) { return b.type === "text"; })
        .map(function (b) { return str(b.text); }).join(" ");
      var kinds = (p.blocks || []).map(function (b) { return str(b.type); }).join("+");
      return "[" + (kinds || "empty") + "] " + oneLine(texts, 140);
    }
    case "tool.call": {
      var input = p.input || {}; var k = Object.keys(input)[0];
      var pref = ["command", "file_path", "pattern", "path", "url", "prompt"].filter(function (x) { return x in input; })[0] || k;
      var v = pref ? input[pref] : "";
      return str(p.name) + "  " + oneLine(typeof v === "string" ? v : JSON.stringify(v || ""), 130);
    }
    case "tool.result": return (p.isError ? "ERROR " : "") + oneLine(str(p.output), 150);
    case "file.diff": return str(p.kind) + " " + str(p.path);
    case "file.delete": return "delete " + str(p.path);
    case "cost": {
      var u = p.usage || {};
      return str(p.model) + "  in=" + (u.inputTokens || 0) + " out=" + (u.outputTokens || 0);
    }
    default: return "";
  }
}

var timeline = $("timeline");
function addEvent(e) {
  events[e.seq] = e;
  var row = el("div", "row", "");
  row.dataset.seq = e.seq;
  if (e.type === "tool.result" && e.payload && e.payload.isError) row.classList.add("err");
  row.appendChild(el("span", "seq", String(e.seq)));
  row.appendChild(el("span", "t", (e.ts || "").slice(11, 19)));
  row.appendChild(el("span", "chip " + chipClass(e.type), e.type));
  row.appendChild(el("span", "sum", summary(e)));
  row.onclick = function () { select(e.seq); };
  timeline.appendChild(row);
  if (e.type === "file.diff" || e.type === "file.delete") foldFile(e);
  if (e.type === "cost") foldCost(e);
  if ($("follow").checked) timeline.scrollTop = timeline.scrollHeight;
}

function foldFile(e) {
  var p = e.payload || {}; var d = str(p.diff);
  var add = 0, del = 0;
  d.split("\\n").forEach(function (l) {
    if (l.charAt(0) === "+" && l.slice(0, 3) !== "+++") add++;
    else if (l.charAt(0) === "-" && l.slice(0, 3) !== "---") del++;
  });
  var f = files[p.path] || { added: 0, removed: 0, edits: 0, kind: p.kind };
  if (e.type === "file.delete") { f.kind = "delete"; f.edits++; }
  else { f.added += add; f.removed += del; f.edits++; if (f.kind === "delete") f.kind = p.kind || "modify"; }
  files[p.path] = f;
  var list = $("flist"); list.textContent = ""; list.classList.remove("dim");
  Object.keys(files).forEach(function (path) {
    var x = files[path];
    var row = el("div", "f", "");
    row.appendChild(el("span", x.kind === "create" ? "plus" : "", (x.kind === "create" ? "A " : x.kind === "delete" ? "D " : "M ")));
    row.appendChild(el("span", "", path + "  "));
    row.appendChild(el("span", "plus", "+" + x.added + " "));
    row.appendChild(el("span", "minus", "-" + x.removed));
    row.title = path;
    list.appendChild(row);
  });
}

function foldCost(e) {
  var u = (e.payload && e.payload.usage) || {};
  totals.input += u.inputTokens || 0;
  totals.output += u.outputTokens || 0;
  totals.msgs++;
  $("tokens").textContent = "tokens in " + totals.input + " · out " + totals.output;
}

function select(seq) {
  selected = seq;
  var rows = timeline.children;
  for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("sel", Number(rows[i].dataset.seq) === seq);
  var e = events[seq]; if (!e) return;
  var d = $("detail"); d.textContent = "";
  d.appendChild(el("h3", "", "event " + e.seq + " · " + e.ts + " · " + e.type + " · hash " + String(e.hash).slice(0, 12)));
  var p = e.payload || {};
  if (e.type === "message.user") {
    d.appendChild(el("pre", "", str(p.text)));
  } else if (e.type === "message.assistant") {
    (p.blocks || []).forEach(function (b) {
      d.appendChild(el("pre", b.type === "thinking" ? "think" : "", (b.type === "thinking" ? "(thinking) " : "") + str(b.text)));
    });
  } else if (e.type === "tool.call") {
    d.appendChild(el("pre", "", str(p.name)));
    d.appendChild(el("pre", "", JSON.stringify(p.input, null, 2)));
  } else if (e.type === "tool.result") {
    if (p.isError) d.appendChild(el("pre", "del", "(error)"));
    d.appendChild(el("pre", "", str(p.output)));
    if (p.structured) d.appendChild(el("pre", "think", "structured: " + oneLine(JSON.stringify(p.structured), 600)));
  } else if (e.type === "file.diff") {
    d.appendChild(el("pre", "", p.kind + " " + p.path + "\\nbefore " + (p.beforeHash || "∅") + "\\nafter  " + p.afterHash));
    var pre = el("pre", "", "");
    str(p.diff).split("\\n").forEach(function (line) {
      var cls = line.charAt(0) === "+" ? "add" : line.charAt(0) === "-" ? "del" : line.slice(0, 2) === "@@" ? "hunk" : "";
      pre.appendChild(el("span", cls, line + "\\n"));
    });
    d.appendChild(pre);
  } else {
    d.appendChild(el("pre", "", JSON.stringify(p, null, 2)));
  }
}

var es = new EventSource(api + "/stream");
es.addEventListener("ev", function (m) {
  try { addEvent(JSON.parse(m.data)); } catch (e) {}
});
es.addEventListener("info", function (m) {
  try {
    var info = JSON.parse(m.data);
    var s = $("status");
    s.className = info.live ? "live" : "ended";
    s.textContent = info.live ? "live" : "ended";
    $("viewers").textContent = info.viewers + " watching";
    // The sharer opted into steering: with the steer key they issued, a
    // message reaches the agent at its next turn boundary. Without one it
    // is still terminal-only, exactly as before.
    if (info.steer) {
      $("chat").classList.add("steer");
      $("text").placeholder = "with the steer key: reaches the agent at its next turn; without: their terminal only";
    }
  } catch (e) {}
});
es.addEventListener("msg", function (m) {
  try {
    var msg = JSON.parse(m.data);
    var box = $("msgs");
    var row = el("div", "m", "");
    row.appendChild(el("span", "when", msg.ts.slice(11, 19) + " "));
    row.appendChild(el("span", "who", msg.name + ": "));
    if (msg.steer) row.appendChild(el("span", "to", "⇢ agent "));
    row.appendChild(el("span", "", msg.text));
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  } catch (e) {}
});
es.onerror = function () {
  if (events.length === 0) {
    var s = $("status"); s.className = "gone"; s.textContent = "unreachable or expired";
  }
};

try { $("name").value = localStorage.getItem("agit-name") || ""; } catch (e) {}
$("mform").onsubmit = function (ev) {
  ev.preventDefault();
  var text = $("text").value.trim();
  if (!text) return;
  var name = $("name").value.trim() || "viewer";
  try { localStorage.setItem("agit-name", name); } catch (e) {}
  var body = { name: name, text: text };
  var key = $("key").value;
  if (key) body.key = key; // never stored: a steer key is a capability, not a preference
  fetch(api + "/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(function (r) { if (r.ok) $("text").value = ""; });
};
</script>
</body>
</html>
`;
