// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live protocol v1: codes, identifiers and message validation (see PROTOCOL.md).
import * as L from "./limits.js";

// WebSocket close codes (application range 4000-4999). Mnemonic: 4 + an HTTP-like status.
export const CLOSE = Object.freeze({
  BAD_MESSAGE: 4400,       // malformed, oversize, unknown type, wrong version
  UNAUTHORIZED: 4401,      // teacher socket: missing / wrong adminKey, or auth timeout
  BAD_KEY: 4403,           // learner: wrong key for this room
  ROOM_NOT_FOUND: 4404,
  SUPERSEDED: 4409,        // a newer connection with the same pid took over
  ROOM_EXPIRED: 4410,      // window over (or room deleted at the end of the grace period)
  ROOM_CLOSED: 4423,       // the teacher closed the room
  TOO_EARLY: 4425,         // window not started yet
  RATE_LIMITED: 4429,
  ROOM_FULL: 4430,
  KEY_REPLACED: 4440,      // the teacher replaced the learner key
  NOT_APPROVED: 4441,      // the teacher declined this participant
});

export const CLOSE_REASON = Object.freeze(
  Object.fromEntries(Object.entries(CLOSE).map(([k, v]) => [v, k.toLowerCase()]))
);

// Error codes carried in {t:"error", code}
export const ERR = Object.freeze({
  BAD_MESSAGE: "bad_message",
  TOO_LARGE: "too_large",
  UNSUPPORTED_VERSION: "unsupported_version",
  UNKNOWN_TYPE: "unknown_type",
  UNKNOWN_ACTIVITY: "unknown_activity",
  WRONG_KIND: "wrong_kind",
  BAD_CHOICE: "bad_choice",
  TEXT_TOO_LONG: "text_too_long",
  EMPTY_TEXT: "empty_text",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXCEEDED: "quota_exceeded",
  ROOM_LIMIT: "room_limit",
  NOT_ADMITTED: "not_admitted",
  NOT_FOUND: "not_found",
  BAD_REQUEST: "bad_request",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  // room creation
  WINDOW_TOO_LONG: "window_too_long",
  ROOM_TOO_LARGE: "room_too_large",
  TURNSTILE_REQUIRED: "turnstile_required",
  TURNSTILE_FAILED: "turnstile_failed",
  UNAVAILABLE: "unavailable",
});

export const RE_ROOM = /^r-[a-z2-7]{8}$/;
export const RE_KEY = /^[A-Za-z0-9_-]{22,64}$/;
export const RE_ADMIN = /^[A-Za-z0-9_-]{43,64}$/;
export const RE_PID = /^[A-Za-z0-9_-]{16,43}$/;
export const RE_ACTIVITY = /^[A-Za-z0-9_-]{1,32}$/;
export const RE_ITEM = /^q-[a-z2-7]{10}$/;
// A step key is "slideKey:stepKey" (format spec) or "*" for the whole lesson.
export const RE_STEP = /^(\*|[^\u0000-\u001f\u007f:]{1,80}:[^\u0000-\u001f\u007f:]{1,16})$/;
// RFC 3339 date-time with an explicit offset
export const RE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function randomBase32(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of bytes) s += B32[b & 31];
  return s;
}

export function randomBase64url(nBytes) {
  const bytes = crypto.getRandomValues(new Uint8Array(nBytes));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const newRoomId = () => "r-" + randomBase32(8);
export const newLearnerKey = () => randomBase64url(16);   // 22 chars, 128 bits
export const newAdminKey = () => randomBase64url(32);     // 43 chars, 256 bits
export const newItemId = () => "q-" + randomBase32(10);

export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison of two strings of equal length (hex digests)
export function sameDigest(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
// Strip control characters except newline and tab; trim.
export function cleanText(s) {
  return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

function only(obj, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return false;
  return true;
}

class ProtocolError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
export { ProtocolError };

/** Parse a raw frame into a message object with v and t checked. Throws ProtocolError. */
export function parseFrame(raw, maxBytes) {
  if (typeof raw !== "string") {
    throw new ProtocolError(ERR.BAD_MESSAGE, "binary frames are not accepted");
  }
  // JS string length in UTF-16 units; UTF-8 bytes can be up to 3x per unit
  if (raw.length > maxBytes || new TextEncoder().encode(raw).length > maxBytes) {
    throw new ProtocolError(ERR.TOO_LARGE, `message larger than ${maxBytes} bytes`);
  }
  let m;
  try { m = JSON.parse(raw); } catch { throw new ProtocolError(ERR.BAD_MESSAGE, "not JSON"); }
  if (!isObj(m)) throw new ProtocolError(ERR.BAD_MESSAGE, "not an object");
  if (m.v !== L.PROTOCOL_VERSION) throw new ProtocolError(ERR.UNSUPPORTED_VERSION, "v must be 1");
  if (typeof m.t !== "string") throw new ProtocolError(ERR.BAD_MESSAGE, "missing t");
  if (m.ref !== undefined && !(typeof m.ref === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(m.ref))) {
    throw new ProtocolError(ERR.BAD_MESSAGE, "bad ref");
  }
  return m;
}

/** Validate a learner message after parseFrame. Returns a normalised copy. */
export function checkLearnerMessage(m) {
  const base = ["v", "t", "ref"];
  switch (m.t) {
    case "ask": {
      if (!only(m, [...base, "activity", "step", "text"])) throw new ProtocolError(ERR.BAD_MESSAGE, "unexpected member");
      checkActivityRef(m);
      if (typeof m.text !== "string") throw new ProtocolError(ERR.BAD_MESSAGE, "text must be a string");
      const text = cleanText(m.text);
      if (!text) throw new ProtocolError(ERR.EMPTY_TEXT);
      if ([...text].length > L.MAX_QUESTION_CHARS) throw new ProtocolError(ERR.TEXT_TOO_LONG);
      return { t: "ask", ref: m.ref, activity: m.activity, step: m.step, text };
    }
    case "vote": {
      if (!only(m, [...base, "activity", "step", "choice"])) throw new ProtocolError(ERR.BAD_MESSAGE, "unexpected member");
      checkActivityRef(m);
      if (!Number.isInteger(m.choice) || m.choice < 0 || m.choice >= L.MAX_CHOICES) throw new ProtocolError(ERR.BAD_CHOICE);
      return { t: "vote", ref: m.ref, activity: m.activity, step: m.step, choice: m.choice };
    }
    case "name": {
      if (!only(m, [...base, "name"])) throw new ProtocolError(ERR.BAD_MESSAGE, "unexpected member");
      if (typeof m.name !== "string") throw new ProtocolError(ERR.BAD_MESSAGE, "name must be a string");
      const name = cleanText(m.name).replace(/\s+/g, " ");
      if ([...name].length > L.MAX_NAME_CHARS) throw new ProtocolError(ERR.TEXT_TOO_LONG);
      return { t: "name", ref: m.ref, name };
    }
    default:
      throw new ProtocolError(ERR.UNKNOWN_TYPE, `unknown type ${m.t}`);
  }
}

function checkActivityRef(m) {
  if (typeof m.activity !== "string" || !RE_ACTIVITY.test(m.activity)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad activity");
  if (typeof m.step !== "string" || !RE_STEP.test(m.step)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad step");
}

/** Validate a teacher message after parseFrame. */
export function checkTeacherMessage(m) {
  const base = ["v", "t", "ref"];
  const need = (keys) => { if (!only(m, [...base, ...keys])) throw new ProtocolError(ERR.BAD_MESSAGE, "unexpected member"); };
  switch (m.t) {
    case "auth":
      need(["adminKey"]);
      if (typeof m.adminKey !== "string" || !RE_ADMIN.test(m.adminKey)) throw new ProtocolError(ERR.UNAUTHORIZED);
      return m;
    case "state": case "open": case "close": case "rekey": case "admitAll":
      need([]);
      return m;
    case "approval":
      need(["required"]);
      if (typeof m.required !== "boolean") throw new ProtocolError(ERR.BAD_MESSAGE, "required must be boolean");
      return m;
    case "admit": case "deny":
      need(["pid"]);
      if (typeof m.pid !== "string" || !RE_PID.test(m.pid)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad pid");
      return m;
    case "mark": {
      need(["item", "read", "answered", "shown", "hidden"]);
      if (typeof m.item !== "string" || !RE_ITEM.test(m.item)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad item");
      for (const f of ["read", "answered", "shown", "hidden"]) {
        if (m[f] !== undefined && typeof m[f] !== "boolean") throw new ProtocolError(ERR.BAD_MESSAGE, `${f} must be boolean`);
      }
      return m;
    }
    case "activities":
      need(["activities"]);
      return { ...m, activities: checkActivities(m.activities) };
    default:
      throw new ProtocolError(ERR.UNKNOWN_TYPE, `unknown type ${m.t}`);
  }
}

/** Validate `extensions.live.activities` (step key -> list). Returns a clean copy. */
export function checkActivities(a) {
  if (!isObj(a)) throw new ProtocolError(ERR.BAD_MESSAGE, "activities must be an object");
  const out = {};
  const ids = new Set();
  for (const [step, list] of Object.entries(a)) {
    if (!RE_STEP.test(step)) throw new ProtocolError(ERR.BAD_MESSAGE, `bad step key ${step}`);
    if (!Array.isArray(list)) throw new ProtocolError(ERR.BAD_MESSAGE, "activity list must be an array");
    out[step] = [];
    for (const act of list) {
      if (!isObj(act) || typeof act.id !== "string" || !RE_ACTIVITY.test(act.id)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad activity id");
      if (ids.has(act.id)) throw new ProtocolError(ERR.BAD_MESSAGE, `duplicate activity id ${act.id}`);
      ids.add(act.id);
      if (ids.size > L.MAX_ACTIVITIES) throw new ProtocolError(ERR.ROOM_LIMIT, "too many activities");
      if (act.kind === "qa") {
        out[step].push({ id: act.id, kind: "qa" });
      } else if (act.kind === "poll") {
        const prompt = act.prompt === undefined ? undefined : cleanText(act.prompt);
        if (prompt !== undefined && [...prompt].length > L.MAX_PROMPT_CHARS) throw new ProtocolError(ERR.TEXT_TOO_LONG, "prompt too long");
        if (!Array.isArray(act.choices) || act.choices.length < 2 || act.choices.length > L.MAX_CHOICES) {
          throw new ProtocolError(ERR.BAD_MESSAGE, "poll needs 2-12 choices");
        }
        const choices = act.choices.map((c) => {
          if (typeof c !== "string") throw new ProtocolError(ERR.BAD_MESSAGE, "choice must be a string");
          const s = cleanText(c);
          if ([...s].length > L.MAX_CHOICE_CHARS) throw new ProtocolError(ERR.TEXT_TOO_LONG, "choice too long");
          return s;
        });
        out[step].push(prompt === undefined ? { id: act.id, kind: "poll", choices } : { id: act.id, kind: "poll", prompt, choices });
      } else {
        throw new ProtocolError(ERR.BAD_MESSAGE, `unsupported kind ${act.kind}`);
      }
    }
  }
  return out;
}

/** Validate the create-room request body. Returns {window, graceHours, requireApproval, activities}. */
export function checkCreate(body, now) {
  if (!isObj(body)) throw new ProtocolError(ERR.BAD_REQUEST, "body must be a JSON object");
  if (!only(body, ["v", "window", "graceHours", "requireApproval", "activities", "size", "turnstile"])) throw new ProtocolError(ERR.BAD_REQUEST, "unexpected member");
  if (body.v !== undefined && body.v !== L.PROTOCOL_VERSION) throw new ProtocolError(ERR.UNSUPPORTED_VERSION);
  const w = body.window;
  if (!isObj(w) || !only(w, ["from", "to"]) || typeof w.from !== "string" || typeof w.to !== "string"
      || !RE_DATETIME.test(w.from) || !RE_DATETIME.test(w.to)) {
    throw new ProtocolError(ERR.BAD_REQUEST, "window.from and window.to must be RFC 3339 date-times with an offset");
  }
  const from = Date.parse(w.from), to = Date.parse(w.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new ProtocolError(ERR.BAD_REQUEST, "window.to must be after window.from");
  if (to - from > L.MAX_WINDOW_MS) throw new ProtocolError(ERR.WINDOW_TOO_LONG, `a room is open for at most ${L.MAX_WINDOW_MS / 3600000} hours`);
  if (to <= now) throw new ProtocolError(ERR.BAD_REQUEST, "window already over");
  if (from - now > L.MAX_START_AHEAD_MS) throw new ProtocolError(ERR.BAD_REQUEST, "window starts more than 180 days ahead");
  let graceHours = L.DEFAULT_GRACE_HOURS;
  if (body.graceHours !== undefined) {
    if (typeof body.graceHours !== "number" || !Number.isFinite(body.graceHours) || body.graceHours < 0 || body.graceHours > L.MAX_GRACE_HOURS) {
      throw new ProtocolError(ERR.BAD_REQUEST, "graceHours must be between 0 and 168");
    }
    graceHours = body.graceHours;
  }
  if (body.requireApproval !== undefined && typeof body.requireApproval !== "boolean") throw new ProtocolError(ERR.BAD_REQUEST, "requireApproval must be boolean");
  let size = null;
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || body.size < 1) throw new ProtocolError(ERR.BAD_REQUEST, "size must be a positive integer");
    if (body.size > L.MAX_ROOM_SIZE) throw new ProtocolError(ERR.ROOM_TOO_LARGE, `a room holds at most ${L.MAX_ROOM_SIZE} learners`);
    size = body.size;
  }
  const activities = body.activities === undefined ? null : checkActivities(body.activities);
  return { window: { from: w.from, to: w.to }, graceHours, requireApproval: body.requireApproval === true, activities, size };
}
