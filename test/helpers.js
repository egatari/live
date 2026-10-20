// SPDX-License-Identifier: AGPL-3.0-only
import { SELF } from "cloudflare:test";
import schema from "../protocol/schema.json";

export const ORIGIN = "https://live.test";

// ------------------------------------------------------------------ a small JSON Schema checker
// Covers the subset protocol/schema.json uses (no eval, so it runs inside workerd).
export function validate(value, def, path = "$") {
  const errs = [];
  check(value, typeof def === "string" ? { $ref: "#/$defs/" + def } : def, path, errs);
  return errs;
}
function resolve(ref) {
  const name = ref.replace("#/$defs/", "");
  const d = schema.$defs[name];
  if (!d) throw new Error("unknown $ref " + ref);
  return d;
}
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}
function check(v, s, p, errs) {
  if (s.$ref) return check(v, resolve(s.$ref), p, errs);
  if (s.oneOf) {
    const ok = s.oneOf.filter((sub) => { const e = []; check(v, sub, p, e); return e.length === 0; });
    if (ok.length !== 1) errs.push(`${p}: matches ${ok.length} of oneOf`);
    return;
  }
  if ("const" in s && v !== s.const) errs.push(`${p}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${p}: not in enum`);
  if (s.type) {
    const t = typeOf(v);
    if (!(t === s.type || (s.type === "number" && t === "integer"))) { errs.push(`${p}: expected ${s.type}, got ${t}`); return; }
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && [...v].length < s.minLength) errs.push(`${p}: too short`);
    if (s.maxLength !== undefined && [...v].length > s.maxLength) errs.push(`${p}: too long`);
    if (s.pattern && !new RegExp(s.pattern, "u").test(v)) errs.push(`${p}: does not match ${s.pattern}`);
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) errs.push(`${p}: < minimum`);
    if (s.maximum !== undefined && v > s.maximum) errs.push(`${p}: > maximum`);
  }
  if (Array.isArray(v)) {
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${p}: too many items`);
    if (s.items) v.forEach((x, i) => check(x, s.items, `${p}[${i}]`, errs));
  }
  if (typeOf(v) === "object") {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${p}: missing ${r}`);
    for (const [k, x] of Object.entries(v)) {
      if (s.propertyNames) check(k, s.propertyNames, `${p}{${k}}`, errs);
      if (s.properties && k in s.properties) check(x, s.properties[k], `${p}.${k}`, errs);
      else if (s.additionalProperties === false) errs.push(`${p}: unexpected ${k}`);
      else if (typeof s.additionalProperties === "object") check(x, s.additionalProperties, `${p}.${k}`, errs);
    }
  }
}

// ------------------------------------------------------------------ HTTP and sockets
export function windowAround(now = Date.now(), beforeMs = 60_000, afterMs = 3600_000) {
  return { from: new Date(now - beforeMs).toISOString(), to: new Date(now + afterMs).toISOString() };
}

export async function createRoom(body = {}) {
  const res = await SELF.fetch(ORIGIN + "/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ v: 1, window: windowAround(), ...body }),
  });
  const json = await res.json();
  if (res.status !== 201) throw new Error("create failed: " + JSON.stringify(json));
  return json;
}

let pidCounter = 0;
export const newPid = () => ("pid" + String(++pidCounter).padStart(4, "0") + "xxxxxxxxxxxxxxxx").slice(0, 20);

/** Open a socket through the Worker. Returns a client with message and close tracking. */
export async function openSocket(path, headers = {}) {
  const res = await SELF.fetch(ORIGIN + path, { headers: { upgrade: "websocket", ...headers } });
  if (!res.webSocket) throw new Error(`no websocket (status ${res.status})`);
  const ws = res.webSocket;
  const c = { ws, msgs: [], closed: null, listeners: new Set() };
  const notify = () => { for (const f of [...c.listeners]) f(); };
  ws.addEventListener("message", (e) => { c.msgs.push(JSON.parse(e.data)); notify(); });
  ws.addEventListener("close", (e) => { c.closed = { code: e.code, reason: e.reason }; notify(); });
  ws.accept();
  c.send = (m) => ws.send(typeof m === "string" ? m : JSON.stringify(m));
  /** Wait for (and consume) the first message with type t, optionally matching pred. */
  c.next = (t, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
    const tryNow = () => {
      const i = c.msgs.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) { c.listeners.delete(tryNow); clearTimeout(timer); resolve(c.msgs.splice(i, 1)[0]); return true; }
      if (c.closed) { c.listeners.delete(tryNow); clearTimeout(timer); reject(new Error(`closed ${c.closed.code} while waiting for ${t}`)); return true; }
      return false;
    };
    const timer = setTimeout(() => { c.listeners.delete(tryNow); reject(new Error(`timeout waiting for ${t}; got ${JSON.stringify(c.msgs)}`)); }, ms);
    if (!tryNow()) c.listeners.add(tryNow);
  });
  c.closedWith = (ms = 3000) => new Promise((resolve, reject) => {
    const tryNow = () => { if (c.closed) { c.listeners.delete(tryNow); clearTimeout(timer); resolve(c.closed.code); return true; } return false; };
    const timer = setTimeout(() => { c.listeners.delete(tryNow); reject(new Error("socket not closed")); }, ms);
    if (!tryNow()) c.listeners.add(tryNow);
  });
  c.close = () => { try { ws.close(1000, "done"); } catch { /* closed */ } };
  return c;
}

export const learnerPath = (room, key, pid) =>
  `/ws?room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}&pid=${encodeURIComponent(pid)}`;

export async function joinLearner(r, pid = newPid(), headers = { origin: "null" }) {
  const c = await openSocket(learnerPath(r.room, r.key, pid), headers);
  c.pid = pid;
  return c;
}

export async function joinTeacher(r) {
  const c = await openSocket(`/ws/teacher?room=${r.room}`, { origin: ORIGIN });
  c.send({ v: 1, t: "auth", adminKey: r.adminKey });
  c.state = await c.next("state");
  return c;
}
