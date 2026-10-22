// SPDX-License-Identifier: AGPL-3.0-only
// Questions anchored to a step (region, source hash), "I don't follow" (kind confused), and the host's
// grouping and short replies. Learners never see other learners' questions unless the host shows them
// (mark shown) or replies to everyone (reply public).
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as L from "../src/limits.js";
import { CLOSE } from "../src/protocol.js";
import { ORIGIN, validate, createRoom, joinLearner, joinTeacher, newPid } from "./helpers.js";

const ok = (msg, def) => expect(validate(msg, def), JSON.stringify(msg)).toEqual([]);
const roomStub = (room) => env.ROOMS.get(env.ROOMS.idFromName(room));
const refill = (room) => runInDurableObject(roomStub(room), async (_, state) => {
  for (const ws of state.getWebSockets("learner")) { const a = ws.deserializeAttachment(); a.tokens = L.RATE_BURST; a.last = Date.now(); ws.serializeAttachment(a); }
});
const SHA = "3f0c2a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170f6e5d4c";
const CIRCLE = [[[612.4, 301.2], [655, 288.5], [690.3, 310], [684.1, 352.7], [640.2, 366.9], [612.4, 301.2]]];
const ACTS = { "*": [{ id: "qa", kind: "qa" }, { id: "cf", kind: "confused" }] };
const ask = (text = "Why?", extra = {}) => ({ v: 1, t: "ask", activity: "qa", step: "s1:1", text, ...extra });
const confused = (step = "s1:1", extra = {}) => ({ v: 1, t: "confused", activity: "cf", step, ...extra });

/** Nothing else is waiting for this client: a ping is answered by the next message. */
async function nothingPending(c) {
  c.send({ v: 1, t: "ping" });
  await c.next("pong");
  expect(c.msgs.filter((m) => m.t !== "pong"), JSON.stringify(c.msgs)).toEqual([]);
}

/** n points on a line from (x, y), 1 apart (valid region points). */
const line = (n, x = 10, y = 10) => Array.from({ length: n }, (_, i) => [x + (i % 1000) * 1, y + Math.floor(i / 1000)]);

describe("questions with a region and the lesson's source hash", () => {
  it("an ask carries the step on screen, the circled strokes and sourceSha256 to the host and the results", async () => {
    const r = await createRoom({ activities: ACTS });
    const t = await joinTeacher(r);
    const c = await joinLearner(r);
    ok(await c.next("welcome"), "serverToLearner");
    c.send(ask("この矢印は？", { ref: "a1", strokes: CIRCLE, sourceSha256: SHA }));
    const ack = await c.next("ack");
    ok(ack, "serverToLearner");
    const { item } = await t.next("item");
    ok({ v: 1, t: "item", item }, "serverToTeacher");
    expect(item.step).toBe("s1:1");
    expect(item.strokes).toEqual(CIRCLE);
    expect(item.sourceSha256).toBe(SHA);
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`, { headers: { authorization: "Bearer " + r.adminKey } });
    const j = await res.json();
    ok(j, "results");
    const q = j.responses.find((x) => x.kind === "qa");
    expect(q.strokes).toEqual(CIRCLE);
    expect(q.sourceSha256).toBe(SHA);
    c.close(); t.close();
  });

  it("refuses a bad region with bad_region and keeps the connection", async () => {
    const r = await createRoom({ activities: ACTS });
    const c = await joinLearner(r);
    await c.next("welcome");
    const bad = [
      [],                                                           // no stroke
      [[[1, 1]]],                                                   // one point
      [[[1, 1], [1281, 5]]],                                        // outside the stage
      [[[1, 1], [5, 721]]],
      [[[-1, 1], [5, 5]]],
      [[[1.25, 1], [5, 5]]],                                        // not rounded to 0.1
      [[[1, 1], [1, 1], [5, 5]]],                                   // two consecutive points equal
      [[[1, 1], [2, "3"]]],                                         // not a number
      [[[1, 1], [2, 3, 4]]],                                        // not a pair
      "circle",
      Array.from({ length: L.MAX_REGION_STROKES + 1 }, (_, i) => [[i, 1], [i, 2]]),   // 21 strokes
      [line(L.MAX_REGION_STROKE_POINTS + 1)],                       // 501 points in one stroke
      Array.from({ length: 5 }, (_, i) => line(L.MAX_REGION_STROKE_POINTS, 10, 10 + i * 100)).slice(0, 5),   // 2500 in all
    ];
    for (const strokes of bad) {
      await refill(r.room);
      c.send(ask("x", { strokes }));
      const e = await c.next("error");
      expect(e.code, JSON.stringify(strokes).slice(0, 80)).toBe("bad_region");
      ok(e, "serverToLearner");
    }
    // a region needs the step it was drawn on
    await refill(r.room);
    c.send(ask("x", { step: "*", strokes: CIRCLE }));
    expect((await c.next("error")).code).toBe("bad_region");
    // the limits themselves are accepted: 20 strokes, 500 points in one, 2000 in all
    await refill(r.room);
    c.send(ask("x", { strokes: [line(L.MAX_REGION_STROKE_POINTS), ...Array.from({ length: 19 }, (_, i) => [[i, 600], [i, 601]])] }));
    await c.next("ack");
    c.send(ask("x", { strokes: Array.from({ length: 4 }, (_, i) => line(L.MAX_REGION_STROKE_POINTS, 10, 10 + i * 100)) }));
    await c.next("ack");
    expect(c.closed).toBe(null);
    c.close();
  });

  it("a malformed sourceSha256 is a protocol error (4400)", async () => {
    const r = await createRoom({ activities: ACTS });
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send(ask("x", { sourceSha256: "ABC" }));
    expect((await c.next("error")).code).toBe("bad_message");
    expect(await c.closedWith()).toBe(CLOSE.BAD_MESSAGE);
  });

  it("a room holds at most MAX_REGION_POINTS_PER_ROOM region points (room_limit); questions without a region still go", async () => {
    const r = await createRoom({ activities: ACTS });
    const c = await joinLearner(r);
    await c.next("welcome");
    await runInDurableObject(roomStub(r.room), async (room) => { room.meta.regionPoints = L.MAX_REGION_POINTS_PER_ROOM - 3; await room.saveMeta(); });
    c.send(ask("x", { strokes: [[[1, 1], [2, 2], [3, 3]]] }));
    await c.next("ack");
    c.send(ask("y", { strokes: [[[1, 1], [2, 2]]] }));
    expect((await c.next("error")).code).toBe("room_limit");
    c.send(ask("z"));
    await c.next("ack");
    c.close();
  });

  it("other learners receive nothing when someone asks", async () => {
    const r = await createRoom({ activities: ACTS });
    const a = await joinLearner(r), b = await joinLearner(r);
    await a.next("welcome"); await b.next("welcome");
    a.send(ask("secret question", { strokes: CIRCLE }));
    await a.next("ack");
    await nothingPending(b);
    a.close(); b.close();
  });
});

describe("I don't follow (confused)", () => {
  it("one mark per participant and step, taken back with on:false; the host sees counts per step", async () => {
    const r = await createRoom({ activities: ACTS });
    const t = await joinTeacher(r);
    expect(t.state.confused).toEqual({});
    const a = await joinLearner(r), b = await joinLearner(r);
    await a.next("welcome"); await b.next("welcome");
    a.send(confused("s1:1", { ref: "c1" }));
    ok(await a.next("ack"), "serverToLearner");
    let m = await t.next("confused");
    ok(m, "serverToTeacher");
    expect(m).toMatchObject({ step: "s1:1", count: 1 });
    b.send(confused("s1:1"));
    await b.next("ack");
    expect((await t.next("confused")).count).toBe(2);
    // a second tap is idempotent: acknowledged, nothing counted twice, no message to the host
    a.send(confused("s1:1"));
    await a.next("ack");
    a.send(confused("s2:0"));
    await a.next("ack");
    m = await t.next("confused");
    expect(m).toMatchObject({ step: "s2:0", count: 1 });
    a.send(confused("s1:1", { on: false }));
    await a.next("ack");
    expect((await t.next("confused")).count).toBe(1);
    t.send({ v: 1, t: "state" });
    const st = await t.next("state");
    ok(st, "serverToTeacher");
    expect(st.confused).toEqual({ "s1:1": 1, "s2:0": 1 });
    // other learners see nothing of it
    await nothingPending(b);
    // results: the marks that are on
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${r.room}/results`, { headers: { authorization: "Bearer " + r.adminKey } });
    const j = await res.json();
    ok(j, "results");
    const marks = j.responses.filter((x) => x.kind === "confused").map((x) => [x.pid, x.step]).sort();
    expect(marks).toEqual([[a.pid, "s2:0"], [b.pid, "s1:1"]].sort());
    a.close(); b.close(); t.close();
  });

  it("checks the activity: declared kind, wrong kind, unknown id; any step for an activity under '*'", async () => {
    const r = await createRoom({ activities: { "*": [{ id: "qa", kind: "qa" }], "s1:1": [{ id: "cf1", kind: "confused" }] } });
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send(confused("s1:1", { activity: "qa" }));
    expect((await c.next("error")).code).toBe("wrong_kind");
    c.send(ask("x", { activity: "cf1" }));
    expect((await c.next("error")).code).toBe("wrong_kind");
    await refill(r.room);
    c.send(confused("s1:1", { activity: "nope" }));
    expect((await c.next("error")).code).toBe("unknown_activity");
    c.send(confused("s2:0", { activity: "cf1" }));     // declared under another step
    expect((await c.next("error")).code).toBe("unknown_activity");
    c.send(confused("s1:1", { activity: "cf1" }));
    await c.next("ack");
    await refill(r.room);
    c.send(confused("s1:1", { activity: "cf1", on: "yes" }));
    expect((await c.next("error")).code).toBe("bad_message");
    expect(await c.closedWith()).toBe(CLOSE.BAD_MESSAGE);
  });

  it("without declared activities the kind is learned and listed under '*'", async () => {
    const r = await createRoom();
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send(confused("s1:1", { activity: "dunno" }));
    await c.next("ack");
    c.send({ v: 1, t: "activities" });
    const acts = await c.next("activities");
    expect(acts.activities["*"]).toEqual([{ id: "dunno", kind: "confused" }]);
    c.close();
  });

  it("caps the steps one participant may mark and the steps a room counts", async () => {
    const r = await createRoom({ activities: ACTS });
    const c = await joinLearner(r);
    await c.next("welcome");
    await runInDurableObject(roomStub(r.room), async (room, state) => {
      const p = await state.storage.get("p:" + c.pid);
      p.confusedSteps = L.MAX_CONFUSED_STEPS_PER_PARTICIPANT;
      await state.storage.put("p:" + c.pid, p);
    });
    c.send(confused("s9:9"));
    expect((await c.next("error")).code).toBe("quota_exceeded");
    const d = await joinLearner(r);
    await d.next("welcome");
    await runInDurableObject(roomStub(r.room), async (room) => {
      const counts = await room.getConfused();
      for (let i = 0; i < L.MAX_CONFUSED_STEPS; i++) counts["x" + i + ":0"] = 0;
    });
    d.send(confused("s8:8"));
    expect((await d.next("error")).code).toBe("room_limit");
    d.send(confused("x1:0"));    // a step already counted is fine
    await d.next("ack");
    c.close(); d.close();
  });
});

describe("the host groups questions and replies", () => {
  async function setup(n = 3) {
    const r = await createRoom({ activities: ACTS });
    const t = await joinTeacher(r);
    const ls = [], ids = [];
    for (let i = 0; i < n; i++) {
      const c = await joinLearner(r);
      await c.next("welcome");
      c.send(ask("Q" + i));
      ids.push((await c.next("ack")).item);
      await t.next("item");
      ls.push(c);
    }
    return { r, t, ls, ids };
  }

  it("a reply goes to the asker only; the others receive nothing", async () => {
    const { r, t, ls, ids } = await setup(2);
    t.send({ v: 1, t: "reply", ref: "r1", item: ids[0], text: "  次のスライドで説明します  " });
    ok(await t.next("ack"), "serverToTeacher");
    const it = (await t.next("item")).item;
    expect(it.reply).toMatchObject({ text: "次のスライドで説明します", public: false });
    expect(it.answered).toBe(true);
    expect(it.shown).toBe(false);
    const m = await ls[0].next("reply");
    ok(m, "serverToLearner");
    expect(m).toMatchObject({ item: ids[0], question: "Q0", step: "s1:1", text: "次のスライドで説明します", public: false });
    await nothingPending(ls[1]);
    // on reconnect, the asker gets the reply again in welcome
    ls[0].close();
    const again = await joinLearner(r, ls[0].pid);
    const w = await again.next("welcome");
    ok(w, "serverToLearner");
    expect(w.replies.map((x) => x.item)).toEqual([ids[0]]);
    expect(w.shown).toEqual([]);
    const other = await joinLearner(r);
    expect((await other.next("welcome")).replies).toBe(undefined);
    again.close(); other.close(); ls[1].close(); t.close();
  });

  it("a public reply shows the question and the reply to everyone, never who asked", async () => {
    const { t, ls, ids } = await setup(2);
    t.send({ v: 1, t: "reply", item: ids[1], text: "いい質問です", public: true });
    await t.next("ack");
    expect((await ls[1].next("reply")).public).toBe(true);
    for (const c of ls) {
      const s = await c.next("shown");
      ok(s, "serverToLearner");
      expect(s.items).toEqual([{ id: ids[1], activity: "qa", step: "s1:1", text: "Q1", reply: "いい質問です" }]);
    }
    // shown without a public reply carries no reply text
    t.send({ v: 1, t: "reply", item: ids[0], text: "private" });
    await t.next("ack");
    t.send({ v: 1, t: "mark", item: ids[0], shown: true });
    await t.next("ack");
    const s = await ls[1].next("shown", (x) => x.items.length === 2);
    expect(s.items.find((x) => x.id === ids[0])).toEqual({ id: ids[0], activity: "qa", step: "s1:1", text: "Q0" });
    // hiding takes it back from everyone
    t.send({ v: 1, t: "mark", item: ids[1], hidden: true });
    await t.next("ack");
    expect((await ls[1].next("shown", (x) => x.items.length === 1)).items[0].id).toBe(ids[0]);
    for (const c of ls) c.close();
    t.close();
  });

  it("groups similar questions; a reply to one reaches every asker in the group; ungroup", async () => {
    const { t, ls, ids } = await setup(3);
    t.send({ v: 1, t: "group", ref: "g1", items: [ids[0], ids[1]] });
    ok(await t.next("ack"), "serverToTeacher");
    const g = [(await t.next("item")).item, (await t.next("item")).item];
    const gid = g[0].group;
    expect(gid).toMatch(/^g-[a-z2-7]{10}$/);
    expect(g[1].group).toBe(gid);
    // a third joins the same group (it joins the first item's group)
    t.send({ v: 1, t: "group", items: [ids[1], ids[2]] });
    await t.next("ack");
    expect((await t.next("item")).item).toMatchObject({ id: ids[2], group: gid });
    t.send({ v: 1, t: "reply", item: ids[2], text: "まとめて答えます", public: true });
    await t.next("ack");
    for (let i = 0; i < 3; i++) {
      const m = await ls[i].next("reply");
      expect(m).toMatchObject({ item: ids[i], question: "Q" + i, text: "まとめて答えます", public: i === 2 });
    }
    // only the addressed question is shown
    expect((await ls[0].next("shown")).items.map((x) => x.id)).toEqual([ids[2]]);
    // ungroup: leaving a group of two clears the group of the one left
    t.send({ v: 1, t: "ungroup", item: ids[0] });
    await t.next("ack");
    t.send({ v: 1, t: "ungroup", item: ids[1] });
    await t.next("ack");
    t.send({ v: 1, t: "state" });
    const st = await t.next("state");
    ok(st, "serverToTeacher");
    expect(st.items.map((q) => q.group || null)).toEqual([null, null, null]);
    // unknown items
    t.send({ v: 1, t: "group", items: [ids[0], "q-aaaaaaaaaa"] });
    expect((await t.next("error")).code).toBe("not_found");
    t.send({ v: 1, t: "reply", item: "q-aaaaaaaaaa", text: "x" });
    expect((await t.next("error")).code).toBe("not_found");
    for (const c of ls) c.close();
    t.close();
  });

  it("validates replies and groups", async () => {
    const { t, ls, ids } = await setup(1);
    t.send({ v: 1, t: "reply", item: ids[0], text: "x".repeat(L.MAX_REPLY_CHARS + 1) });
    expect((await t.next("error")).code).toBe("text_too_long");
    t.send({ v: 1, t: "reply", item: ids[0], text: "   " });
    expect((await t.next("error")).code).toBe("empty_text");
    t.send({ v: 1, t: "reply", item: ids[0], text: "ok", public: "yes" });
    expect((await t.next("error")).code).toBe("bad_message");
    t.send({ v: 1, t: "group", items: [ids[0]] });
    expect((await t.next("error")).code).toBe("bad_message");
    t.send({ v: 1, t: "group", items: [ids[0], ids[0]] });
    expect((await t.next("error")).code).toBe("bad_message");
    t.send({ v: 1, t: "reply", item: ids[0], text: "x".repeat(L.MAX_REPLY_CHARS) });
    await t.next("ack");
    ls[0].close(); t.close();
  });

  it("a public reply respects the limit of shown questions", async () => {
    const { r, t, ls, ids } = await setup(1);
    await runInDurableObject(roomStub(r.room), async (room, state) => {
      for (let i = 0; i < L.MAX_SHOWN; i++) {
        const id = "q-" + String(i).padStart(10, "a").replace(/[0-9]/g, (d) => "abcdefghij"[d]);
        await state.storage.put("q:" + id, { id, activity: "qa", step: "*", text: "s" + i, pid: newPid(), name: "", at: new Date().toISOString(),
          read: false, answered: false, shown: true, hidden: false });
      }
    });
    t.send({ v: 1, t: "reply", item: ids[0], text: "x", public: true });
    expect((await t.next("error")).code).toBe("room_limit");
    t.send({ v: 1, t: "reply", item: ids[0], text: "x" });
    await t.next("ack");
    ls[0].close(); t.close();
  });

  it("a returning participant gets the replies in welcome, also after approval is turned on", async () => {
    const r = await createRoom({ activities: ACTS, requireApproval: false });
    const t = await joinTeacher(r);
    const c = await joinLearner(r);
    await c.next("welcome");
    c.send(ask("Q"));
    const id = (await c.next("ack")).item;
    t.send({ v: 1, t: "reply", item: id, text: "A" });
    await t.next("ack");
    await c.next("reply");
    c.close();
    t.send({ v: 1, t: "approval", required: true });
    await t.next("ack");
    // the known participant stays admitted, so the reply is in welcome again
    const back = await joinLearner(r, c.pid);
    const w = await back.next("welcome");
    expect(w.status).toBe("admitted");
    expect(w.replies.length).toBe(1);
    back.close(); t.close();
  });
});
