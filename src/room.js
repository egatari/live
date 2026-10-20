// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live: one Durable Object per room. WebSockets use the Hibernation API.
import { DurableObject } from "cloudflare:workers";
import * as L from "./limits.js";
import {
  CLOSE, CLOSE_REASON, ERR, ProtocolError, parseFrame, checkLearnerMessage, checkTeacherMessage,
  newLearnerKey, newItemId, sha256, sameDigest, RE_PID, RE_KEY,
} from "./protocol.js";

// Errors after which a learner connection is closed with 4400 (protocol violations).
const FATAL = new Set([ERR.BAD_MESSAGE, ERR.TOO_LARGE, ERR.UNSUPPORTED_VERSION, ERR.UNKNOWN_TYPE]);
const HOUR = 3600 * 1000;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

/** Accept a socket only to close it at once with an application close code. */
export function rejectSocket(code, extra) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  if (extra) server.send(JSON.stringify(extra));
  server.close(code, CLOSE_REASON[code] || "closed");
  return new Response(null, { status: 101, webSocket: client });
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.meta = null;
    this.tallies = null;    // activity id -> counts[], rebuilt lazily after waking
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"v":1,"t":"ping"}', '{"v":1,"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => { this.meta = (await ctx.storage.get("meta")) || null; });
  }

  // ------------------------------------------------------------------ helpers
  async saveMeta() { await this.ctx.storage.put("meta", this.meta); }
  graceMs() { return this.meta.graceHours * HOUR; }
  toMs() { return Date.parse(this.meta.window.to); }
  fromMs() { return Date.parse(this.meta.window.from); }
  expiresAt() { return new Date(this.toMs() + this.graceMs()).toISOString(); }
  // Sockets we have started to close stay listed until the close completes; count only open ones.
  learners() { return this.ctx.getWebSockets("learner").filter((ws) => ws.readyState === WebSocket.OPEN); }
  teachers() {
    return this.ctx.getWebSockets("teacher").filter((ws) => ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.authed);
  }
  send(ws, msg) { try { ws.send(JSON.stringify({ v: 1, ...msg })); } catch { /* socket gone */ } }
  toTeachers(msg) { for (const ws of this.teachers()) this.send(ws, msg); }
  closeWs(ws, code) { try { ws.close(code, CLOSE_REASON[code] || "closed"); } catch { /* already closed */ } }

  async person(pid) { return (await this.ctx.storage.get("p:" + pid)) || null; }

  async waitingList() {
    const out = [];
    for (const ws of this.learners()) {
      const a = ws.deserializeAttachment();
      if (a?.status === "waiting") {
        const p = await this.person(a.pid);
        out.push({ pid: a.pid, name: p?.name || "", since: a.since });
      }
    }
    return out;
  }

  async people() {
    const ls = this.learners();
    return { connected: ls.length, waiting: await this.waitingList() };
  }

  async items() {
    const m = await this.ctx.storage.list({ prefix: "q:" });
    return [...m.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  async shownItems() {
    return (await this.items()).filter((q) => q.shown && !q.hidden)
      .map((q) => ({ id: q.id, activity: q.activity, step: q.step, text: q.text }));
  }

  async getTallies() {
    if (this.tallies) return this.tallies;
    const t = {};
    for (const vote of (await this.ctx.storage.list({ prefix: "v:" })).values()) this.addVote(t, vote.activity, vote.choice, 1);
    this.tallies = t;
    return t;
  }

  addVote(t, activity, choice, d) {
    const known = this.findActivity(activity);
    const len = Math.max(known?.choices?.length || 0, choice + 1, t[activity]?.counts.length || 0);
    const cur = t[activity] || { counts: [], total: 0 };
    while (cur.counts.length < len) cur.counts.push(0);
    cur.counts[choice] += d;
    cur.total += d;
    t[activity] = cur;
  }

  findActivity(id) {
    const acts = this.meta?.activities;
    if (!acts) return null;
    for (const [step, list] of Object.entries(acts)) {
      for (const a of list) if (a.id === id) return { ...a, step };
    }
    return null;
  }

  async stateMessage() {
    const m = this.meta;
    return {
      t: "state", room: m.room, key: m.key, window: m.window, graceHours: m.graceHours, expiresAt: this.expiresAt(),
      open: m.open, requireApproval: m.requireApproval, activities: m.activities || this.inferredActivities(),
      people: await this.people(), items: await this.items(), tallies: await this.getTallies(),
    };
  }

  inferredActivities() {
    const out = {};
    for (const [id, s] of Object.entries(this.meta.seen || {})) {
      const step = s.kind === "qa" ? "*" : s.step;
      (out[step] ||= []).push({ id, kind: s.kind });
    }
    return out;
  }

  // Close unauthenticated teacher sockets that did not authenticate in time.
  sweepTeachers() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets("teacher")) {
      const a = ws.deserializeAttachment();
      if (a && !a.authed && now - a.openedAt > L.TEACHER_AUTH_TIMEOUT_MS) this.closeWs(ws, CLOSE.UNAUTHORIZED);
    }
  }

  // ------------------------------------------------------------------ HTTP entry (from the Worker)
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/do/create": return this.create(await request.json());
      case "/do/learner": return this.joinLearner(url);
      case "/do/teacher": return this.joinTeacher();
      case "/do/results": return this.results(request);
      default: return json({ v: 1, error: ERR.NOT_FOUND }, 404);
    }
  }

  async create(spec) {
    if (this.meta) return json({ v: 1, error: "exists" }, 409);
    const adminHash = await sha256(spec.adminKey);
    this.meta = {
      room: spec.room, key: spec.key, keyGen: 1, adminHash, window: spec.window, graceHours: spec.graceHours,
      requireApproval: spec.requireApproval, open: true, activities: spec.activities, seen: {},
      participants: 0, itemCount: 0, createdAt: new Date().toISOString(),
    };
    await this.saveMeta();
    await this.scheduleAlarm();
    return json({ v: 1, ok: true, expiresAt: this.expiresAt() });
  }

  async scheduleAlarm() {
    const now = Date.now(), to = this.toMs() + L.CLOCK_SKEW_MS, end = this.toMs() + this.graceMs();
    await this.ctx.storage.setAlarm(now < to && to < end ? to : Math.max(end, now));
  }

  async alarm() {
    if (!this.meta) { await this.ctx.storage.deleteAll(); return; }
    const now = Date.now();
    if (now >= this.toMs() + this.graceMs()) {
      for (const ws of this.ctx.getWebSockets()) this.closeWs(ws, CLOSE.ROOM_EXPIRED);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.meta = null;
      this.tallies = null;
      return;
    }
    if (now >= this.toMs()) for (const ws of this.learners()) this.closeWs(ws, CLOSE.ROOM_EXPIRED);
    await this.scheduleAlarm();
  }

  async isAdmin(adminKey) {
    if (!this.meta || typeof adminKey !== "string") return false;
    return sameDigest(await sha256(adminKey), this.meta.adminHash);
  }

  async results(request) {
    const auth = request.headers.get("authorization") || "";
    const adminKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!this.meta) return json({ v: 1, error: ERR.NOT_FOUND }, 404);
    if (!(await this.isAdmin(adminKey))) return json({ v: 1, error: ERR.UNAUTHORIZED }, 401);
    const responses = [];
    for (const q of await this.items()) {
      responses.push({ kind: "qa", activity: q.activity, step: q.step, pid: q.pid, ...(q.name ? { name: q.name } : {}),
        at: q.at, id: q.id, text: q.text, read: q.read, answered: q.answered, shown: q.shown, hidden: q.hidden });
    }
    const votes = [...(await this.ctx.storage.list({ prefix: "v:" })).values()];
    for (const v of votes) responses.push({ kind: "poll", activity: v.activity, step: v.step, pid: v.pid, at: v.at, choice: v.choice });
    responses.sort((a, b) => a.at.localeCompare(b.at));
    return json({
      v: 1, room: this.meta.room, window: this.meta.window,
      activities: this.meta.activities || this.inferredActivities(), responses, exportedAt: new Date().toISOString(),
    });
  }

  // ------------------------------------------------------------------ joining
  async joinLearner(url) {
    const key = url.searchParams.get("key") || "", pid = url.searchParams.get("pid") || "";
    const m = this.meta, now = Date.now();
    if (!m) return rejectSocket(CLOSE.ROOM_NOT_FOUND);
    if (now > this.toMs() + L.CLOCK_SKEW_MS) return rejectSocket(CLOSE.ROOM_EXPIRED);
    if (now < this.fromMs() - L.CLOCK_SKEW_MS) return rejectSocket(CLOSE.TOO_EARLY);
    if (!RE_KEY.test(key) || !RE_PID.test(pid) || !sameDigest(await sha256(key), await sha256(m.key))) {
      return rejectSocket(CLOSE.BAD_KEY);
    }
    if (!m.open) return rejectSocket(CLOSE.ROOM_CLOSED);
    let p = await this.person(pid);
    if (p?.status === "denied") return rejectSocket(CLOSE.NOT_APPROVED);
    const previous = this.ctx.getWebSockets("pid:" + pid).filter((ws) => ws.readyState === WebSocket.OPEN);
    if (this.learners().length - previous.length >= L.MAX_LEARNER_CONNECTIONS) return rejectSocket(CLOSE.ROOM_FULL);
    if (!p) {
      if (m.participants >= L.MAX_PARTICIPANTS) return rejectSocket(CLOSE.ROOM_FULL);
      if (m.requireApproval && (await this.waitingList()).length >= L.MAX_WAITING) return rejectSocket(CLOSE.ROOM_FULL);
      p = { pid, status: m.requireApproval ? "waiting" : "admitted", name: "", asked: 0, first: new Date().toISOString() };
      m.participants++;
      await this.ctx.storage.put("p:" + pid, p);
      await this.saveMeta();
    } else if (p.status === "waiting" && !m.requireApproval) {
      p.status = "admitted";
      await this.ctx.storage.put("p:" + pid, p);
    }
    for (const ws of previous) this.closeWs(ws, CLOSE.SUPERSEDED);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["learner", "pid:" + pid]);
    server.serializeAttachment({ role: "learner", pid, status: p.status, keyGen: m.keyGen,
      tokens: L.RATE_BURST, last: now, drops: 0, since: new Date(now).toISOString() });
    this.send(server, {
      t: "welcome", room: m.room, pid, status: p.status, window: m.window,
      shown: p.status === "admitted" ? await this.shownItems() : [], limits: L.publicLimits(),
    });
    this.toTeachers({ t: "people", ...(await this.people()) });
    return new Response(null, { status: 101, webSocket: client });
  }

  async joinTeacher() {
    if (!this.meta) return rejectSocket(CLOSE.ROOM_NOT_FOUND);
    this.sweepTeachers();
    if (this.ctx.getWebSockets("teacher").length >= L.MAX_TEACHER_CONNECTIONS) return rejectSocket(CLOSE.ROOM_FULL);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["teacher"]);
    server.serializeAttachment({ role: "teacher", authed: false, openedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------ messages
  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    if (!a) return this.closeWs(ws, CLOSE.BAD_MESSAGE);
    if (!this.meta) return this.closeWs(ws, CLOSE.ROOM_EXPIRED);
    this.sweepTeachers();
    if (a.role === "learner") return this.onLearner(ws, a, raw);
    return this.onTeacher(ws, a, raw);
  }

  async onLearner(ws, a, raw) {
    const now = Date.now();
    if (a.keyGen !== this.meta.keyGen) return this.closeWs(ws, CLOSE.KEY_REPLACED);
    if (!this.meta.open) return this.closeWs(ws, CLOSE.ROOM_CLOSED);
    if (now > this.toMs() + L.CLOCK_SKEW_MS) return this.closeWs(ws, CLOSE.ROOM_EXPIRED);
    // token bucket
    a.tokens = Math.min(L.RATE_BURST, a.tokens + (now - a.last) / L.RATE_REFILL_MS);
    a.last = now;
    if (a.tokens < 1) {
      a.drops++;
      ws.serializeAttachment(a);
      if (a.drops >= L.RATE_MAX_DROPS) return this.closeWs(ws, CLOSE.RATE_LIMITED);
      return this.send(ws, { t: "error", code: ERR.RATE_LIMITED });
    }
    a.tokens -= 1;
    ws.serializeAttachment(a);

    let m;
    try {
      m = checkLearnerMessage(parseFrame(raw, L.MAX_LEARNER_MESSAGE_BYTES));
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : ERR.BAD_MESSAGE;
      this.send(ws, { t: "error", code, ...(e.ref ? { ref: e.ref } : {}) });
      if (FATAL.has(code)) this.closeWs(ws, CLOSE.BAD_MESSAGE);
      return;
    }
    const reply = (msg) => this.send(ws, { ...msg, ...(m.ref ? { ref: m.ref } : {}) });
    const fail = (code) => reply({ t: "error", code });
    const p = await this.person(a.pid);
    if (!p) return this.closeWs(ws, CLOSE.NOT_APPROVED);

    if (m.t === "name") {
      p.name = m.name;
      await this.ctx.storage.put("p:" + a.pid, p);
      reply({ t: "ack" });
      if (a.status === "waiting") this.toTeachers({ t: "people", ...(await this.people()) });
      return;
    }
    if (a.status !== "admitted") return fail(ERR.NOT_ADMITTED);

    const kind = m.t === "ask" ? "qa" : "poll";
    const known = this.findActivity(m.activity);
    if (this.meta.activities) {
      if (!known) return fail(ERR.UNKNOWN_ACTIVITY);
      if (known.kind !== kind) return fail(ERR.WRONG_KIND);
      if (known.step !== "*" && known.step !== m.step) return fail(ERR.UNKNOWN_ACTIVITY);
      if (kind === "poll" && m.choice >= known.choices.length) return fail(ERR.BAD_CHOICE);
    } else {
      const seen = this.meta.seen;
      if (seen[m.activity] && seen[m.activity].kind !== kind) return fail(ERR.WRONG_KIND);
      if (!seen[m.activity]) {
        if (Object.keys(seen).length >= L.MAX_ACTIVITIES) return fail(ERR.ROOM_LIMIT);
        seen[m.activity] = { kind, step: m.step };
        await this.saveMeta();
      }
    }

    const at = new Date(now).toISOString();
    if (m.t === "ask") {
      if (p.asked >= L.MAX_QUESTIONS_PER_PARTICIPANT) return fail(ERR.QUOTA_EXCEEDED);
      if (this.meta.itemCount >= L.MAX_ITEMS) return fail(ERR.ROOM_LIMIT);
      const item = { id: newItemId(), activity: m.activity, step: m.step, text: m.text, pid: a.pid, name: p.name || "",
        at, read: false, answered: false, shown: false, hidden: false };
      p.asked++;
      this.meta.itemCount++;
      await this.ctx.storage.put({ ["q:" + item.id]: item, ["p:" + a.pid]: p, meta: this.meta });
      reply({ t: "ack", item: item.id });
      this.toTeachers({ t: "item", item });
      return;
    }
    // vote: one per participant per poll; the last one counts
    const vkey = "v:" + m.activity + ":" + a.pid;
    const tallies = await this.getTallies();
    const prev = await this.ctx.storage.get(vkey);
    if (prev) this.addVote(tallies, prev.activity, prev.choice, -1);
    await this.ctx.storage.put(vkey, { activity: m.activity, step: m.step, pid: a.pid, choice: m.choice, at });
    this.addVote(tallies, m.activity, m.choice, 1);
    reply({ t: "ack" });
    this.toTeachers({ t: "tally", activity: m.activity, ...tallies[m.activity] });
  }

  async onTeacher(ws, a, raw) {
    let m;
    try {
      m = checkTeacherMessage(parseFrame(raw, L.MAX_TEACHER_MESSAGE_BYTES));
    } catch (e) {
      if (!a.authed) return this.closeWs(ws, CLOSE.UNAUTHORIZED);
      const code = e instanceof ProtocolError ? e.code : ERR.BAD_MESSAGE;
      return this.send(ws, { t: "error", code, message: e.message });
    }
    const reply = (msg) => this.send(ws, { ...msg, ...(m.ref ? { ref: m.ref } : {}) });
    if (!a.authed) {
      if (m.t !== "auth" || !(await this.isAdmin(m.adminKey))) return this.closeWs(ws, CLOSE.UNAUTHORIZED);
      a.authed = true;
      ws.serializeAttachment(a);
      return reply(await this.stateMessage());
    }
    const meta = this.meta;
    switch (m.t) {
      case "auth": case "state":
        return reply(await this.stateMessage());
      case "open": case "close":
        meta.open = m.t === "open";
        await this.saveMeta();
        if (!meta.open) for (const l of this.learners()) this.closeWs(l, CLOSE.ROOM_CLOSED);
        reply({ t: "ack" });
        return this.toTeachers(await this.stateMessage());
      case "approval":
        meta.requireApproval = m.required;
        await this.saveMeta();
        if (!m.required) await this.admit(null);
        reply({ t: "ack" });
        return this.toTeachers(await this.stateMessage());
      case "rekey": {
        meta.key = newLearnerKey();
        meta.keyGen++;
        await this.saveMeta();
        for (const l of this.learners()) this.closeWs(l, CLOSE.KEY_REPLACED);
        reply({ t: "ack" });
        this.toTeachers({ t: "rekeyed", room: meta.room, key: meta.key });
        return this.toTeachers({ t: "people", ...(await this.people()) });
      }
      case "admit": case "admitAll":
        await this.admit(m.t === "admit" ? m.pid : null);
        reply({ t: "ack" });
        return this.toTeachers({ t: "people", ...(await this.people()) });
      case "deny": {
        const p = (await this.person(m.pid));
        if (!p) return reply({ t: "error", code: ERR.NOT_FOUND });
        p.status = "denied";
        await this.ctx.storage.put("p:" + m.pid, p);
        for (const l of this.ctx.getWebSockets("pid:" + m.pid)) this.closeWs(l, CLOSE.NOT_APPROVED);
        reply({ t: "ack" });
        return this.toTeachers({ t: "people", ...(await this.people()) });
      }
      case "mark": {
        const item = await this.ctx.storage.get("q:" + m.item);
        if (!item) return reply({ t: "error", code: ERR.NOT_FOUND });
        const wasShown = item.shown && !item.hidden;
        for (const f of ["read", "answered", "shown", "hidden"]) if (m[f] !== undefined) item[f] = m[f];
        if (m.hidden === true) item.shown = false;
        if (m.shown === true) item.hidden = false;
        const nowShown = item.shown && !item.hidden;
        if (nowShown && !wasShown && (await this.shownItems()).length >= L.MAX_SHOWN) return reply({ t: "error", code: ERR.ROOM_LIMIT });
        await this.ctx.storage.put("q:" + item.id, item);
        reply({ t: "ack" });
        this.toTeachers({ t: "item", item });
        if (wasShown !== nowShown) {
          const shown = await this.shownItems();
          for (const l of this.learners()) if (l.deserializeAttachment()?.status === "admitted") this.send(l, { t: "shown", items: shown });
        }
        return;
      }
      case "activities":
        meta.activities = m.activities;
        await this.saveMeta();
        this.tallies = null;
        reply({ t: "ack" });
        return this.toTeachers(await this.stateMessage());
    }
  }

  /** Admit one waiting participant (pid) or all of them (null). */
  async admit(pid) {
    const shown = await this.shownItems();
    const pids = new Set();
    if (pid) pids.add(pid);
    else for (const ws of this.learners()) if (ws.deserializeAttachment()?.status === "waiting") pids.add(ws.deserializeAttachment().pid);
    for (const id of pids) {
      const p = await this.person(id);
      if (!p || p.status === "admitted") continue;
      p.status = "admitted";
      await this.ctx.storage.put("p:" + id, p);
      for (const ws of this.ctx.getWebSockets("pid:" + id)) {
        const a = ws.deserializeAttachment();
        a.status = "admitted";
        ws.serializeAttachment(a);
        this.send(ws, { t: "admitted", shown });
      }
    }
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment();
    try { ws.close(1000, "bye"); } catch { /* already closed */ }
    if (a?.role === "learner" && this.meta) this.toTeachers({ t: "people", ...(await this.people()) });
  }

  async webSocketError(ws) { await this.webSocketClose(ws, 1011); }
}
