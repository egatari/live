// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live create page: the DOM-free core of the one-way setup (PROTOCOL.md §2.1).
// The editor (Egatari Studio) makes no network request: it chooses the room and the learner key itself, derived from a
// random setup secret, and gives the host one string. The host pastes it here once; this page turns it into a create request.

export const SETUP_PREFIX = "egatari-live-setup-v1:";
const RE_B64URL = /^[A-Za-z0-9_-]+$/;
const RE_ROOM = /^r-[a-z2-7]{8}$/;
const RE_KEY = /^[A-Za-z0-9_-]{22}$/;
const RE_SETUP = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const RE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_STRING_CHARS = 48000;   // the create body is at most 32768 bytes; base64 adds a third
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

class SetupError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}
export { SetupError };

function fromBase64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Read a setup string. Whitespace and line breaks (added by mail or chat) are ignored.
 * Returns the payload {v, endpoint, room, key, setup, window, activities}; throws SetupError with code
 * "empty", "prefix" (not a setup string; e.g. the host pasted a join link or JSON), "decode" or "shape".
 * It checks shapes only; the server checks the rest (the window, the activities, that room and key belong to setup).
 */
export function parseSetupString(text) {
  const s = String(text || "").replace(/\s+/g, "");
  if (!s) throw new SetupError("empty");
  if (s.length > MAX_STRING_CHARS) throw new SetupError("decode");
  const at = s.indexOf(SETUP_PREFIX);
  if (at < 0) throw new SetupError("prefix");
  const body = s.slice(at + SETUP_PREFIX.length);
  if (!RE_B64URL.test(body)) throw new SetupError("decode");
  let p;
  try { p = JSON.parse(fromBase64url(body)); } catch { throw new SetupError("decode"); }
  if (!isObj(p) || p.v !== 1) throw new SetupError("shape", "v");
  for (const k of Object.keys(p)) if (!["v", "endpoint", "room", "key", "setup", "window", "activities"].includes(k)) throw new SetupError("shape", k);
  if (typeof p.endpoint !== "string" || !/^https?:\/\/[^/]+$/.test(p.endpoint)) throw new SetupError("shape", "endpoint");
  if (typeof p.room !== "string" || !RE_ROOM.test(p.room)) throw new SetupError("shape", "room");
  if (typeof p.key !== "string" || !RE_KEY.test(p.key)) throw new SetupError("shape", "key");
  if (typeof p.setup !== "string" || !RE_SETUP.test(p.setup)) throw new SetupError("shape", "setup");
  const w = p.window;
  if (!isObj(w) || typeof w.from !== "string" || typeof w.to !== "string" || !RE_DATETIME.test(w.from) || !RE_DATETIME.test(w.to)) throw new SetupError("shape", "window");
  if (!isObj(p.activities)) throw new SetupError("shape", "activities");
  return p;
}

/** The create request for a parsed setup string. */
export function setupRequest(p, { turnstile, requireApproval = false, graceHours } = {}) {
  return {
    v: 1, window: { from: p.window.from, to: p.window.to }, activities: p.activities,
    room: p.room, key: p.key, setup: p.setup, requireApproval: requireApproval === true,
    ...(graceHours !== undefined ? { graceHours } : {}), turnstile,
  };
}

/** What the string sets up, counted for the preview: questions, "I don't follow", polls. */
export function setupSummary(p) {
  let qa = false, confused = false, polls = 0;
  for (const list of Object.values(p.activities || {})) {
    for (const a of Array.isArray(list) ? list : []) {
      if (!isObj(a)) continue;
      if (a.kind === "qa") qa = true;
      else if (a.kind === "confused") confused = true;
      else if (a.kind === "poll") polls++;
    }
  }
  return { qa, confused, polls };
}
