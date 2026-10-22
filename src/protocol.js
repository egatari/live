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
  BAD_REGION: "bad_region",
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
  ROOM_EXISTS: "room_exists",     // one-way setup: a room with that id already exists
});

export const RE_ROOM = /^r-[a-z2-7]{8}$/;
export const RE_KEY = /^[A-Za-z0-9_-]{22,64}$/;
export const RE_ADMIN = /^[A-Za-z0-9_-]{43,64}$/;
// One-way setup secret (PROTOCOL.md §2.1): 32 random bytes, base64url without padding, canonical
// (the last character carries 4 bits and two zero bits).
export const RE_SETUP = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const RE_PID = /^[A-Za-z0-9_-]{16,43}$/;
export const RE_ACTIVITY = /^[A-Za-z0-9_-]{1,32}$/;
export const RE_ITEM = /^q-[a-z2-7]{10}$/;
export const RE_GROUP = /^g-[a-z2-7]{10}$/;
export const RE_SHA256 = /^[0-9a-f]{64}$/;
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

/** base32 (RFC 4648 alphabet, lowercase, no padding) of whole 5-byte groups. */
function base32(bytes) {
  let s = "";
  for (let i = 0; i + 5 <= bytes.length; i += 5) {
    let v = 0n;
    for (let j = 0; j < 5; j++) v = (v << 8n) | BigInt(bytes[i + j]);
    for (let j = 7; j >= 0; j--) s += B32[Number((v >> BigInt(j * 5)) & 31n)];
  }
  return s;
}
function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function digest(label, setup) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(label + setup)));
}

/**
 * One-way setup (PROTOCOL.md §2.1): the room and the learner key the editor derives from its setup secret.
 * room = "r-" + base32(SHA-256("egatari-live/v1/room:" + setup)[0..5]), key = base64url(SHA-256("egatari-live/v1/key:" + setup)[0..16]).
 * Whoever holds only the lesson file (room and key) cannot create its room: that needs the setup secret.
 */
export async function setupIds(setup) {
  const room = "r-" + base32((await digest("egatari-live/v1/room:", setup)).slice(0, 5));
  const key = base64url((await digest("egatari-live/v1/key:", setup)).slice(0, 16));
  return { room, key };
}

/**
 * A rough check that a setup secret came from a random source: 43 base64url characters drawn at random have about
 * 31 distinct characters; fewer than 16 (or a run of 6 equal characters) does not happen by chance (p < 1e-9).
 */
export function setupLooksRandom(setup) {
  if (typeof setup !== "string" || !RE_SETUP.test(setup)) return false;
  if (new Set(setup).size < 16) return false;
  return !/(.)\1{7}/.test(setup);
}

export const newRoomId = () => "r-" + randomBase32(8);
export const newLearnerKey = () => randomBase64url(16);   // 22 chars, 128 bits
export const newAdminKey = () => randomBase64url(32);     // 43 chars, 256 bits
export const newItemId = () => "q-" + randomBase32(10);
export const newGroupId = () => "g-" + randomBase32(10);

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

/**
 * A circled region: strokes in stage coordinates, the shape of Studio's review notes (contract §12):
 * 1-20 strokes, each 2-500 points [x, y] with 0 <= x <= 1280, 0 <= y <= 720, rounded to 0.1, no two consecutive
 * points equal; 2000 points in all. Players normalise before sending; the server only checks, and refuses
 * anything else with `bad_region` (the connection stays open). Returns the strokes, or throws.
 */
export function checkStrokes(v) {
  const bad = (why) => new ProtocolError(ERR.BAD_REGION, why);
  if (!Array.isArray(v) || v.length < 1 || v.length > L.MAX_REGION_STROKES) throw bad(`1-${L.MAX_REGION_STROKES} strokes`);
  let total = 0;
  const tenth = (x) => Math.abs(Math.round(x * 10) / 10 - x) < 1e-9;
  for (const s of v) {
    if (!Array.isArray(s) || s.length < 2 || s.length > L.MAX_REGION_STROKE_POINTS) throw bad(`each stroke has 2-${L.MAX_REGION_STROKE_POINTS} points`);
    total += s.length;
    if (total > L.MAX_REGION_POINTS) throw bad(`at most ${L.MAX_REGION_POINTS} points in all`);
    let px = null, py = null;
    for (const pt of s) {
      if (!Array.isArray(pt) || pt.length !== 2) throw bad("a point is [x, y]");
      const [x, y] = pt;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) throw bad("coordinates are numbers");
      if (x < 0 || x > L.STAGE_W || y < 0 || y > L.STAGE_H) throw bad("a point is outside the stage");
      if (!tenth(x) || !tenth(y)) throw bad("coordinates are rounded to 0.1");
      if (x === px && y === py) throw bad("two consecutive points are equal");
      px = x; py = y;
    }
  }
  return v.map((s) => s.map(([x, y]) => [x, y]));
}

/** Validate a learner message after parseFrame. Returns a normalised copy. */
export function checkLearnerMessage(m) {
  const base = ["v", "t", "ref"];
  switch (m.t) {
    case "ask": {
      if (!only(m, [...base, "activity", "step", "text", "strokes", "sourceSha256"])) throw new ProtocolError(ERR.BAD_MESSAGE, "unexpected member");
      checkActivityRef(m);
      if (typeof m.text !== "string") throw new ProtocolError(ERR.BAD_MESSAGE, "text must be a string");
      if (m.sourceSha256 !== undefined && !(typeof m.sourceSha256 === "string" && RE_SHA256.test(m.sourceSha256))) {
        throw new ProtocolError(ERR.BAD_MESSAGE, "sourceSha256 must be 64 lowercase hex digits");
      }
      const text = cleanText(m.text);
      if (!text) throw new ProtocolError(ERR.EMPTY_TEXT);
      if ([...text].length > L.MAX_QUESTION_CHARS) throw new ProtocolError(ERR.TEXT_TOO_LONG);
      const out = { t: "ask", ref: m.ref, activity: m.activity, step: m.step, text };
      if (m.strokes !== undefined) {
        // a region is drawn on one step: "*" has no stage to circle on
        if (m.step === "*") throw new ProtocolError(ERR.BAD_REGION, "a region needs the step it was drawn on");
        out.strokes = checkStrokes(m.strokes);
      }
      if (m.sourceSha256 !== undefined) out.sourceSha256 = m.sourceSha256;
      return out;
    }
    case "confused": {
      if (!only(m, [...base, "activity", "step", "on"])) throw new ProtocolError(ERR.BAD_MESSAGE, "unexpected member");
      checkActivityRef(m);
      if (m.on !== undefined && typeof m.on !== "boolean") throw new ProtocolError(ERR.BAD_MESSAGE, "on must be boolean");
      return { t: "confused", ref: m.ref, activity: m.activity, step: m.step, on: m.on !== false };
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
    case "activities": {
      // the join page has no lesson file, so it asks the room for its activities
      if (!only(m, base)) throw new ProtocolError(ERR.BAD_MESSAGE, "unexpected member");
      return { t: "activities", ref: m.ref };
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
    case "reply": {
      // a short reply to one question, or to every question in its group; `public` also shows it to everyone
      need(["item", "text", "public"]);
      if (typeof m.item !== "string" || !RE_ITEM.test(m.item)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad item");
      if (typeof m.text !== "string") throw new ProtocolError(ERR.BAD_MESSAGE, "text must be a string");
      if (m.public !== undefined && typeof m.public !== "boolean") throw new ProtocolError(ERR.BAD_MESSAGE, "public must be boolean");
      const text = cleanText(m.text);
      if (!text) throw new ProtocolError(ERR.EMPTY_TEXT);
      if ([...text].length > L.MAX_REPLY_CHARS) throw new ProtocolError(ERR.TEXT_TOO_LONG);
      return { ...m, text, public: m.public === true };
    }
    case "group": {
      need(["items"]);
      if (!Array.isArray(m.items) || m.items.length < 2 || m.items.length > L.MAX_GROUP_ITEMS) {
        throw new ProtocolError(ERR.BAD_MESSAGE, `items: 2-${L.MAX_GROUP_ITEMS} item ids`);
      }
      for (const id of m.items) if (typeof id !== "string" || !RE_ITEM.test(id)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad item");
      const items = [...new Set(m.items)];
      if (items.length < 2) throw new ProtocolError(ERR.BAD_MESSAGE, "items: 2 different item ids");
      return { ...m, items };
    }
    case "ungroup":
      need(["item"]);
      if (typeof m.item !== "string" || !RE_ITEM.test(m.item)) throw new ProtocolError(ERR.BAD_MESSAGE, "bad item");
      return m;
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
      // label (optional): display text for the step ("Slide 4 'XML', step 1"). Keys stay as they are.
      let label;
      if (act.label !== undefined) {
        if (typeof act.label !== "string") throw new ProtocolError(ERR.BAD_MESSAGE, "label must be a string");
        label = cleanText(act.label).replace(/\s+/g, " ");
        if ([...label].length > L.MAX_LABEL_CHARS) throw new ProtocolError(ERR.TEXT_TOO_LONG, "label too long");
        if (!label) label = undefined;
      }
      const lab = label === undefined ? {} : { label };
      if (act.kind === "qa" || act.kind === "confused") {
        out[step].push({ id: act.id, kind: act.kind, ...lab });
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
        out[step].push(prompt === undefined ? { id: act.id, kind: "poll", choices, ...lab } : { id: act.id, kind: "poll", prompt, choices, ...lab });
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
  if (!only(body, ["v", "window", "graceHours", "requireApproval", "activities", "size", "turnstile", "room", "key", "setup"])) throw new ProtocolError(ERR.BAD_REQUEST, "unexpected member");
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
  // One-way setup (§2.1): room, key and setup come together, and then the activities are required (the room gets exactly them).
  const oneWay = ["room", "key", "setup"].filter((k) => body[k] !== undefined);
  let setup = null;
  if (oneWay.length) {
    if (oneWay.length !== 3) throw new ProtocolError(ERR.BAD_REQUEST, "room, key and setup come together");
    if (typeof body.room !== "string" || !RE_ROOM.test(body.room)) throw new ProtocolError(ERR.BAD_REQUEST, "room must be r- and 8 base32 characters");
    if (typeof body.key !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.key)) throw new ProtocolError(ERR.BAD_REQUEST, "key must be 22 base64url characters");
    if (typeof body.setup !== "string" || !RE_SETUP.test(body.setup)) throw new ProtocolError(ERR.BAD_REQUEST, "setup must be 43 base64url characters (32 random bytes)");
    if (!setupLooksRandom(body.setup)) throw new ProtocolError(ERR.BAD_REQUEST, "setup is not random");
    if (body.activities === undefined) throw new ProtocolError(ERR.BAD_REQUEST, "a one-way setup carries the activities");
    setup = { room: body.room, key: body.key, setup: body.setup };
  }
  const activities = body.activities === undefined ? null : checkActivities(body.activities);
  return { window: { from: w.from, to: w.to }, graceHours, requireApproval: body.requireApproval === true, activities, size, setup };
}
