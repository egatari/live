// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live Worker: routing, room creation, and the teacher page's security headers.
import * as L from "./limits.js";
import {
  CLOSE, ERR, ProtocolError, RE_ROOM, checkCreate, newRoomId, newLearnerKey, newAdminKey,
} from "./protocol.js";
import { rejectSocket } from "./room.js";

export { Room } from "./room.js";

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: API_HEADERS });
const fail = (status, code, message) => json({ v: 1, error: code, ...(message ? { message } : {}) }, status);

/** The strict CSP of the teacher page: own scripts and styles, sockets to this origin only. */
export function teacherCsp(origin) {
  const ws = origin.replace(/^http/, "ws");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${ws}`,
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function pageHeaders(res, origin) {
  const h = new Headers(res.headers);
  h.set("content-security-policy", teacherCsp(origin));
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
  if (!(request.headers.get("content-type") || "").startsWith("application/json")) return fail(415, ERR.BAD_REQUEST, "send application/json");
  const text = await request.text();
  if (text.length > L.MAX_CREATE_BODY_BYTES) return fail(413, ERR.TOO_LARGE);
  let spec;
  try {
    spec = checkCreate(JSON.parse(text), Date.now());
  } catch (e) {
    return fail(400, e instanceof ProtocolError ? e.code : ERR.BAD_REQUEST, e instanceof ProtocolError ? e.message : "body is not JSON");
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const room = newRoomId(), key = newLearnerKey(), adminKey = newAdminKey();
    const res = await stub(env, room).fetch("https://do/do/create", {
      method: "POST", body: JSON.stringify({ ...spec, room, key, adminKey }),
    });
    if (res.status === 409) continue;   // id collision: try another
    const { expiresAt } = await res.json();
    return json({
      v: 1, endpoint: origin, room, key, adminKey, window: spec.window, graceHours: spec.graceHours, expiresAt,
      requireApproval: spec.requireApproval,
      teacherUrl: `${origin}/#room=${room}&admin=${adminKey}`,
    }, 201);
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

    // Teacher page and its static files
    if (request.method === "GET" || request.method === "HEAD") {
      const res = await env.ASSETS.fetch(request);
      return pageHeaders(res, origin);
    }
    return fail(404, ERR.NOT_FOUND);
  },
};
