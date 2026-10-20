// SPDX-License-Identifier: AGPL-3.0-only
import { SELF, env, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as L from "../src/limits.js";
import { CLOSE } from "../src/protocol.js";
import closeCodes from "../protocol/close-codes.json";
import {
  ORIGIN, validate, createRoom, joinLearner, joinTeacher, openSocket, learnerPath, newPid, windowAround,
} from "./helpers.js";

const fixtures = import.meta.glob("../protocol/fixtures/**/*.json", { eager: true, import: "default" });
const FIXTURE_DEF = {
  learner: "learnerToServer", "server-learner": "serverToLearner", teacher: "teacherToServer", "server-teacher": "serverToTeacher",
  "http/create-request": "createRequest", "http/create-response": "createResponse", "http/results": "results", "http/error": "httpError",
};
const defFor = (path) => {
  const rel = path.replace("../protocol/fixtures/", "").replace(/\.json$/, "");
  return FIXTURE_DEF[rel] || FIXTURE_DEF[rel.split("/")[0]];
};
const ok = (msg, def) => expect(validate(msg, def), JSON.stringify(msg)).toEqual([]);
const roomStub = (room) => env.ROOMS.get(env.ROOMS.idFromName(room));
// Refill every learner's rate-limit bucket in a room, so a test can send many messages at once.
const refill = (room) => runInDurableObject(roomStub(room), async (_, state) => {
  for (const ws of state.getWebSockets("learner")) { const a = ws.deserializeAttachment(); a.tokens = L.RATE_BURST; a.last = Date.now(); ws.serializeAttachment(a); }
});
const ask = (text = "Why?", extra = {}) => ({ v: 1, t: "ask", activity: "qa", step: "s1:1", text, ...extra });

describe("protocol files", () => {
  it("every fixture is valid against the schema", () => {
    const paths = Object.keys(fixtures);
    expect(paths.length).toBeGreaterThan(25);
    for (const p of paths) {
      const def = defFor(p);
      expect(def, p).toBeTruthy();
      expect(validate(fixtures[p], def), p).toEqual([]);
    }
  });
  it("close-codes.json matches the server's close codes", () => {
    const table = Object.fromEntries(closeCodes.codes.map((c) => [c.name, c.code]));
    const server = Object.fromEntries(Object.entries(CLOSE).map(([k, v]) => [k.toLowerCase(), v]));
    expect(table).toEqual(server);
  });
  it("learner fixtures are accepted by a live room", async () => {
    const r = await createRoom();
    const c = await joinLearner(r);
    await c.next("welcome");
    for (const name of ["name", "ask"]) {
      c.send(fixtures[`../protocol/fixtures/learner/${name}.json`]);
      ok(await c.next("ack"), "serverToLearner");
    }
    c.send(fixtures["../protocol/fixtures/learner/vote.json"]);
    ok(await c.next("ack"), "serverToLearner");
    c.send(fixtures["../protocol/fixtures/learner/ping.json"]);
    ok(await c.next("pong"), "serverToLearner");
    c.close();
  });
});

describe("rooms", () => {
  it("creates a room and a learner joins", async () => {
    const r = await createRoom();
    ok(r, "createResponse");
    expect(r.room).toMatch(/^r-[a-z2-7]{8}$/);
    expect(r.key.length).toBeGreaterThanOrEqual(22);
    expect(r.adminKey.length).toBeGreaterThanOrEqual(43);
    expect(r.teacherUrl).toBe(`${ORIGIN}/#room=${r.room}&admin=${r.adminKey}`);
    expect(r.graceHours).toBe(24);
    const t = await joinTeacher(r);
    ok(t.state, "serverToTeacher");
    const c = await joinLearner(r);
    const w = await c.next("welcome");
    ok(w, "serverToLearner");
    expect(w.status).toBe("admitted");
    const people = await t.next("people", (m) => m.connected === 1);
    ok(people, "serverToTeacher");
    c.send(ask("What is a gradient?", { ref: "x1" }));
    const ack = await c.next("ack");
    expect(ack.ref).toBe("x1");
    const item = await t.next("item");
    ok(item, "serverToTeacher");
    expect(item.item.text).toBe("What is a gradient?");
    c.close(); t.close();
  });

  it("validates the creation request", async () => {
    const bad = async (body, headers = {}) => {
      const res = await SELF.fetch(ORIGIN + "/api/rooms", {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      });
      const j = await res.json();
      ok(j, "httpError");
      return res.status;
    };
    expect(await bad({ window: { from: "tomorrow", to: "later" } })).toBe(400);
    expect(await bad({ window: windowAround(Date.now(), 3600_000 * 3, -3600_000) })).toBe(400); // already over
    expect(await bad({ window: windowAround(), graceHours: 169 })).toBe(400);
    expect(await bad({ window: windowAround(), extra: 1 })).toBe(400);
    expect(await bad({ window: windowAround() }, { origin: "https://evil.example" })).toBe(403);
    const r = await createRoom({ graceHours: 168 });
    expect(r.graceHours).toBe(168);
  });

  it("rejects a wrong key", async () => {
    const r = await createRoom();
    const c = await openSocket(learnerPath(r.room, "A".repeat(22), newPid()), { origin: "null" });
    expect(await c.closedWith()).toBe(CLOSE.BAD_KEY);
    const d = await openSocket(learnerPath("r-aaaaaaaa", r.key, newPid()), { origin: "null" });
    expect(await d.closedWith()).toBe(CLOSE.ROOM_NOT_FOUND);
  });

  it("accepts learners from file:// pages (Origin null) and from any origin", async () => {
    const r = await createRoom();
    const a = await joinLearner(r, newPid(), { origin: "null" });
    expect((await a.next("welcome")).status).toBe("admitted");
    const b = await joinLearner(r, newPid(), { origin: "https://some-lms.example" });
    expect((await b.next("welcome")).status).toBe("admitted");
    a.close(); b.close();
  });

  it("a newer connection with the same pid supersedes the old one", async () => {
    const r = await createRoom();
    const pid = newPid();
    const a = await joinLearner(r, pid);
    await a.next("welcome");
    const b = await joinLearner(r, pid);
    await b.next("welcome");
    expect(await a.closedWith()).toBe(CLOSE.SUPERSEDED);
    b.close();
  });
});

describe("hibernation", () => {
  it("sockets and room state survive the Durable Object being evicted", async () => {
    const r = await createRoom({ requireApproval: true });
    const t = await joinTeacher(r);
    const c = await joinLearner(r);
    expect((await c.next("welcome")).status).toBe("waiting");
    await evictDurableObject(roomStub(r.room));
    t.send({ v: 1, t: "admit", pid: c.pid });
    await c.next("admitted");
    c.send(ask("after waking"));
    await c.next("ack");
    expect((await t.next("item")).item.text).toBe("after waking");
    c.close(); t.close();
  });
});

describe("teacher controls", () => {
  it("replacing the key kicks old connections and old keys stop working", async () => {
    const r = await createRoom();
    const t = await joinTeacher(r);
    const c = await joinLearner(r);
    await c.next("welcome");
    t.send({ v: 1, t: "rekey", ref: "k" });
    const re = await t.next("rekeyed");
    ok(re, "serverToTeacher");
    expect(re.key).not.toBe(r.key);
    expect(await c.closedWith()).toBe(CLOSE.KEY_REPLACED);
    const old = await joinLearner(r);
    expect(await old.closedWith()).toBe(CLOSE.BAD_KEY);
    const fresh = await joinLearner({ ...r, key: re.key });
    expect((await fresh.next("welcome")).status).toBe("admitted");
    fresh.close(); t.close();
  });

  it("approval: learners wait until admitted; declined learners are closed", async () => {
    const r = await createRoom({ requireApproval: true });
    const t = await joinTeacher(r);
    const a = await joinLearner(r);
    const w = await a.next("welcome");
    expect(w.status).toBe("waiting");
    ok(w, "serverToLearner");
    a.send({ v: 1, t: "name", name: "Aiko" });
    await a.next("ack");
    a.send(ask());
    expect((await a.next("error")).code).toBe("not_admitted");
    const people = await t.next("people", (m) => m.waiting.some((x) => x.pid === a.pid && x.name === "Aiko"));
    ok(people, "serverToTeacher");
    t.send({ v: 1, t: "admit", pid: a.pid });
    ok(await a.next("admitted"), "serverToLearner");
    a.send(ask());
    await a.next("ack");
    // reconnecting after admission does not wait again
    a.close();
    const a2 = await joinLearner(r, a.pid);
    expect((await a2.next("welcome")).status).toBe("admitted");

    const b = await joinLearner(r);
    expect((await b.next("welcome")).status).toBe("waiting");
    t.send({ v: 1, t: "deny", pid: b.pid });
    expect(await b.closedWith()).toBe(CLOSE.NOT_APPROVED);
    const b2 = await joinLearner(r, b.pid);
    expect(await b2.closedWith()).toBe(CLOSE.NOT_APPROVED);

    // turning approval off admits everyone waiting
    const c = await joinLearner(r);
    expect((await c.next("welcome")).status).toBe("waiting");
    t.send({ v: 1, t: "approval", required: false });
    await c.next("admitted");
    a2.close(); c.close(); t.close();
  });

  it("close and reopen", async () => {
    const r = await createRoom();
    const t = await joinTeacher(r);
    const c = await joinLearner(r);
    await c.next("welcome");
    t.send({ v: 1, t: "close" });
    expect(await c.closedWith()).toBe(CLOSE.ROOM_CLOSED);
    expect((await t.next("state", (m) => m.open === false)).open).toBe(false);
    const d = await joinLearner(r);
    expect(await d.closedWith()).toBe(CLOSE.ROOM_CLOSED);
    t.send({ v: 1, t: "open" });
    await t.next("state", (m) => m.open === true);
    const e = await joinLearner(r, c.pid);
    expect((await e.next("welcome")).status).toBe("admitted");
    e.close(); t.close();
  });

  it("moderation: read, answered, shown (projected to learners), hidden", async () => {
    const r = await createRoom();
    const t = await joinTeacher(r);
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send(ask("Show me"));
    await c.next("ack");
    const { item } = await t.next("item");
    t.send({ v: 1, t: "mark", item: item.id, read: true, shown: true });
    const shown = await c.next("shown");
    ok(shown, "serverToLearner");
    expect(shown.items).toEqual([{ id: item.id, activity: "qa", step: "s1:1", text: "Show me" }]);
    expect(JSON.stringify(shown)).not.toContain(c.pid); // learners never see who asked
    const upd = await t.next("item", (m) => m.item.shown);
    expect(upd.item.read).toBe(true);
    t.send({ v: 1, t: "mark", item: item.id, hidden: true, answered: true });
    expect((await c.next("shown")).items).toEqual([]);
    const h = await t.next("item", (m) => m.item.hidden);
    expect(h.item).toMatchObject({ hidden: true, shown: false, answered: true });
    c.close(); t.close();
  });

  it("polls: one vote per participant, tally for the teacher, activities validated when set", async () => {
    const activities = { "*": [{ id: "qa", kind: "qa" }], "s1:2": [{ id: "p1", kind: "poll", prompt: "Q?", choices: ["a", "b", "c"] }] };
    const r = await createRoom({ activities });
    const t = await joinTeacher(r);
    const a = await joinLearner(r), b = await joinLearner(r);
    await a.next("welcome"); await b.next("welcome");
    const vote = (choice, extra = {}) => ({ v: 1, t: "vote", activity: "p1", step: "s1:2", choice, ...extra });
    a.send(vote(0)); await a.next("ack");
    b.send(vote(2)); await b.next("ack");
    a.send(vote(2)); await a.next("ack");   // a changes the vote
    const tally = await t.next("tally", (m) => m.total === 2 && m.counts[2] === 2);
    ok(tally, "serverToTeacher");
    expect(tally.counts).toEqual([0, 0, 2]);
    await refill(r.room);
    a.send(vote(3)); expect((await a.next("error")).code).toBe("bad_choice");
    a.send(vote(0, { activity: "nope" })); expect((await a.next("error")).code).toBe("unknown_activity");
    a.send(vote(0, { step: "s9:1" })); expect((await a.next("error")).code).toBe("unknown_activity");
    a.send({ v: 1, t: "ask", activity: "p1", step: "s1:2", text: "x" }); expect((await a.next("error")).code).toBe("wrong_kind");
    a.close(); b.close(); t.close();
  });

  it("teacher endpoints reject a missing or wrong adminKey", async () => {
    const r = await createRoom();
    // results over HTTP
    let res = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`);
    expect(res.status).toBe(401);
    ok(await res.json(), "httpError");
    res = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`, { headers: { authorization: "Bearer " + "x".repeat(43) } });
    expect(res.status).toBe(401);
    res = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`, { headers: { authorization: "Bearer " + r.key } });
    expect(res.status).toBe(401);   // the learner key is not a teacher key
    // teacher socket: wrong key, no auth, or an action before auth
    const s1 = await openSocket(`/ws/teacher?room=${r.room}`, { origin: ORIGIN });
    s1.send({ v: 1, t: "auth", adminKey: "y".repeat(43) });
    expect(await s1.closedWith()).toBe(CLOSE.UNAUTHORIZED);
    const s2 = await openSocket(`/ws/teacher?room=${r.room}`, { origin: ORIGIN });
    s2.send({ v: 1, t: "close" });
    expect(await s2.closedWith()).toBe(CLOSE.UNAUTHORIZED);
    // a learner socket cannot send teacher messages
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send({ v: 1, t: "rekey" });
    expect((await c.next("error")).code).toBe("unknown_type");
    expect(await c.closedWith()).toBe(CLOSE.BAD_MESSAGE);
    // teacher socket from another site is refused before upgrade
    res = await SELF.fetch(`${ORIGIN}/ws/teacher?room=${r.room}`, { headers: { upgrade: "websocket", origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    // and the room is still open
    const t = await joinTeacher(r);
    expect(t.state.open).toBe(true);
    t.close();
  });

  it("results JSON has the shape {room, window, activities, responses}", async () => {
    const r = await createRoom();
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send({ v: 1, t: "name", name: "Ken" }); await c.next("ack");
    c.send(ask("Q1")); await c.next("ack");
    c.send({ v: 1, t: "vote", activity: "p1", step: "s1:2", choice: 1 }); await c.next("ack");
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`, { headers: { authorization: "Bearer " + r.adminKey } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const j = await res.json();
    ok(j, "results");
    expect(j.room).toBe(r.room);
    expect(j.window).toEqual(r.window);
    expect(j.activities).toEqual({ "*": [{ id: "qa", kind: "qa" }], "s1:2": [{ id: "p1", kind: "poll" }] });
    expect(j.responses.map((x) => x.kind)).toEqual(["qa", "poll"]);
    expect(j.responses[0]).toMatchObject({ text: "Q1", pid: c.pid, name: "Ken" });
    expect(j.responses[1]).toMatchObject({ choice: 1, pid: c.pid });
    c.close();
  });
});

describe("limits", () => {
  it("rate limit: errors when the bucket is empty, then closes with 4429", async () => {
    const r = await createRoom();
    const c = await joinLearner(r);
    await c.next("welcome");
    for (let i = 0; i < L.RATE_BURST + L.RATE_MAX_DROPS + 2; i++) c.send({ v: 1, t: "name", name: "n" + i });
    const err = await c.next("error");
    ok(err, "serverToLearner");
    expect(err.code).toBe("rate_limited");
    expect(await c.closedWith()).toBe(CLOSE.RATE_LIMITED);
  });

  it("oversize message closes with 4400; long text is refused without closing", async () => {
    const r = await createRoom();
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send(ask("x".repeat(L.MAX_QUESTION_CHARS + 1)));
    expect((await c.next("error")).code).toBe("text_too_long");
    c.send(ask("x".repeat(L.MAX_LEARNER_MESSAGE_BYTES)));
    expect((await c.next("error")).code).toBe("too_large");
    expect(await c.closedWith()).toBe(CLOSE.BAD_MESSAGE);
  });

  it("bad JSON or a wrong version closes with 4400", async () => {
    const r = await createRoom();
    const a = await joinLearner(r);
    await a.next("welcome");
    a.send("{not json");
    expect(await a.closedWith()).toBe(CLOSE.BAD_MESSAGE);
    const b = await joinLearner(r);
    await b.next("welcome");
    b.send({ v: 2, t: "ask" });
    expect((await b.next("error")).code).toBe("unsupported_version");
    expect(await b.closedWith()).toBe(CLOSE.BAD_MESSAGE);
  });

  it("caps questions per participant", async () => {
    const r = await createRoom();
    const c = await joinLearner(r);
    await c.next("welcome");
    // raise the participant's count to the cap directly (sending 20 questions would hit the rate limit first)
    await runInDurableObject(roomStub(r.room), async (_, state) => {
      const p = await state.storage.get("p:" + c.pid);
      p.asked = L.MAX_QUESTIONS_PER_PARTICIPANT;
      await state.storage.put("p:" + c.pid, p);
    });
    c.send(ask("one too many"));
    expect((await c.next("error")).code).toBe("quota_exceeded");
    c.close();
  });

  it("room size: refuses learners beyond the connection limit", async () => {
    const r = await createRoom();
    await runInDurableObject(roomStub(r.room), async (inst) => {
      inst.meta.participants = L.MAX_PARTICIPANTS;
      await inst.saveMeta();
    });
    const c = await joinLearner(r);
    expect(await c.closedWith()).toBe(CLOSE.ROOM_FULL);
  });
});

describe("lifetime", () => {
  it("refuses learners before the window and after it", async () => {
    const now = Date.now();
    const early = await createRoom({ window: windowAround(now, -3600_000, 7200_000) });   // starts in 1 h
    const a = await joinLearner(early);
    expect(await a.closedWith()).toBe(CLOSE.TOO_EARLY);
    const r = await createRoom();
    await runInDurableObject(roomStub(r.room), async (inst) => {
      inst.meta.window = { from: new Date(now - 7200_000).toISOString(), to: new Date(now - 3600_000).toISOString() };
      await inst.saveMeta();
    });
    const b = await joinLearner(r);
    expect(await b.closedWith()).toBe(CLOSE.ROOM_EXPIRED);
  });

  it("the expiry alarm deletes all state and closes sockets", async () => {
    const r = await createRoom({ graceHours: 0 });
    const t = await joinTeacher(r);
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send(ask("keep me?")); await c.next("ack");
    const stub = roomStub(r.room);
    const alarm = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now());
    // move the window into the past, then fire the alarm
    await runInDurableObject(stub, async (inst) => {
      const now = Date.now();
      inst.meta.window = { from: new Date(now - 7200_000).toISOString(), to: new Date(now - 3600_000).toISOString() };
      await inst.saveMeta();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await c.closedWith()).toBe(CLOSE.ROOM_EXPIRED);
    expect(await t.closedWith()).toBe(CLOSE.ROOM_EXPIRED);
    const left = await runInDurableObject(stub, async (_, state) => [...(await state.storage.list()).keys()]);
    expect(left).toEqual([]);
    const after = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`, { headers: { authorization: "Bearer " + r.adminKey } });
    expect(after.status).toBe(404);
    const d = await joinLearner(r);
    expect(await d.closedWith()).toBe(CLOSE.ROOM_NOT_FOUND);
  });

  it("at the end of the window the alarm closes learners and waits for the grace period", async () => {
    const r = await createRoom({ graceHours: 24 });
    const c = await joinLearner(r);
    await c.next("welcome");
    const stub = roomStub(r.room);
    await runInDurableObject(stub, async (inst) => {
      const now = Date.now();
      inst.meta.window = { from: new Date(now - 7200_000).toISOString(), to: new Date(now - 10 * 60_000).toISOString() };
      await inst.saveMeta();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await c.closedWith()).toBe(CLOSE.ROOM_EXPIRED);
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`, { headers: { authorization: "Bearer " + r.adminKey } });
    expect(res.status).toBe(200);   // results still downloadable during the grace period
    const next = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThan(Date.now() + 23 * 3600_000 - 10 * 60_000);
  });
});

describe("teacher page", () => {
  it("is served with a strict CSP and no inline script", async () => {
    const res = await SELF.fetch(ORIGIN + "/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("connect-src 'self' wss://live.test");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain('<script src="/teacher.js" defer></script>');
    expect(html).not.toMatch(/<script>(?!<)/);
    expect(html).not.toMatch(/\sstyle=/);
    const js = await SELF.fetch(ORIGIN + "/teacher.js");
    expect(js.status).toBe(200);
    expect(await js.text()).not.toContain("innerHTML");
  });

  it("health endpoint answers", async () => {
    const res = await SELF.fetch(ORIGIN + "/api/health");
    expect(await res.json()).toEqual({ v: 1, ok: true, service: "egatari-live" });
  });
});
