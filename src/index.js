// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live Worker: routing, room creation, and the teacher page's security headers.
import * as L from "./limits.js";
import {
  CLOSE, ERR, ProtocolError, RE_ROOM, checkCreate, newRoomId, newLearnerKey, newAdminKey, setupIds, sameDigest,
} from "./protocol.js";
import { rejectSocket } from "./room.js";
import { verifyTurnstile } from "./turnstile.js";

export { Room } from "./room.js";

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: API_HEADERS });
const fail = (status, code, message) => json({ v: 1, error: code, ...(message ? { message } : {}) }, status);

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * CSP of the service's pages. The room page (`/room`, which holds the teacher key in its fragment) and the
 * learner join page (`/join`, which holds the learner key in its fragment) allow only their own scripts and
 * sockets to this origin. The create page (`/`) additionally allows the Turnstile widget, as Cloudflare
 * documents: script-src and frame-src for challenges.cloudflare.com.
 */
export function teacherCsp(origin, page = "room") {
  const ws = origin.replace(/^http/, "ws");
  const create = page === "create";
  return [
    "default-src 'none'",
    create ? `script-src 'self' ${TURNSTILE_ORIGIN}` : "script-src 'self'",
    "style-src 'self'",
    create ? "connect-src 'self'" : `connect-src 'self' ${ws}`,
    ...(create ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// "create" only for the create page; every other page and file (/room, /join, scripts, styles) gets the strict policy.
const pageOf = (path) => (path === "/" || path === "/index.html" ? "create" : path === "/join" || path === "/join.html" ? "join" : "room");

function pageHeaders(res, origin, page) {
  const h = new Headers(res.headers);
  h.set("content-security-policy", teacherCsp(origin, page));
  h.set("referrer-policy", "no-referrer");
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("cross-origin-resource-policy", "same-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  h.set("cache-control", "no-cache");
  return new Response(res.body, { status: res.status, headers: h });
}

const stub = (env, room) => env.ROOMS.get(env.ROOMS.idFromName(room));

async function createRoom(request, env, origin) {
  // Only the teacher page (same origin) or a non-browser client (no Origin) may create rooms.
  const o = request.headers.get("origin");
  if (o !== null && o !== origin) return fail(403, ERR.FORBIDDEN, "cross-origin room creation is not allowed");
  // Per-sender rate limit (Workers Rate Limiting binding, keyed by the client IP; not stored anywhere).
  if (!env.CREATE_LIMITER) return fail(503, ERR.UNAVAILABLE, "rate limiter not configured");
  const ip = request.headers.get("cf-connecting-ip") || "";
  const { success } = await env.CREATE_LIMITER.limit({ key: "create:" + (ip || "unknown") });
  if (!success) return fail(429, ERR.RATE_LIMITED, "too many rooms created; try again in a minute");
  if (!(request.headers.get("content-type") || "").startsWith("application/json")) return fail(415, ERR.BAD_REQUEST, "send application/json");
  const text = await request.text();
  if (text.length > L.MAX_CREATE_BODY_BYTES) return fail(413, ERR.TOO_LARGE);
  let spec, token;
  try {
    const body = JSON.parse(text);
    spec = checkCreate(body, Date.now());
    token = body.turnstile;
  } catch (e) {
    return fail(400, e instanceof ProtocolError ? e.code : ERR.BAD_REQUEST, e instanceof ProtocolError ? e.message : "body is not JSON");
  }
  // One-way setup (PROTOCOL.md §2.1): the room and key must be the ones derived from the setup secret, so that a copy of
  // the lesson file (which carries room and key, never the secret) cannot be used to create, and so control, its room.
  if (spec.setup) {
    const ids = await setupIds(spec.setup.setup);
    const roomOk = sameDigest(ids.room, spec.setup.room), keyOk = sameDigest(ids.key, spec.setup.key);
    if (!(roomOk & keyOk)) return fail(400, ERR.BAD_REQUEST, "room and key do not belong to this setup");
  }
  // Turnstile, verified last so that a malformed request does not spend the learner's token
  if (typeof token !== "string" || !token || token.length > L.MAX_TURNSTILE_TOKEN_CHARS) {
    return fail(400, ERR.TURNSTILE_REQUIRED, "a Turnstile token is required");
  }
  const v = await verifyTurnstile(env, token, ip, { expectedHostname: new URL(origin).hostname });
  if (!v.ok) return fail(v.status, v.status === 503 ? ERR.UNAVAILABLE : ERR.TURNSTILE_FAILED, "Turnstile: " + v.reason);
  const { setup, ...roomSpec } = spec;
  const created = (room, key, adminKey, expiresAt) => json({
    v: 1, endpoint: origin, room, key, adminKey, window: spec.window, graceHours: spec.graceHours, expiresAt,
    requireApproval: spec.requireApproval,
    teacherUrl: `${origin}/room#room=${room}&admin=${adminKey}`,
  }, 201);
  if (setup) {
    // Exactly this room and key; never another id, and never an existing room (no way to take one over).
    const adminKey = newAdminKey();
    const res = await stub(env, setup.room).fetch("https://do/do/create", {
      method: "POST", body: JSON.stringify({ ...roomSpec, room: setup.room, key: setup.key, adminKey }),
    });
    if (res.status === 409) return fail(409, ERR.ROOM_EXISTS, "this Live already exists; make a new one in the editor");
    const { expiresAt } = await res.json();
    return created(setup.room, setup.key, adminKey, expiresAt);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const room = newRoomId(), key = newLearnerKey(), adminKey = newAdminKey();
    const res = await stub(env, room).fetch("https://do/do/create", {
      method: "POST", body: JSON.stringify({ ...roomSpec, room, key, adminKey }),
    });
    if (res.status === 409) continue;   // id collision: try another
    const { expiresAt } = await res.json();
    return created(room, key, adminKey, expiresAt);
  }
  return fail(503, ERR.ROOM_LIMIT, "could not allocate a room id");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.PUBLIC_ORIGIN || url.origin;
    const path = url.pathname;

    // Learner socket. Any Origin is accepted (including "null" from file://): the key is the capability.
    if (path === "/ws") {
      if (request.headers.get("upgrade") !== "websocket") return fail(426, ERR.BAD_REQUEST, "WebSocket upgrade required");
      const room = url.searchParams.get("room") || "";
      if (!RE_ROOM.test(room)) return rejectSocket(CLOSE.ROOM_NOT_FOUND);
      return stub(env, room).fetch(new Request("https://do/do/learner" + url.search, request));
    }

    // Teacher socket: the first message must be {v:1, t:"auth", adminKey}. Browsers must come from this origin.
    if (path === "/ws/teacher") {
      if (request.headers.get("upgrade") !== "websocket") return fail(426, ERR.BAD_REQUEST, "WebSocket upgrade required");
      const o = request.headers.get("origin");
      if (o !== null && o !== origin) return fail(403, ERR.FORBIDDEN, "teacher socket only from the service origin");
      const room = url.searchParams.get("room") || "";
      if (!RE_ROOM.test(room)) return rejectSocket(CLOSE.ROOM_NOT_FOUND);
      return stub(env, room).fetch(new Request("https://do/do/teacher", request));
    }

    if (path === "/api/rooms") {
      if (request.method !== "POST") return fail(405, ERR.BAD_REQUEST, "use POST");
      return createRoom(request, env, origin);
    }

    const m = path.match(/^\/api\/rooms\/([^/]+)\/results$/);
    if (m) {
      if (request.method !== "GET") return fail(405, ERR.BAD_REQUEST, "use GET");
      if (!(request.headers.get("authorization") || "").startsWith("Bearer ")) return fail(401, ERR.UNAUTHORIZED, "Authorization: Bearer <adminKey> required");
      if (!RE_ROOM.test(m[1])) return fail(404, ERR.NOT_FOUND);
      const res = await stub(env, m[1]).fetch("https://do/do/results", { headers: { authorization: request.headers.get("authorization") } });
      return new Response(res.body, { status: res.status, headers: API_HEADERS });
    }

    if (path === "/api/health") return json({ v: 1, ok: true, service: "egatari-live" });

    // Teacher pages, the learner join page, and their static files
    if (request.method === "GET" || request.method === "HEAD") {
      const page = pageOf(path);
      let res = await env.ASSETS.fetch(request);
      if (page === "create" && (res.headers.get("content-type") || "").startsWith("text/html")) {
        // The public site key reaches the page as a data attribute (no inline script under the CSP).
        const sitekey = env.TURNSTILE_SITEKEY || "";
        res = new HTMLRewriter().on("#turnstile", { element(e) { e.setAttribute("data-sitekey", sitekey); } }).transform(res);
      }
      return pageHeaders(res, origin, page);
    }
    return fail(404, ERR.NOT_FOUND);
  },
};
