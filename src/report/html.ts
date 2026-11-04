import { createHash } from "node:crypto";
import type { AuditResult } from "../commands/audit.js";

/** JSON that is safe inside a <script> element. */
const embed = (data: unknown) =>
  JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root {
  --bg: #f7f7f8; --surface: #ffffff; --text: #18181b; --muted: #5f5f68; --border: #e2e2e6;
  --accent: #2f6fdf; --error: #c33131; --warning: #9a5b00; --info: #2f6fdf; --ok: #1f8a4c;
  --error-bg: #fdeeee; --warning-bg: #fdf3e2; --info-bg: #eaf1fd; --code: #f1f1f4;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111114; --surface: #1b1b20; --text: #ececf0; --muted: #a3a3ad; --border: #2e2e36;
    --accent: #6d9cf0; --error: #f07a7a; --warning: #e8a948; --info: #7aa7f2; --ok: #4cc283;
    --error-bg: #3a1c1e; --warning-bg: #36290f; --info-bg: #1b2a44; --code: #24242b;
  }
}
:root[data-theme="dark"] {
  --bg: #111114; --surface: #1b1b20; --text: #ececf0; --muted: #a3a3ad; --border: #2e2e36;
  --accent: #6d9cf0; --error: #f07a7a; --warning: #e8a948; --info: #7aa7f2; --ok: #4cc283;
  --error-bg: #3a1c1e; --warning-bg: #36290f; --info-bg: #1b2a44; --code: #24242b;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 96px; }
h1 { font-size: 21px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 10px; }
a { color: var(--accent); }
.sub { color: var(--muted); font-size: 13px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 6px; }
code, .cmd { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background: var(--code); border-radius: 4px; padding: 1px 5px; overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 20px 0 14px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.tile[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.tile .n { font-size: 24px; font-weight: 650; display: block; font-variant-numeric: tabular-nums; }
.tile.error .n { color: var(--error); } .tile.warning .n { color: var(--warning); } .tile.info .n { color: var(--info); } .tile.ignored .n { color: var(--muted); }
.filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.card { background: var(--surface); border: 1px solid var(--border); border-left-width: 4px; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
.card.error { border-left-color: var(--error); } .card.warning { border-left-color: var(--warning); } .card.info { border-left-color: var(--info); } .card.ignored { border-left-color: var(--muted); }
.head { display: flex; gap: 8px; align-items: baseline; }
.badge { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .03em; border-radius: 4px; padding: 1px 6px; flex: none; }
.badge.error { color: var(--error); background: var(--error-bg); } .badge.warning { color: var(--warning); background: var(--warning-bg); } .badge.info { color: var(--info); background: var(--info-bg); } .badge.ignored { color: var(--muted); background: var(--code); }
.msg { font-weight: 560; overflow-wrap: anywhere; }
.where, .rule { color: var(--muted); font-size: 12.5px; margin-top: 4px; overflow-wrap: anywhere; }
.fix { margin-top: 6px; }
.fix::before { content: "→ "; color: var(--muted); }
details { margin-top: 6px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
details p { margin: 6px 0; }
.actions { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
button.act { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
button.act:hover, .chip:hover, .tile:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ignore-form { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); }
.ignore-form label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
.ignore-form input { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
.cmd { display: block; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--code); border-radius: 6px; padding: 8px 10px; margin-top: 8px; user-select: all; }
.copied { color: var(--ok); font-size: 13px; }
.empty { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; text-align: center; color: var(--muted); }
.bar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--surface); border-top: 1px solid var(--border); padding: 10px 16px; display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap; }
.hidden { display: none !important; }
ul.plain { padding-left: 18px; margin: 6px 0; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 640px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

const SCRIPT = `
"use strict";
var data = JSON.parse(document.getElementById("data").textContent);
var rules = {};
data.rules.forEach(function (r) { rules[r.id] = r; });
var state = { severity: null, platform: "all" };
var reasons = {};

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function quote(text) {
  return /^[A-Za-z0-9_.:@\\/-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\\\''") + "'";
}
function command(f, reason) {
  return "npx rn-preflight ignore " + quote(f.rule) + " " + quote(f.key) + " --reason " + quote(reason);
}
function copy(text, status) {
  function done() { status.textContent = "Copied"; setTimeout(function () { status.textContent = ""; }, 2000); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { status.textContent = "Select the command and copy it"; });
  } else {
    status.textContent = "Select the command and copy it";
  }
}
function id(f) { return f.rule + "\\u0000" + f.key; }
function platformOf(f) { var r = rules[f.rule]; return r ? r.platform : "both"; }

function rulePart(card, f) {
  var r = rules[f.rule];
  card.appendChild(el("div", "rule", (r ? r.title + " · " : "") + f.rule + " · key " + f.key));
  if (!r) return;
  var more = el("details");
  more.appendChild(el("summary", null, "Why it matters"));
  more.appendChild(el("p", null, r.why));
  if (r.docs.length) {
    var list = el("ul", "plain");
    r.docs.forEach(function (url) {
      var li = el("li");
      if (/^https:\\/\\//.test(url)) {
        var a = el("a", null, url);
        a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
        li.appendChild(a);
      } else {
        li.textContent = url;
      }
      list.appendChild(li);
    });
    more.appendChild(list);
  }
  more.appendChild(el("p", "sub", "Rule last checked against the stores' rules on " + r.checkedOn + "."));
  card.appendChild(more);
}

function findingCard(f) {
  var card = el("article", "card " + f.severity);
  var head = el("div", "head");
  head.appendChild(el("span", "badge " + f.severity, f.severity));
  head.appendChild(el("span", "msg", f.message));
  card.appendChild(head);
  if (f.file) card.appendChild(el("div", "where", f.file + (f.line ? ":" + f.line : "")));
  if (f.fix) card.appendChild(el("div", "fix", f.fix));
  rulePart(card, f);

  var actions = el("div", "actions");
  var open = el("button", "act", "Ignore…");
  open.type = "button";
  actions.appendChild(open);
  card.appendChild(actions);

  var form = el("div", "ignore-form hidden");
  var label = el("label", null, "Why is this fine? (saved in preflight.config.json for the next person)");
  var input = el("input");
  input.type = "text";
  input.placeholder = "e.g. CI signs the bundle with the upload key";
  input.id = "reason-" + Math.random().toString(36).slice(2);
  label.htmlFor = input.id;
  var cmd = el("code", "cmd");
  var row = el("div", "actions");
  var copyButton = el("button", "act primary", "Copy command");
  copyButton.type = "button";
  var status = el("span", "copied");
  row.appendChild(copyButton);
  row.appendChild(status);
  form.appendChild(label);
  form.appendChild(input);
  form.appendChild(cmd);
  form.appendChild(row);
  card.appendChild(form);

  function update() {
    var reason = input.value.trim();
    if (reason) reasons[id(f)] = { finding: f, reason: reason }; else delete reasons[id(f)];
    cmd.textContent = reason ? command(f, reason) : "Type a reason to get the command.";
    copyButton.disabled = !reason;
    renderBar();
  }
  open.addEventListener("click", function () {
    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) input.focus();
  });
  input.addEventListener("input", update);
  copyButton.addEventListener("click", function () { copy(cmd.textContent, status); });
  update();
  return card;
}

function ignoredCard(f) {
  var card = el("article", "card ignored");
  var head = el("div", "head");
  head.appendChild(el("span", "badge ignored", "ignored"));
  head.appendChild(el("span", "msg", f.message));
  card.appendChild(head);
  card.appendChild(el("div", "fix", "Reason: " + f.reason + (f.date ? " (" + f.date + ")" : "")));
  if (f.file) card.appendChild(el("div", "where", f.file + (f.line ? ":" + f.line : "")));
  rulePart(card, f);
  return card;
}

var bar = el("div", "bar hidden");
var barText = el("span");
var barButton = el("button", "act primary", "Copy all commands");
barButton.type = "button";
var barStatus = el("span", "copied");
bar.appendChild(barText); bar.appendChild(barButton); bar.appendChild(barStatus);
document.body.appendChild(bar);
barButton.addEventListener("click", function () {
  var lines = Object.keys(reasons).map(function (k) { return command(reasons[k].finding, reasons[k].reason); });
  copy(lines.join("\\n"), barStatus);
});
function renderBar() {
  var n = Object.keys(reasons).length;
  bar.classList.toggle("hidden", n < 2);
  barText.textContent = n + " findings have a reason";
}

var list = document.getElementById("findings");
var ignoredList = document.getElementById("ignored");
var cards = data.findings.map(function (f) { var c = findingCard(f); list.appendChild(c); return { f: f, card: c }; });
var ignoredCards = data.ignored.map(function (f) { var c = ignoredCard(f); ignoredList.appendChild(c); return c; });
var empty = el("div", "empty");
list.appendChild(empty);

function apply() {
  var shown = 0;
  var showIgnored = state.severity === "ignored";
  cards.forEach(function (x) {
    var p = platformOf(x.f);
    var ok = !showIgnored && (!state.severity || x.f.severity === state.severity) && (state.platform === "all" || p === state.platform || p === "both");
    x.card.classList.toggle("hidden", !ok);
    if (ok) shown++;
  });
  document.getElementById("ignored-section").classList.toggle("hidden", !data.ignored.length || (state.severity && !showIgnored));
  empty.classList.toggle("hidden", shown > 0 || showIgnored);
  empty.textContent = data.findings.length ? "Nothing matches these filters." : "No problems found. Ship it.";
  document.querySelectorAll(".tile").forEach(function (t) { t.setAttribute("aria-pressed", String(t.dataset.severity === state.severity)); });
  document.querySelectorAll(".chip").forEach(function (c) { c.setAttribute("aria-pressed", String(c.dataset.platform === state.platform)); });
}
document.querySelectorAll(".tile").forEach(function (t) {
  t.addEventListener("click", function () { state.severity = state.severity === t.dataset.severity ? null : t.dataset.severity; apply(); });
});
document.querySelectorAll(".chip").forEach(function (c) {
  c.addEventListener("click", function () { state.platform = c.dataset.platform; apply(); });
});
apply();
`;

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/**
 * The report runs only its own script and stylesheet, pinned by hash: no other scripts, no network requests,
 * no forms, no plugins, no <base>. It's safe to open from a CI artifact or to host as a page.
 */
function contentSecurityPolicy(script: string, style: string) {
  return ["default-src 'none'", `script-src ${sha256(script)}`, `style-src ${sha256(style)}`, "base-uri 'none'", "form-action 'none'", "object-src 'none'"].join("; ");
}

export function renderReport(result: AuditResult): string {
  const app = result.app;
  const title = app.name ?? "React Native app";
  const meta = [
    `React Native ${app.reactNative}`,
    ...(app.ios ? [`iOS ${app.ios.version} · ${app.ios.target} (${app.ios.configuration})`] : []),
    ...(app.android ? [`Android ${app.android.version}${app.android.applicationId ? ` · ${app.android.applicationId}` : ""}`] : []),
    ...(app.comparedWith ? [`versions compared with ${app.comparedWith}`] : []),
  ];
  const tile = (severity: string, label: string, n: number) =>
    `<button type="button" class="tile ${severity}" data-severity="${severity}" aria-pressed="false"><span class="n">${n}</span>${label}</button>`;
  const chip = (platform: string, label: string) => `<button type="button" class="chip" data-platform="${platform}" aria-pressed="false">${label}</button>`;
  const notes = [
    ...result.stale.map((e) => `preflight.config.json ignores ${e.rule} ${e.key}, which no longer happens; remove that entry.`),
    ...result.notes,
  ];
  const platforms = app.platforms.length > 1 ? `${chip("all", "All")}${chip("ios", "iOS")}${chip("android", "Android")}` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(SCRIPT, STYLE)}">
<meta name="referrer" content="no-referrer">
<title>Store preflight · ${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>Store preflight · ${escapeHtml(title)}</h1>
<div class="sub meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join("")}</div>
<div class="sub meta"><span>${escapeHtml(result.generatedAt.replace("T", " ").slice(0, 16))} UTC</span><span>rn-preflight ${escapeHtml(result.version)}, ${result.rules.length} rules</span></div>
</header>
<div class="tiles">${tile("error", "Errors", result.counts.error)}${tile("warning", "Warnings", result.counts.warning)}${tile("info", "Info", result.counts.info)}${tile("ignored", "Ignored", result.ignored.length)}</div>
<div class="filters">${platforms}</div>
<h2>Findings</h2>
<section id="findings"></section>
<section id="ignored-section"><h2>Ignored in preflight.config.json</h2><div id="ignored"></div></section>
${notes.length ? `<section><h2>Notes</h2><ul class="plain sub">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></section>` : ""}
<p class="sub">Run ignore commands in the app's root folder. Errors are things the stores reject; warnings often lead to rejection or a bad release.</p>
</main>
<script type="application/json" id="data">${embed(result)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
