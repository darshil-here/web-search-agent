"use strict";

// One persistent conversation. The session id lives in localStorage; history
// comes from SQLite through the API.
const STORAGE_KEY = "wsa.sessionId";

const $ = (id) => document.getElementById(id);
const thread = $("thread");
const empty = $("empty");
const input = $("input");
const action = $("action");

const state = { sessionId: null, timeZone: "UTC", lastDay: null, run: null };

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

const WARN_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 14.5 13H1.5L8 1.8Z"/><path d="M8 6.3v3.2M8 11.3v.1"/></svg>';

// ---------- dates ----------

function dayKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: state.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
const dayNumber = (key) => Date.UTC(...key.split("-").map((n, i) => (i === 1 ? n - 1 : +n))) / 864e5;

function dividerHtml(date) {
  const tz = state.timeZone;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
  const diff = dayNumber(dayKey(new Date())) - dayNumber(dayKey(date));
  const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(date);
  if (diff === 0) return `<b>Today</b> ${time}`;
  if (diff === 1) return `<b>Yesterday</b> ${time}`;
  if (diff > 1 && diff < 7) return `<b>${fmt({ weekday: "short" })}</b> ${time}`;
  const sameYear = fmt({ year: "numeric" }) === new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(new Date());
  const day = sameYear ? fmt({ weekday: "short", month: "short", day: "numeric" }) : fmt({ month: "short", day: "numeric", year: "numeric" });
  return `<b>${day}</b> at ${time}`;
}

// ---------- markdown (escape first, then a small safe subset) ----------

function shorten(url) {
  try {
    const u = new URL(url);
    const label = u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname) + u.search;
    return label.length > 40 ? label.slice(0, 39) + "…" : label;
  } catch {
    return url;
  }
}

function emphasis(escaped) {
  return escaped
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
}

function anchor(url, labelHtml) {
  return `<a href="${esc(url)}" title="${esc(url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
}

function stripTrailing(url) {
  let trail = "";
  for (;;) {
    const last = url.slice(-1);
    const unbalanced = last === ")" && url.split(")").length > url.split("(").length;
    if (/[.,;:!?'"\]*]/.test(last) || unbalanced) {
      trail = last + trail;
      url = url.slice(0, -1);
    } else return [url, trail];
  }
}

function inline(raw, { markup = true } = {}) {
  // Plain text (user messages) only gets bare URLs linkified.
  const re = markup
    ? /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g
    : /(https?:\/\/[^\s<>]+)/g;
  const text = (s) => (markup ? emphasis(esc(s)) : esc(s));
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    out += text(raw.slice(last, m.index));
    if (markup && m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
    else if (markup && m[2] !== undefined) out += anchor(m[3], emphasis(esc(m[2])));
    else {
      const [url, trail] = stripTrailing(markup ? m[4] : m[1]);
      out += anchor(url, esc(shorten(url))) + esc(trail);
    }
    last = re.lastIndex;
  }
  return out + text(raw.slice(last));
}

const splitRow = (line) =>
  line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());

/** One entry per bubble: a paragraph, a list, or a table. */
function toBlocks(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks = [];
  let heading = "";
  let para = [];

  const push = (html) => {
    blocks.push(heading ? `<p><strong>${heading}</strong></p>${html}` : html);
    heading = "";
  };
  const flush = () => {
    if (para.length) push(`<p>${para.map((l) => inline(l)).join("<br>")}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); continue; }

    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { flush(); if (heading) push(""); heading = inline(h[1].replace(/\*\*/g, "")); continue; }

    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      i--;
      const cells = (tag, row) => row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join("");
      push(
        `<div class="tablewrap"><table><thead><tr>${cells("th", head)}</tr></thead><tbody>${rows
          .map((r) => `<tr>${cells("td", r)}</tr>`)
          .join("")}</tbody></table></div>`
      );
      continue;
    }

    const li = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const item = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
        if (item && /\d/.test(item[1]) === ordered) items.push(item[2]);
        else if (item || lines[i].trim() === "" || !/^\s+\S/.test(lines[i])) break;
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      i--;
      const start = ordered ? ` start="${parseInt(li[1], 10)}"` : "";
      const tag = ordered ? "ol" : "ul";
      push(`<${tag}${start}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }

    para.push(line.trim());
  }
  flush();
  if (heading) push("");
  return blocks;
}

// ---------- thread rendering ----------

const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
const toBottom = (smooth) => thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });

function place(node, { smooth = true, keepPinned = nearBottom() } = {}) {
  const activity = state.run?.activity;
  if (activity && activity.isConnected && node !== activity) thread.insertBefore(node, activity);
  else thread.appendChild(node);
  empty.hidden = true;
  if (keepPinned) toBottom(smooth);
}

function markCluster(group) {
  const prev = group.previousElementSibling;
  if (prev && prev.classList.contains("group") && prev.classList.contains(group.dataset.role)) prev.classList.add("cont");
}

function maybeDivider(date, opts) {
  const key = dayKey(date);
  if (key === state.lastDay) return;
  state.lastDay = key;
  place(el("div", "divider", dividerHtml(date)), opts);
}

function fillGroup(group, role, content, flags = {}) {
  group.replaceChildren();
  if (role === "user") {
    group.appendChild(el("div", "bubble", inline(content, { markup: false })));
    return;
  }
  const blocks = toBlocks(content);
  for (const html of blocks.length ? blocks : [`<p>${esc(content)}</p>`]) {
    const bubble = el("div", "bubble", html);
    if (flags.warning) bubble.classList.add("warning");
    if (flags.error) bubble.classList.add("error");
    group.appendChild(bubble);
  }
}

function addMessage(role, content, createdAt, opts = {}) {
  const pinned = nearBottom();
  maybeDivider(new Date(createdAt), { ...opts, keepPinned: pinned });
  const group = el("div", `group ${role === "user" ? "sent" : "received"}`);
  group.dataset.role = role === "user" ? "sent" : "received";
  if (opts.enter) group.classList.add("enter");
  fillGroup(group, role, content, opts);
  place(group, { ...opts, keepPinned: pinned });
  markCluster(group);
  return group;
}

function addNotice(text, { warn = true, ...opts } = {}) {
  const node = el("div", warn ? "notice" : "notice quiet", (warn ? WARN_ICON : "") + `<span>${esc(text)}</span>`);
  place(node, opts);
  return node;
}

function setEmpty() {
  empty.hidden = thread.children.length > 0;
}

// ---------- activity bubble ----------

function showActivity() {
  const node = el("div", "activity");
  node.appendChild(el("div", "typing", '<span class="dot"></span><span class="dot"></span><span class="dot"></span>'));
  const caption = el("div", "caption");
  caption.setAttribute("role", "status");
  caption.textContent = "Sending…";
  node.appendChild(caption);
  node.caption = caption;
  place(node);
  return node;
}

// ---------- SSE ----------

function createSseParser(onEvent) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop();
    for (const frame of frames) {
      let event = "message";
      const data = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith(":") || line === "") continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      try { onEvent(event, JSON.parse(data.join("\n"))); } catch { /* ignore a malformed frame */ }
    }
  };
}

// ---------- running a turn ----------

function setAction() {
  const hasText = input.value.trim() !== "";
  const mode = state.run ? "stop" : hasText ? "send" : "off";
  action.dataset.mode = mode;
  action.setAttribute("aria-hidden", mode === "off");
  action.tabIndex = mode === "off" ? -1 : 0;
  action.setAttribute("aria-label", mode === "stop" ? "Stop" : "Send");
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}

async function send() {
  const text = input.value.trim();
  if (!text || state.run) return;

  input.value = "";
  autosize();

  addMessage("user", text, new Date().toISOString(), { enter: true });

  const run = { controller: new AbortController(), text: "", group: null, flags: {}, frame: 0, ended: false, activity: null };
  state.run = run;
  run.activity = showActivity();
  setAction();
  input.focus();

  const finishAnswer = () => {
    run.frame = 0;
    if (run.group) fillGroup(run.group, "assistant", run.text, run.flags);
    if (nearBottom()) toBottom(true);
  };

  const dropActivity = () => { run.activity?.remove(); run.activity = null; };

  const fail = (message) => {
    run.ended = true;
    dropActivity();
    const group = el("div", "group received");
    group.dataset.role = "received";
    group.appendChild(el("div", "bubble error", esc(message)));
    place(group);
    markCluster(group);
  };

  const onEvent = (event, data) => {
    if (event === "status") {
      if (run.activity) run.activity.caption.textContent = data.text;
      if (data.level === "warn") addNotice(data.text);
    } else if (event === "delta") {
      if (!run.group) {
        dropActivity();
        maybeDivider(new Date());
        run.group = el("div", "group received enter");
        run.group.dataset.role = "received";
        place(run.group);
        markCluster(run.group);
      }
      run.text += data.text;
      if (!run.frame) run.frame = requestAnimationFrame(finishAnswer);
    } else if (event === "done") {
      run.ended = true;
      if (data.stopReason === "budget") run.flags.warning = true;
      if (run.group) finishAnswer();
    } else if (event === "error") {
      fail(`Something went wrong: ${data.message}`);
    }
  };

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: text }),
      signal: run.controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      fail(`Something went wrong: ${body.error || response.statusText}`);
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser(onEvent);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
      parse(decoder.decode() + "\n\n");
      if (!run.ended) fail("Something went wrong: Connection closed before the answer finished");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      run.ended = true;
      dropActivity();
      addNotice("Stopped", { warn: false });
    } else {
      fail("Couldn't reach the server");
    }
  } finally {
    if (run.frame) { cancelAnimationFrame(run.frame); finishAnswer(); }
    dropActivity();
    state.run = null;
    setAction();
    input.focus();
  }
}

// ---------- history ----------

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function loadHistory() {
  thread.replaceChildren();
  state.lastDay = null;
  try {
    if (!state.sessionId) {
      const info = await api("/api/sessions");
      state.timeZone = info.timeZone;
      state.sessionId = localStorage.getItem(STORAGE_KEY) || info.defaultSessionId;
      localStorage.setItem(STORAGE_KEY, state.sessionId);
    }
    const body = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/messages`);
    state.timeZone = body.timeZone;
    for (const m of body.messages) addMessage(m.role, m.content, m.createdAt, { smooth: false, keepPinned: false });
    toBottom(false);
    setEmpty();
  } catch {
    const notice = addNotice("Couldn't load the conversation.", { smooth: false });
    const retry = el("button", "", "Retry");
    retry.type = "button";
    retry.addEventListener("click", loadHistory);
    notice.appendChild(retry);
  }
}

// ---------- chrome ----------

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
}

function fit() {
  const mobile = window.matchMedia("(max-width: 520px)").matches;
  const scale = mobile ? 1 : Math.min(1, (innerHeight - 32) / 922, (innerWidth - 32) / 451);
  document.documentElement.style.setProperty("--fit", String(scale));
}

input.addEventListener("input", () => { autosize(); setAction(); });
input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  send();
});
action.addEventListener("click", () => (state.run ? state.run.controller.abort() : send()));
$("composer").addEventListener("submit", (event) => event.preventDefault());
addEventListener("resize", fit);

fit();
tickClock();
setInterval(tickClock, 30_000);
setAction();
loadHistory().then(() => input.focus());
