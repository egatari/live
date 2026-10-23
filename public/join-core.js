// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live learner join page: the DOM-free core (link parsing, retry policy, protocol client).
// /join.js draws it; the tests drive it with a fake WebSocket and a fake clock.
//
// Same data rules as a player (format spec extensions/live.md §2.3, PROTOCOL.md §7): it sends only `ask`,
// `vote`, `confused` (the learner's own tap), `name` (only if the learner typed one), `activities` (to learn
// the room's polls; no learner data) and `ping`. The pid is random, made on the device, and kept in localStorage (memory if storage is blocked).
// It never makes an HTTP request: the only network use is the learner WebSocket, whose URL carries the key
// as the protocol defines. The room and key come from the page's fragment, which browsers never send.

export const RE = Object.freeze({
  room: /^r-[a-z2-7]{8}$/,
  key: /^[A-Za-z0-9_-]{22,64}$/,
  pid: /^[A-Za-z0-9_-]{16,43}$/,
  step: /^(\*|[^\u0000-\u001f\u007f:]{1,80}:[^\u0000-\u001f\u007f:]{1,16})$/,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/,
});
export const LIMITS = Object.freeze({ question: 500, name: 40 });
export const SKEW_MS = 2 * 60 * 1000;          // the server's leeway at both window edges
export const PING_MS = 45000;                   // the protocol allows at most one ping per 30 s

// ------------------------------------------------------------------ links

/** The join link the teacher shares. Room and key travel only in the fragment. */
export function joinUrl(origin, room, key) {
  return `${origin}/join#room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}`;
}

/**
 * "Text to share": a ready-to-paste plain-text message for handing out the lesson with its live room.
 * Computers open the attached file; phones and tablets open the join link (iOS cannot run a downloaded HTML file).
 */
export function shareText(lang, link) {
  if (lang === "ja") {
    return [
      "ライブ（質問と投票）への参加のしかた",
      "・パソコン：添付のファイルをダウンロードして、ブラウザ（Chrome・Edge・Safari など）で開いてください。",
      "・スマートフォン・タブレット：次のリンクを開いてください。",
      link,
      "※ Slack などでは、大きなファイルはプレビューが出ないことがあります。そのときはダウンロードしてから開いてください。",
    ].join("\n");
  }
  return [
    "How to join the Live (questions and polls)",
    "- On a computer: download the attached file and open it in a browser (Chrome, Edge, Safari, ...).",
    "- On a phone or tablet: open this link:",
    link,
    "Note: Slack and other apps may not preview large files. If there is no preview, download the file and then open it.",
  ].join("\n");
}

/** Read {room, key} from a location.hash ("#room=…&key=…"); null if either is missing or malformed. */
export function parseFragment(hash) {
  const q = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const room = q.get("room") || "", key = q.get("key") || "";
  return RE.room.test(room) && RE.key.test(key) ? { room, key } : null;
}

/** The learner WebSocket URL on the page's own origin (http → ws, https → wss). */
export function socketUrl(origin, room, key, pid) {
  const u = new URL(origin);
  const scheme = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : null;
  if (!scheme || !RE.room.test(room) || !RE.key.test(key) || !RE.pid.test(pid)) return null;
  return `${scheme}//${u.host}/ws?room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}&pid=${encodeURIComponent(pid)}`;
}

// ------------------------------------------------------------------ retry policy (same table as the Studio player)

// Close codes (protocol/close-codes.json). kind: "retry" = reconnect by itself; "manual" = stop and offer a
// "Try again" button; "stop" = this link cannot join (no button).
export const CODES = Object.freeze({
  4400: "bad_message", 4401: "unauthorized", 4403: "bad_key", 4404: "room_not_found", 4409: "superseded",
  4410: "room_expired", 4423: "room_closed", 4425: "too_early", 4429: "rate_limited", 4430: "room_full",
  4440: "key_replaced", 4441: "not_approved",
});
export const RETRY_MIN_MS = Object.freeze({ 4423: 30000, 4425: 0, 4429: 60000, 4430: 60000 });
// Never reconnected by itself. 4409 (joined elsewhere) and 4441 (declined) may be retried by hand.
const MANUAL = new Set([4409, 4441]);
export const BACKOFF = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
// Before the first `welcome` the page does not know the window (the link carries only room and key), so a
// network error is retried at most this many times; after that the learner gets a "Try again" button.
export const MAX_BLIND_ATTEMPTS = 8;

export function closeInfo(code) {
  if (CODES[code]) {
    const kind = Object.prototype.hasOwnProperty.call(RETRY_MIN_MS, code) ? "retry" : MANUAL.has(code) ? "manual" : "stop";
    return { code, name: CODES[code], kind };
  }
  if (code >= 4000 && code <= 4999) return { code, name: "unknown", kind: "manual" };
  return { code, name: "network", kind: "retry" };   // 1000-range: the network dropped, a server restart, …
}

const timeOf = (s) => (typeof s === "string" && RE.datetime.test(s) ? Date.parse(s) : NaN);
export const windowStart = (w) => timeOf(w && w.from) - SKEW_MS;
export const windowEnd = (w) => timeOf(w && w.to) + SKEW_MS;

/**
 * Whether and when to reconnect after a close.
 * @param code close code; attempt: 0 for the first retry; now: ms; win: the room's window or null (not known yet);
 * rand: 0..1 for jitter. Returns {retry: true, delayMs} or {retry: false, reason, manual}.
 */
export function plan(code, attempt, now, win, rand = 0.5) {
  const info = closeInfo(code);
  if (info.kind !== "retry") return { retry: false, reason: info.name, manual: info.kind === "manual" };
  const known = !!win && Number.isFinite(windowEnd(win));
  if (info.name === "network" && !known && attempt >= MAX_BLIND_ATTEMPTS) return { retry: false, reason: "network", manual: true };
  const base = BACKOFF[Math.min(Math.max(attempt | 0, 0), BACKOFF.length - 1)];
  const min = RETRY_MIN_MS[code] || 0;
  let d = Math.round(Math.max(base, min) * (0.8 + 0.4 * rand));   // ±20 % so that a class does not reconnect at once
  d = Math.max(d, min);
  if (code === 4425) {
    // too early: at window.from (the server's edge, from − 2 min) plus 0–5 s; without a known window, ≥ 30 s growing to 5 min
    const f = known ? windowStart(win) : NaN;
    d = Number.isFinite(f) && f - now >= 5000 ? f - now + Math.round(5000 * rand)
      : Math.min(30000 * 2 ** Math.min(attempt | 0, 4), 300000) + Math.round(5000 * rand);
  }
  if (known && now + d > windowEnd(win)) return { retry: false, reason: "window_over", manual: false };
  return { retry: true, delayMs: d };
}

// ------------------------------------------------------------------ storage (try/catch, memory fallback)

export function makeStore(local) {
  const mem = new Map();
  return {
    get(k) {
      try { const v = local ? local.getItem(k) : null; if (v !== null && v !== undefined) return v; } catch { /* blocked */ }
      return mem.has(k) ? mem.get(k) : null;
    },
    set(k, v) {
      try { if (local) { if (v === null) local.removeItem(k); else local.setItem(k, v); } } catch { /* blocked */ }
      if (v === null) mem.delete(k); else mem.set(k, v);
    },
  };
}

export function newPid(cryptoObj = globalThis.crypto) {
  const b = new Uint8Array(16);
  cryptoObj.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------------------------ activities as the page shows them

const STEP_WORDS = { ja: { whole: "教材全体", step: "ステップ" }, en: { whole: "whole lesson", step: "step" } };

/**
 * The text shown for an activity's step: its `label` (display text the editor wrote, e.g.
 * 「4 枚目『XML の壁』・ステップ 1」) if it has one; "*" is the whole lesson; otherwise the key itself,
 * as "s-xxx · ステップ 1" when it reads as "<slide>:<k>" with a number k (0-based in the key, 1-based here).
 * Only ever shown with textContent.
 */
export function stepText(step, label, lang = "ja") {
  const W = STEP_WORDS[lang === "en" ? "en" : "ja"];
  if (typeof label === "string" && label.trim()) return label.trim();
  if (step === "*") return W.whole;
  const s = String(step || ""), i = s.lastIndexOf(":");
  if (i > 0) {
    const slide = s.slice(0, i), k = s.slice(i + 1);
    return `${slide} · ${W.step} ${/^\d+$/.test(k) ? Number(k) + 1 : k}`;
  }
  return s;
}

/**
 * From the room's activities: the Q&A to send questions to, the "I don't follow" activity, and every poll with its step key.
 * There is no deck position on this page and the protocol has no notion of an "open" poll, so all polls
 * the room declares are listed, in declaration order, each labelled with its prompt and its step (the
 * activity's `label` if it has one, see stepText).
 * Polls without choices (inferred from votes, when the teacher set no activities) cannot be shown.
 * If the room declares nothing, it takes questions under any id, so questions go to "qa" under "*"; it never
 * takes "I don't follow" (live §3), so the page offers it only for a `confused` activity declared under "*".
 * `declared` is null until the room has answered `{t:"activities"}`: until then the page offers nothing, so
 * that a tap right after joining is not sent to an activity the room does not have.
 */
export function viewOf(activities, declared) {
  const polls = [];
  let qa = null, confused = null;
  if (declared !== true && declared !== false) return { qa, confused, polls };
  for (const [step, list] of Object.entries(activities || {})) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || typeof a.id !== "string") continue;
      if (a.kind === "qa" && (!qa || (step === "*" && qa.step !== "*"))) qa = { id: a.id, step };
      // this page has no step on screen, so only an "I don't follow" declared for the whole lesson ("*") fits it
      if (a.kind === "confused" && step === "*" && !confused) confused = { id: a.id, step };
      if (a.kind === "poll" && Array.isArray(a.choices) && a.choices.length >= 2) {
        polls.push({ id: a.id, step, prompt: typeof a.prompt === "string" ? a.prompt : "", choices: a.choices.filter((c) => typeof c === "string"),
          ...(typeof a.label === "string" && a.label ? { label: a.label } : {}) });
      }
    }
  }
  if (!qa && !declared) qa = { id: "qa", step: "*" };
  return { qa, confused, polls };
}

// ------------------------------------------------------------------ the client

/**
 * States: "idle" (before Join), "connecting", "waiting" (for the teacher's approval), "connected",
 * "retrying", "stopped" (reason; `manual` says whether a "Try again" button is offered), "left".
 * deps: {origin, room, key, WebSocket, localStorage, sessionStorage, crypto, now, random, setTimeout, clearTimeout,
 *        setInterval, clearInterval, onChange(snapshot, event)}.
 */
export class JoinClient {
  constructor(deps) {
    this.d = deps;
    this.room = deps.room;
    this.key = deps.key;
    this.local = makeStore(deps.localStorage);
    this.session = makeStore(deps.sessionStorage);
    this.st = "idle";
    this.reason = "";
    this.manual = false;
    this.code = 0;
    this.attempt = 0;
    this.retryAt = 0;
    this.win = null;
    this.admitted = false;
    this.shown = [];
    this.activities = {};
    this.declared = null;     // null until the room answers {t:"activities"}; then whether the teacher set activities
    this.votes = {};          // poll id -> {choice, ok}
    this.replies = {};        // item id -> the host's reply to one of this learner's questions
    this.confusedOn = false;  // this learner's "I don't follow" (step "*": this page has no step on screen)
    this.pending = {};        // ref -> what was sent
    this.refN = 0;
    this.name = "";           // the name the learner typed
    this.nameSent = "";
    this.ws = null;
    this.timers = { retry: null, ping: null };
  }

  get joinedKey() { return "egatari-live-joined:" + this.room; }

  pid() {
    const k = "egatari-live-pid:" + this.room;
    let p = this.local.get(k);
    if (!p || !RE.pid.test(p)) { p = newPid(this.d.crypto); this.local.set(k, p); }
    return p;
  }

  /** True if this tab joined before (a reload): the page may reconnect without another tap. */
  joinedBefore() { return this.session.get(this.joinedKey) === "1"; }

  snapshot() {
    return {
      state: this.st, reason: this.reason, manual: this.manual, code: this.code, attempt: this.attempt,
      retryInMs: this.st === "retrying" ? Math.max(0, this.retryAt - this.d.now()) : null,
      window: this.win, admitted: this.admitted, shown: this.shown.slice(),
      view: viewOf(this.activities, this.declared), votes: { ...this.votes },
      replies: Object.values(this.replies).sort((a, b) => String(a.at).localeCompare(String(b.at))), confused: this.confusedOn,
    };
  }

  emit(event) { if (this.d.onChange) this.d.onChange(this.snapshot(), event || null); }
  set(state, extra = {}) {
    this.st = state;
    this.reason = extra.reason || "";
    this.manual = !!extra.manual;
    this.emit(extra.event);
  }

  // ---------------------------------------------------------------- learner actions
  join() {
    if (this.st === "connecting" || this.st === "connected" || this.st === "waiting") return;
    this.attempt = 0;
    this.session.set(this.joinedKey, "1");
    this.connect();
  }

  leave() {
    this.clearTimers();
    this.session.set(this.joinedKey, null);
    const s = this.ws;
    this.ws = null;
    if (s) { try { s.close(1000, "bye"); } catch { /* closed */ } }
    this.admitted = false;
    this.pending = {};
    this.set("left");
  }

  ask(text) {
    const q = String(text || "").trim();
    const { qa } = viewOf(this.activities, this.declared);
    if (!q) return this.emit({ type: "error", code: "empty_text" });
    if (!qa || !this.admitted) return this.emit({ type: "error", code: "not_admitted" });
    // A Q&A declared under "*" gets the step key "*" (there is no step on screen here, PROTOCOL.md §3.2).
    return this.request({ t: "ask", activity: qa.id, step: qa.step, text: [...q].slice(0, LIMITS.question).join("") }, { kind: "ask" });
  }

  vote(pollId, choice) {
    const p = viewOf(this.activities, this.declared).polls.find((x) => x.id === pollId);
    if (!p || !Number.isInteger(choice) || choice < 0 || choice >= p.choices.length || !this.admitted) return false;
    const ok = this.request({ t: "vote", activity: p.id, step: p.step, choice }, { kind: "vote", id: p.id, choice, prev: this.votes[p.id] || null });
    if (ok) { this.votes[p.id] = { choice, ok: false }; this.emit(); }
    return ok;
  }

  /** "I don't follow": one tap marks it, another takes it back. No text; counted per step by the room. */
  confused(on) {
    const { confused } = viewOf(this.activities, this.declared);
    if (!confused || !this.admitted) return false;
    const want = on === undefined ? !this.confusedOn : !!on;
    const ok = this.request({ t: "confused", activity: confused.id, step: confused.step, on: want }, { kind: "confused", on: want, prev: this.confusedOn });
    if (ok) { this.confusedOn = want; this.emit(); }
    return ok;
  }

  setReplies(list) {
    for (const r of Array.isArray(list) ? list.slice(0, 400) : []) {
      if (r && typeof r.item === "string" && typeof r.text === "string") this.replies[r.item] = { item: r.item, question: typeof r.question === "string" ? r.question : "",
        text: r.text, public: r.public === true, at: typeof r.at === "string" ? r.at : "" };
    }
  }

  setName(name) {
    this.name = [...String(name || "").trim()].slice(0, LIMITS.name).join("");
    this.sendName();
  }

  // ---------------------------------------------------------------- wire
  request(msg, what) {
    const ref = "r" + (this.refN = (this.refN + 1) % 1e6);
    if (!this.send({ ...msg, ref })) return false;
    this.pending[ref] = what;
    return true;
  }

  send(o) {
    const s = this.ws;
    if (!s || s.readyState !== 1) return false;
    try { s.send(JSON.stringify({ v: 1, ...o })); return true; } catch { return false; }
  }

  sendName() {
    // only if the learner typed one; an emptied field clears a name sent before
    if (this.name === this.nameSent || (!this.name && !this.nameSent)) return;
    this.request({ t: "name", name: this.name }, { kind: "name", name: this.name });
  }

  clearTimers() {
    this.d.clearTimeout(this.timers.retry);
    this.d.clearInterval(this.timers.ping);
    this.timers.retry = this.timers.ping = null;
  }

  connect() {
    this.clearTimers();
    const url = socketUrl(this.d.origin, this.room, this.key, this.pid());
    if (!url) return this.set("stopped", { reason: "bad_link" });
    let s;
    try { s = new this.d.WebSocket(url); } catch { return this.onClose(1006); }
    this.ws = s;
    this.admitted = false;
    this.pending = {};
    // the activities may have changed while this page was away: offer nothing until the room says again
    this.activities = {};
    this.declared = null;
    this.set("connecting");
    s.onmessage = (ev) => { if (this.ws === s) this.onMessage(ev.data); };
    s.onopen = () => { if (this.ws === s) this.timers.ping = this.d.setInterval(() => this.send({ t: "ping" }), PING_MS); };
    s.onclose = (ev) => { if (this.ws !== s) return; this.ws = null; this.onClose(ev && typeof ev.code === "number" ? ev.code : 1006); };
    s.onerror = () => {};
  }

  onClose(code) {
    this.clearTimers();
    this.admitted = false;
    this.pending = {};
    this.code = code;
    const p = plan(code, this.attempt, this.d.now(), this.win, this.d.random());
    if (!p.retry) {
      if (!p.manual) this.session.set(this.joinedKey, null);
      return this.set("stopped", { reason: p.reason, manual: p.manual, event: { type: "closed", code } });
    }
    this.attempt++;
    this.retryAt = this.d.now() + p.delayMs;
    this.timers.retry = this.d.setTimeout(() => this.connect(), p.delayMs);
    this.set("retrying", { reason: CODES[code] || "network", event: { type: "closed", code } });
  }

  onMessage(raw) {
    if (typeof raw !== "string" || raw.length > 262144) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object" || m.v !== 1 || typeof m.t !== "string") return;
    const items = (l) => (Array.isArray(l) ? l.filter((x) => x && typeof x.text === "string").slice(0, 50) : []);
    switch (m.t) {
      case "welcome":
        this.attempt = 0;
        if (m.window && Number.isFinite(windowEnd(m.window))) this.win = { from: m.window.from, to: m.window.to };
        this.admitted = m.status === "admitted";
        this.shown = this.admitted ? items(m.shown) : [];
        this.setReplies(m.replies);
        this.set(this.admitted ? "connected" : "waiting", { event: { type: m.status } });
        this.sendName();
        if (this.admitted) this.request({ t: "activities" }, { kind: "activities" });
        return;
      case "admitted":
        this.admitted = true;
        this.shown = items(m.shown);
        this.setReplies(m.replies);
        this.set("connected", { event: { type: "admitted" } });
        this.request({ t: "activities" }, { kind: "activities" });
        return;
      case "shown":
        this.shown = items(m.items);
        return this.emit({ type: "shown" });
      case "reply":
        this.setReplies([m]);
        return this.emit({ type: "reply" });
      case "activities": {
        if (typeof m.ref === "string") delete this.pending[m.ref];
        this.activities = m.activities && typeof m.activities === "object" && !Array.isArray(m.activities) ? m.activities : {};
        this.declared = m.declared === true;
        return this.emit({ type: "activities" });
      }
      case "ack": {
        const p = typeof m.ref === "string" ? this.pending[m.ref] : null;
        if (!p) return;
        delete this.pending[m.ref];
        if (p.kind === "vote") this.votes[p.id] = { choice: p.choice, ok: true };
        if (p.kind === "name") this.nameSent = p.name;
        return this.emit({ type: "ack", kind: p.kind });
      }
      case "error": {
        const p = typeof m.ref === "string" ? this.pending[m.ref] : null;
        if (p) delete this.pending[m.ref];
        if (p && p.kind === "vote") { if (p.prev) this.votes[p.id] = p.prev; else delete this.votes[p.id]; }
        if (p && p.kind === "confused") this.confusedOn = p.prev;
        return this.emit({ type: "error", code: typeof m.code === "string" ? m.code : "", kind: p ? p.kind : null });
      }
      default:
        return;   // pong and anything newer
    }
  }
}
