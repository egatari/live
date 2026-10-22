// SPDX-License-Identifier: AGPL-3.0-only
// One-way setup (PROTOCOL.md §2.1): the editor derives room and key from a random setup secret and gives the host one
// string; the host pastes it on the create page; the service creates exactly that room, or refuses.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as L from "../src/limits.js";
import { randomBase64url, setupIds, setupLooksRandom } from "../src/protocol.js";
import worker from "../src/index.js";
import { parseSetupString, setupRequest, setupSummary, SETUP_PREFIX } from "../public/setup-core.js";
import payloadFixture from "../protocol/fixtures/setup/payload.json";
import requestFixture from "../protocol/fixtures/http/create-request-setup.json";
import { ORIGIN, DUMMY_TOKEN, validate, windowAround, joinLearner, joinTeacher } from "./helpers.js";

const ok = (msg, def) => expect(validate(msg, def), JSON.stringify(msg)).toEqual([]);
const ACTS = { "*": [{ id: "qa", kind: "qa" }, { id: "confused", kind: "confused" }], "s-a:1": [{ id: "p1", kind: "poll", prompt: "Q?", choices: ["a", "b"], label: "Slide 1 'A', step 2" }] };
let ip = 0;
const nextIp = () => "2001:db8:5e7::" + (++ip).toString(16);

async function newSetup() {
  const setup = randomBase64url(32);
  return { setup, ...(await setupIds(setup)) };
}
function post(body, { headers = {}, envOverride } = {}) {
  const req = new Request(ORIGIN + "/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
  return envOverride ? worker.fetch(req, { ...env, ...envOverride }) : SELF.fetch(req);
}
const body = (s, extra = {}) => ({ v: 1, window: windowAround(), activities: ACTS, room: s.room, key: s.key, setup: s.setup, turnstile: DUMMY_TOKEN, ...extra });
async function status(res) { const j = await res.json(); return [res.status, j.error || null, j]; }
// The setup string as the editor writes it (Studio's kit/core/live.mjs does the same).
function encode(p) {
  const bytes = new TextEncoder().encode(JSON.stringify(p));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return SETUP_PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("one-way setup: derivation and the setup string", () => {
  it("the fixture is a test vector: its room and key are derived from its setup", async () => {
    ok(payloadFixture, "setupPayload");
    ok(requestFixture, "createRequest");
    expect(await setupIds(payloadFixture.setup)).toEqual({ room: payloadFixture.room, key: payloadFixture.key });
    expect(requestFixture).toMatchObject({ room: payloadFixture.room, key: payloadFixture.key, setup: payloadFixture.setup });
  });

  it("derived ids have the protocol's shapes and differ for every setup", async () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const s = await newSetup();
      expect(s.room).toMatch(/^r-[a-z2-7]{8}$/);
      expect(s.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(setupLooksRandom(s.setup)).toBe(true);
      seen.add(s.room); seen.add(s.key);
    }
    expect(seen.size).toBe(100);
  });

  it("the setup string round-trips (whitespace from mail or chat is ignored) and is checked for shape", () => {
    const s = encode(payloadFixture);
    expect(parseSetupString(s)).toEqual(payloadFixture);
    expect(parseSetupString("コピー：\n" + s.slice(0, 40) + "\n " + s.slice(40) + "\n")).toEqual(payloadFixture);
    expect(setupSummary(payloadFixture)).toEqual({ qa: true, confused: true, polls: 1 });
    const code = (t) => { try { parseSetupString(t); return null; } catch (e) { return e.code; } };
    expect(code("")).toBe("empty");
    expect(code(JSON.stringify(payloadFixture))).toBe("prefix");
    expect(code(`${ORIGIN}/join#room=r-aaaaaaaa&key=${"A".repeat(22)}`)).toBe("prefix");
    expect(code(s.slice(0, s.length - 30))).toBe("decode");
    expect(code(SETUP_PREFIX + "%%%")).toBe("decode");
    expect(code(encode({ ...payloadFixture, adminKey: "x".repeat(43) }))).toBe("shape");
    expect(code(encode({ ...payloadFixture, setup: undefined }))).toBe("shape");
    expect(code(encode({ ...payloadFixture, room: "r-AAAAAAAA" }))).toBe("shape");
    // the request the create page sends validates against the schema
    const req = setupRequest(payloadFixture, { turnstile: DUMMY_TOKEN, requireApproval: true, graceHours: 12 });
    ok(req, "createRequest");
    expect(req).toMatchObject({ room: payloadFixture.room, key: payloadFixture.key, setup: payloadFixture.setup, requireApproval: true, graceHours: 12 });
  });
});

describe("one-way setup: creating the room", () => {
  it("creates exactly that room, key and activities; learners join with the key from the file", async () => {
    const s = await newSetup();
    const [code, , r] = await status(await post(body(s)));
    expect(code).toBe(201);
    ok(r, "createResponse");
    expect(r.room).toBe(s.room);
    expect(r.key).toBe(s.key);
    expect(r.adminKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.teacherUrl).toBe(`${ORIGIN}/room#room=${s.room}&admin=${r.adminKey}`);
    const t = await joinTeacher(r);
    expect(t.state.activities).toEqual(ACTS);
    expect(t.state.key).toBe(s.key);
    const c = await joinLearner({ room: s.room, key: s.key });
    expect((await c.next("welcome")).status).toBe("admitted");
    // only declared activities are accepted
    c.send({ v: 1, t: "vote", activity: "p1", step: "s-a:1", choice: 1 });
    await c.next("ack");
    c.send({ v: 1, t: "vote", activity: "p9", step: "s-a:1", choice: 0 });
    expect((await c.next("error")).code).toBe("unknown_activity");
    // the setup secret is not kept
    const stored = await runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(s.room)), async (_, state) => JSON.stringify([...(await state.storage.list()).entries()]));
    expect(stored).not.toContain(s.setup);
    c.close(); t.close();
  });

  it("refuses a room that already exists (409 room_exists); the first host keeps it", async () => {
    const s = await newSetup();
    const [, , first] = await status(await post(body(s)));
    const [code, err, j] = await status(await post(body(s, { activities: { "*": [{ id: "qa", kind: "qa" }] }, requireApproval: true })));
    expect([code, err]).toEqual([409, "room_exists"]);
    ok(j, "httpError");
    expect(j.adminKey).toBeUndefined();
    const t = await joinTeacher(first);
    expect(t.state.activities).toEqual(ACTS);      // unchanged by the refused request
    expect(t.state.requireApproval).toBe(false);
    t.close();
  });

  it("two creates of the same room at once: exactly one wins", async () => {
    const s = await newSetup();
    const results = await Promise.all([post(body(s)), post(body(s)), post(body(s))].map(async (p) => (await p).status));
    expect(results.sort()).toEqual([201, 409, 409]);
  });

  it("holding the lesson file (room and key) is not enough: room and key must belong to the setup secret", async () => {
    const s = await newSetup(), other = await newSetup();
    // someone with the file guesses or makes up a setup
    expect((await status(await post(body({ ...s, setup: other.setup }))))[1]).toBe("bad_request");
    expect((await status(await post(body({ ...s, key: other.key }))))[1]).toBe("bad_request");
    expect((await status(await post(body({ ...s, room: other.room }))))[1]).toBe("bad_request");
    // the real setup still works afterwards
    expect((await post(body(s))).status).toBe(201);
  });

  it("validates format and entropy", async () => {
    const s = await newSetup();
    const bad = async (b) => { const [c, e, j] = await status(await post(b)); ok(j, "httpError"); return [c, e]; };
    expect(await bad(body(s, { room: "r-ABCDEFGH" }))).toEqual([400, "bad_request"]);
    expect(await bad(body(s, { key: s.key + "A" }))).toEqual([400, "bad_request"]);       // 23 characters
    expect(await bad(body(s, { setup: s.setup.slice(0, 42) }))).toEqual([400, "bad_request"]);
    expect(await bad(body(s, { setup: s.setup.slice(0, 42) + "B" }))).toEqual([400, "bad_request"]);   // not canonical base64url of 32 bytes
    // well-formed but not random: refused before the derivation is even compared
    for (const weak of ["A".repeat(43), "AbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbA", "abcdefghijklmnopqrstuvwxyz012345678AAAAAAAA"]) {
      expect(setupLooksRandom(weak), weak).toBe(false);
      const ids = await setupIds(weak);
      expect(await bad(body({ setup: weak, ...ids }))).toEqual([400, "bad_request"]);
    }
    // room, key and setup come together, with the activities
    expect(await bad(body(s, { setup: undefined }))).toEqual([400, "bad_request"]);
    expect(await bad({ ...body(s), key: undefined, setup: undefined })).toEqual([400, "bad_request"]);
    expect(await bad(body(s, { activities: undefined }))).toEqual([400, "bad_request"]);
    expect(await bad(body(s, { adminKey: "x".repeat(43) }))).toEqual([400, "bad_request"]);
  });

  it("the activity and window limits apply", async () => {
    const s = await newSetup();
    const many = { "*": Array.from({ length: L.MAX_ACTIVITIES + 1 }, (_, i) => ({ id: "a" + i, kind: "qa" })) };
    const bad = async (b) => (await status(await post(b))).slice(0, 2);
    expect(await bad(body(s, { activities: many }))).toEqual([400, "room_limit"]);
    expect(await bad(body(s, { activities: { "s-a:1": [{ id: "p", kind: "poll", choices: ["only one"] }] } }))).toEqual([400, "bad_message"]);
    expect(await bad(body(s, { activities: { "*": [{ id: "qa", kind: "qa", label: "x".repeat(L.MAX_LABEL_CHARS + 1) }] } }))).toEqual([400, "text_too_long"]);
    expect(await bad(body(s, { window: windowAround(Date.now(), 0, L.MAX_WINDOW_MS + 60_000) }))).toEqual([400, "window_too_long"]);
    expect(await bad(body(s, { window: windowAround(Date.now(), 3 * 3600_000, -3600_000) }))).toEqual([400, "bad_request"]);
    expect(await bad(body(s, { size: L.MAX_ROOM_SIZE + 1 }))).toEqual([400, "room_too_large"]);
    // none of the refused requests took the room
    expect((await post(body(s))).status).toBe(201);
  });

  it("Turnstile is still required, and checked after the setup is validated", async () => {
    const s = await newSetup();
    expect((await status(await post(body(s, { turnstile: undefined }))))[1]).toBe("turnstile_required");
    const failing = { envOverride: { TURNSTILE_SECRET: "2x0000000000000000000000000000000AA" } };
    expect((await status(await post(body(s), failing))).slice(0, 2)).toEqual([403, "turnstile_failed"]);
    // a request whose setup does not match is refused before the token is spent
    const other = await newSetup();
    expect((await status(await post(body({ ...s, setup: other.setup }), failing))).slice(0, 2)).toEqual([400, "bad_request"]);
    expect((await status(await post(body(s), { envOverride: { TURNSTILE_SECRET: undefined } }))).slice(0, 2)).toEqual([503, "unavailable"]);
    // the room was not created by any of these
    expect((await post(body(s))).status).toBe(201);
  });

  it("the per-sender rate limit and the same-origin rule apply", async () => {
    const one = { "cf-connecting-ip": "192.0.2.177" };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post(body(await newSetup()), { headers: one })).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
    expect((await status(await post(body(await newSetup()), { headers: { origin: "https://evil.example" } }))).slice(0, 2)).toEqual([403, "forbidden"]);
  });

  it("the earlier way (the service chooses room and key) still works", async () => {
    const [code, , r] = await status(await post({ v: 1, window: windowAround(), turnstile: DUMMY_TOKEN }));
    expect(code).toBe(201);
    ok(r, "createResponse");
  });
});

describe("one-way setup: the create page", () => {
  const STRICT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' wss://live.test; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  it("offers the paste box first and keeps the earlier form", async () => {
    const html = await (await SELF.fetch(ORIGIN + "/")).text();
    expect(html.indexOf('id="setup-form"')).toBeGreaterThan(0);
    expect(html.indexOf('id="setup-form"')).toBeLessThan(html.indexOf('id="create-form"'));
    expect(html).toMatch(/<details id="manual">[\s\S]*id="create-form"[\s\S]*<\/details>/);
    expect(html.match(/id="turnstile"/g)).toHaveLength(1);
    const js = await (await SELF.fetch(ORIGIN + "/teacher.js")).text();
    expect(js).toContain('from "/setup-core.js"');
    expect(js).toContain("Egatari Studio の「ライブ（質問・投票）を付けて配る」でコピーした文字列を、ここに 1 回だけ貼ります");
    const room = await (await SELF.fetch(ORIGIN + "/room")).text();
    expect(room).toContain('id="created-studio"');
  });

  it("setup-core.js is served under the strict CSP and makes no requests", async () => {
    const res = await SELF.fetch(ORIGIN + "/setup-core.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(STRICT_CSP);
    const src = await res.text();
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new Image|EventSource|WebSocket|import\(/);
  });
});
