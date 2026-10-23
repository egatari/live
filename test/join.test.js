// SPDX-License-Identifier: AGPL-3.0-only
// The learner join page (/join#room=…&key=…): headers, static files, and its client core.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  JoinClient, joinUrl, parseFragment, socketUrl, plan, closeInfo, viewOf, stepText, shareText, makeStore, BACKOFF, MAX_BLIND_ATTEMPTS,
} from "../public/join-core.js";
import { ORIGIN, createRoom, joinTeacher, validate } from "./helpers.js";

const STRICT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' wss://live.test; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const ROOM = "r-abcdefgh";

// ------------------------------------------------------------------ helpers

/** A WebSocket for the core that goes through the Worker (SELF), recording every URL it is given. */
function workerSocketClass(urls) {
  return class WorkerWS {
    constructor(url) {
      urls.push(url);
      this.readyState = 0;
      this.sent = [];
      SELF.fetch(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket", origin: ORIGIN } }).then((res) => {
        const ws = res.webSocket;
        this.ws = ws;
        ws.addEventListener("message", (e) => this.onmessage && this.onmessage({ data: e.data }));
        ws.addEventListener("close", (e) => { this.readyState = 3; if (this.onclose) this.onclose({ code: e.code }); });
        ws.accept();
        this.readyState = 1;
        if (this.onopen) this.onopen();
      });
    }
    send(d) { this.sent.push(JSON.parse(d)); this.ws.send(d); }
    close(code, reason) { this.readyState = 3; try { this.ws.close(code, reason); } catch { /* closed */ } }
  };
}

/** A fake WebSocket the test drives by hand. */
function fakeSocketClass(list) {
  return class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; list.push(this); }
    open() { this.readyState = 1; this.onopen && this.onopen(); }
    recv(m) { this.onmessage && this.onmessage({ data: JSON.stringify({ v: 1, ...m }) }); }
    closeWith(code) { this.readyState = 3; this.onclose && this.onclose({ code }); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
  };
}

/** A fake clock: timers run only when the test advances time. */
function fakeClock(start = Date.parse("2026-10-23T00:30:00Z")) {
  const c = { t: start, timers: [], id: 0 };
  c.now = () => c.t;
  c.setTimeout = (f, ms) => { const id = ++c.id; c.timers.push({ id, at: c.t + ms, f }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter((x) => x.id !== id); };
  c.setInterval = () => ++c.id;          // pings are not exercised here
  c.clearInterval = () => {};
  c.advance = (ms) => {
    c.t += ms;
    for (const x of c.timers.filter((y) => y.at <= c.t)) { c.clearTimeout(x.id); x.f(); }
  };
  c.pending = () => c.timers.map((x) => x.at - c.t);
  return c;
}

function makeClient(over = {}) {
  const events = [];
  const clock = over.clock || fakeClock();
  const client = new JoinClient({
    origin: ORIGIN, room: ROOM, key: KEY, localStorage: null, sessionStorage: null, crypto,
    now: clock.now, random: () => 0.5, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    onChange: (s, ev) => events.push({ s, ev }), ...over,
  });
  return { client, events, clock };
}

/** Wait until pred(snapshot, events) holds; the core calls onChange on every change. */
function waitFor(events, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const last = events[events.length - 1];
      if (last && pred(last.s, events)) return resolve(last.s);
      if (Date.now() - start > ms) return reject(new Error("timeout; last state " + JSON.stringify(last && last.s)));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const windowNow = (clock) => ({ from: new Date(clock.t - 600_000).toISOString(), to: new Date(clock.t + 3600_000).toISOString() });
const welcome = (clock, status = "admitted") => ({ t: "welcome", room: ROOM, pid: "p".repeat(22), status, window: windowNow(clock), shown: [], limits: {} });

// ------------------------------------------------------------------ the page

describe("join page: served", () => {
  it("/join has the same strict CSP as the teacher room page, and the other headers", async () => {
    const res = await SELF.fetch(ORIGIN + "/join");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(STRICT_CSP);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain('data-page="join"');
    expect(html).toContain('<script type="module" src="/join.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/join.css">');
    expect(html).not.toMatch(/<script>(?!<)/);         // no inline script
    expect(html).not.toMatch(/<style|\sstyle=/);        // no inline style
    expect(html).not.toMatch(/turnstile|challenges\.cloudflare\.com/i);
    // every resource the page loads is a bare same-origin path: no query, no fragment, so no key in any request
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(refs.sort()).toEqual(["/join.css", "/join.js"]);
    // the room page's CSP, for comparison
    expect((await SELF.fetch(ORIGIN + "/room")).headers.get("content-security-policy")).toBe(STRICT_CSP);
  });

  it("its scripts and stylesheet are served under the strict CSP and make no HTTP requests", async () => {
    for (const f of ["/join.js", "/join-core.js", "/join.css"]) {
      const res = await SELF.fetch(ORIGIN + f);
      expect(res.status, f).toBe(200);
      expect(res.headers.get("content-security-policy"), f).toBe(STRICT_CSP);
      const src = await res.text();
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(src, f).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new Image|EventSource|import\(/);
    }
    const js = await (await SELF.fetch(ORIGIN + "/join.js")).text();
    expect(js).toContain('from "/join-core.js"');
    expect(js).toContain("parseFragment(location.hash)");
    expect(js).toContain("この教材から、${HOST} のライブで先生に質問や投票を送れます");
  });
});

describe("join page: links", () => {
  it("the join link carries room and key only in the fragment", () => {
    const u = joinUrl("https://live.egatari.org", ROOM, KEY);
    expect(u).toBe(`https://live.egatari.org/join#room=${ROOM}&key=${KEY}`);
    const url = new URL(u);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/join");
    expect(parseFragment(url.hash)).toEqual({ room: ROOM, key: KEY });
    expect(parseFragment("#room=r-abcdefgh")).toBeNull();
    expect(parseFragment("#room=R-ABC&key=" + KEY)).toBeNull();
    expect(parseFragment("#room=r-abcdefgh&key=short")).toBeNull();
    expect(parseFragment("")).toBeNull();
  });

  it("the socket URL is the protocol's learner URL on the page's origin", () => {
    expect(socketUrl("https://live.egatari.org", ROOM, KEY, "p".repeat(22))).toBe(`wss://live.egatari.org/ws?room=${ROOM}&key=${KEY}&pid=${"p".repeat(22)}`);
    expect(socketUrl("http://localhost:8787", ROOM, KEY, "p".repeat(22))).toBe(`ws://localhost:8787/ws?room=${ROOM}&key=${KEY}&pid=${"p".repeat(22)}`);
    expect(socketUrl("https://live.egatari.org", ROOM, KEY, "short")).toBeNull();
  });

  it("the teacher page shows a join link built from the room and the current key, and warns after rekey", async () => {
    const html = await (await SELF.fetch(ORIGIN + "/room")).text();
    expect(html).toContain('id="join-link"');
    expect(html).toContain('id="copy-join"');
    expect(html).toContain('id="join-rekeyed"');
    expect(html).toContain('<script type="module" src="/teacher.js"></script>');
    const js = await (await SELF.fetch(ORIGIN + "/teacher.js")).text();
    expect(js).toContain('import { joinUrl, stepText } from "/join-core.js"');
    expect(js).toContain("joinUrl(location.origin, st.room, st.key)");
    expect(js).toMatch(/case "rekeyed":[^\n]*\$\("join-rekeyed"\)\.hidden = false[^\n]*renderStatus\(\)/);
    expect(js).toContain("参加用リンク");
    // what the teacher page renders, for a real room before and after rekey
    const r = await createRoom();
    const t = await joinTeacher(r);
    const before = joinUrl(ORIGIN, t.state.room, t.state.key);
    expect(before).toBe(`${ORIGIN}/join#room=${r.room}&key=${r.key}`);
    expect(before).not.toContain(r.adminKey);
    t.send({ v: 1, t: "rekey" });
    const re = await t.next("rekeyed");
    const after = joinUrl(ORIGIN, re.room, re.key);
    expect(after).not.toBe(before);
    expect(parseFragment(new URL(after).hash)).toEqual({ room: r.room, key: re.key });
    t.close();
  });

  it("the teacher page offers a plain-text message to share (ja/en) with the join link and a Copy button", async () => {
    const html = await (await SELF.fetch(ORIGIN + "/room")).text();
    expect(html).toContain('id="share-text"');
    expect(html).toContain('id="copy-share"');
    expect(html).toContain('data-i18n="shareTitle"');
    const js = await (await SELF.fetch(ORIGIN + "/teacher.js")).text();
    expect(js).toContain("配るときの文");
    expect(js).toContain("Text to share");
    expect(js).toContain('$("share-text").value = shareText(lang, jl)');
    expect(js).toContain('copy($("share-text").value)');
    const link = joinUrl(ORIGIN, ROOM, KEY);
    for (const lang of ["ja", "en"]) {
      const s = shareText(lang, link);
      expect(s.split("\n")).toContain(link);                 // the link on a line of its own (chat apps link it)
      expect(s).not.toMatch(/[<>]/);                           // plain text, no markup
      expect(s).toMatch(/Slack/);
    }
    expect(shareText("ja", link)).toMatch(/パソコン：添付のファイルをダウンロードして、ブラウザ/);
    expect(shareText("ja", link)).toMatch(/スマートフォン・タブレット：次のリンク/);
    expect(shareText("en", link)).toMatch(/computer: download the attached file and open it in a browser/);
    expect(shareText("en", link)).toMatch(/phone or tablet: open this link/);
  });
});

describe("join page: retry policy (same table as the player)", () => {
  const now = Date.parse("2026-10-23T00:30:00Z");
  const win = { from: "2026-10-23T00:00:00Z", to: "2026-10-23T02:00:00Z" };

  it("never reconnects by itself after 4400, 4401, 4403, 4404, 4409, 4410, 4440, 4441", () => {
    for (const code of [4400, 4401, 4403, 4404, 4409, 4410, 4440, 4441]) {
      expect(plan(code, 0, now, win).retry, String(code)).toBe(false);
    }
    // 4441 (declined) and 4409 (joined elsewhere) offer a manual retry; the others do not
    expect(plan(4441, 0, now, win)).toEqual({ retry: false, reason: "not_approved", manual: true });
    expect(plan(4409, 0, now, win).manual).toBe(true);
    for (const code of [4400, 4401, 4403, 4404, 4410, 4440]) expect(plan(code, 0, now, win).manual, String(code)).toBe(false);
    expect(closeInfo(4499)).toMatchObject({ name: "unknown", kind: "manual" });
  });

  it("4423 waits at least 30 s with jitter; 4429 and 4430 at least 60 s", () => {
    const d = (code, r, attempt = 0) => plan(code, attempt, now, win, r).delayMs;
    expect(d(4423, 0)).toBe(30000);
    expect(d(4423, 1)).toBe(36000);
    expect(d(4423, 0.5)).toBe(30000);
    expect(d(4423, 0.75)).toBeGreaterThan(30000);
    for (const code of [4429, 4430]) { expect(d(code, 0)).toBe(60000); expect(d(code, 1)).toBe(72000); }
  });

  it("4425 waits until the window opens", () => {
    const early = { from: "2026-10-23T01:00:00Z", to: "2026-10-23T02:00:00Z" };
    // the server opens 2 minutes before window.from
    expect(plan(4425, 0, now, early, 0).delayMs).toBe(Date.parse(early.from) - 120000 - now);
    // window not known yet (the link carries only room and key): at least 30 s
    expect(plan(4425, 0, now, null, 0).delayMs).toBe(30000);
  });

  it("network errors back off 1–30 s and only inside the window", () => {
    const d = (a) => plan(1006, a, now, win, 0.5).delayMs;
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(d)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(BACKOFF[BACKOFF.length - 1]).toBe(30000);
    const late = Date.parse(win.to) + 120000 - 500;
    expect(plan(1006, 0, late, win)).toMatchObject({ retry: false, reason: "window_over" });
    expect(plan(4423, 0, Date.parse(win.to) + 100000, win)).toMatchObject({ retry: false, reason: "window_over" });
    // without a known window, a few attempts and then a manual retry
    expect(plan(1006, MAX_BLIND_ATTEMPTS - 1, now, null).retry).toBe(true);
    expect(plan(1006, MAX_BLIND_ATTEMPTS, now, null)).toMatchObject({ retry: false, reason: "network", manual: true });
  });
});

describe("join page: client core", () => {
  it("connects only after Join, and the only URL it ever opens is the learner WebSocket", async () => {
    const socks = [];
    const { client, events } = makeClient({ WebSocket: fakeSocketClass(socks) });
    expect(client.snapshot().state).toBe("idle");
    expect(socks).toHaveLength(0);
    client.join();
    expect(socks).toHaveLength(1);
    const u = new URL(socks[0].url);
    expect(u.protocol).toBe("wss:");
    expect(u.host).toBe("live.test");
    expect(u.pathname).toBe("/ws");
    expect([...u.searchParams.keys()]).toEqual(["room", "key", "pid"]);
    expect(events[events.length - 1].s.state).toBe("connecting");
  });

  it("keeps one random pid per room, in localStorage or in memory when storage throws", () => {
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
    const s = makeStore(throwing);
    s.set("a", "1");
    expect(s.get("a")).toBe("1");
    const { client } = makeClient({ WebSocket: fakeSocketClass([]), localStorage: throwing });
    const p = client.pid();
    expect(p).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(client.pid()).toBe(p);
  });

  it("4440 stops for good: no timer, no reconnect, no manual retry", () => {
    const socks = [];
    const { client, clock } = makeClient({ WebSocket: fakeSocketClass(socks) });
    client.join();
    socks[0].open();
    socks[0].recv(welcome(clock));
    socks[0].closeWith(4440);
    const s = client.snapshot();
    expect(s).toMatchObject({ state: "stopped", reason: "key_replaced", manual: false });
    expect(clock.pending()).toEqual([]);
    clock.advance(3600_000);
    expect(socks).toHaveLength(1);
  });

  it("4441 stops and offers a manual retry", () => {
    const socks = [];
    const { client, clock } = makeClient({ WebSocket: fakeSocketClass(socks) });
    client.join();
    socks[0].open();
    socks[0].recv(welcome(clock, "waiting"));
    socks[0].closeWith(4441);
    expect(client.snapshot()).toMatchObject({ state: "stopped", reason: "not_approved", manual: true });
    clock.advance(600_000);
    expect(socks).toHaveLength(1);
    client.join();   // the learner taps "Try again"
    expect(socks).toHaveLength(2);
  });

  it("4423 reconnects after at least 30 s, to the same URL", () => {
    const socks = [];
    const { client, clock } = makeClient({ WebSocket: fakeSocketClass(socks), random: () => 0.9 });
    client.join();
    socks[0].open();
    socks[0].recv(welcome(clock));
    socks[0].closeWith(4423);
    const s = client.snapshot();
    expect(s.state).toBe("retrying");
    expect(s.reason).toBe("room_closed");
    expect(s.retryInMs).toBeGreaterThanOrEqual(30000);
    expect(s.retryInMs).toBeLessThanOrEqual(36000);
    clock.advance(29_999);
    expect(socks).toHaveLength(1);
    clock.advance(s.retryInMs);
    expect(socks).toHaveLength(2);
    expect(socks[1].url).toBe(socks[0].url);
    expect(client.snapshot().state).toBe("connecting");
  });

  it("Disconnect closes the socket and cancels a pending retry", () => {
    const socks = [];
    const { client, clock } = makeClient({ WebSocket: fakeSocketClass(socks) });
    client.join();
    socks[0].closeWith(1006);
    expect(client.snapshot().state).toBe("retrying");
    client.leave();
    expect(client.snapshot().state).toBe("left");
    clock.advance(60_000);
    expect(socks).toHaveLength(1);
  });

  it("shows all declared polls with their step keys; Q&A under * sends step *", () => {
    const v = viewOf({
      "*": [{ id: "qa", kind: "qa" }],
      "s-k3f9q2:2": [{ id: "p1", kind: "poll", prompt: "学習率を大きくすると？", choices: ["速く収束", "発散しうる", "変わらない"] }],
      "s-x:1": [{ id: "p2", kind: "poll", choices: ["a", "b"] }, { id: "p3", kind: "poll" }],
    }, true);
    expect(v.qa).toEqual({ id: "qa", step: "*" });
    expect(v.polls.map((p) => [p.id, p.step])).toEqual([["p1", "s-k3f9q2:2"], ["p2", "s-x:1"]]);   // p3 has no choices
    expect(viewOf({}, false).qa).toEqual({ id: "qa", step: "*" });   // no activities set: the room accepts any id
    expect(viewOf({ "s:1": [{ id: "p", kind: "poll", choices: ["a", "b"] }] }, true).qa).toBeNull();
  });
});

describe("join page: against a live room", () => {
  const activities = { "*": [{ id: "qa", kind: "qa" }], "s-k3f9q2:2": [{ id: "p1", kind: "poll", prompt: "Q?", choices: ["a", "b", "c"] }] };
  const realDeps = (urls) => ({
    WebSocket: workerSocketClass(urls), random: Math.random, now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id),
  });

  it("join → activities → ask → ack, vote → ack, shown questions; only the WebSocket URL carries the key", async () => {
    const r = await createRoom({ activities });
    const t = await joinTeacher(r);
    const urls = [];
    const { client, events } = makeClient({ room: r.room, key: r.key, ...realDeps(urls) });
    client.join();
    let s = await waitFor(events, (x) => x.state === "connected" && x.view.polls.length === 1);
    expect(s.view.qa).toEqual({ id: "qa", step: "*" });
    expect(s.view.polls[0]).toMatchObject({ id: "p1", step: "s-k3f9q2:2", prompt: "Q?", choices: ["a", "b", "c"] });
    expect(s.window).toEqual(r.window);

    client.ask("What is a gradient?");
    await waitFor(events, (_, ev) => ev.some((e) => e.ev && e.ev.type === "ack" && e.ev.kind === "ask"));
    const { item } = await t.next("item");
    expect(item).toMatchObject({ text: "What is a gradient?", activity: "qa", step: "*" });

    expect(client.vote("p1", 2)).toBe(true);   // a 0-based index
    s = await waitFor(events, (x) => x.votes.p1 && x.votes.p1.ok);
    expect(s.votes.p1).toEqual({ choice: 2, ok: true });
    const tally = await t.next("tally");
    expect(tally.counts).toEqual([0, 0, 1]);

    t.send({ v: 1, t: "mark", item: item.id, shown: true });
    s = await waitFor(events, (x) => x.shown.length === 1);
    expect(s.shown[0].text).toBe("What is a gradient?");

    // the teacher changes the activities: the page gets them again
    t.send({ v: 1, t: "activities", activities: { ...activities, "s:3": [{ id: "p2", kind: "poll", prompt: "R?", choices: ["x", "y"] }] } });
    s = await waitFor(events, (x) => x.view.polls.length === 2);
    expect(s.view.polls.map((p) => p.id)).toEqual(["p1", "p2"]);

    // the page sent only what the protocol allows learners to send
    const sock = client.ws;
    expect([...new Set(sock.sent.map((m) => m.t))].sort()).toEqual(["activities", "ask", "vote"]);
    for (const m of sock.sent) expect(validate(m, "learnerToServer"), JSON.stringify(m)).toEqual([]);
    // exactly one URL was ever requested, and it is the learner WebSocket
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("wss://live.test/ws");
    expect(u.searchParams.get("key")).toBe(r.key);
    client.leave();
    t.close();
  });

  it("waiting → admitted: the name may be sent while waiting; the page then gets the activities", async () => {
    const r = await createRoom({ activities, requireApproval: true });
    const t = await joinTeacher(r);
    const urls = [];
    const { client, events } = makeClient({ room: r.room, key: r.key, ...realDeps(urls) });
    client.setName("Aiko");
    client.join();
    let s = await waitFor(events, (x) => x.state === "waiting");
    expect(s.admitted).toBe(false);
    expect(s.view.polls).toEqual([]);
    const people = await t.next("people", (m) => m.waiting.some((w) => w.name === "Aiko"));
    const pid = people.waiting.find((w) => w.name === "Aiko").pid;
    t.send({ v: 1, t: "admit", pid });
    s = await waitFor(events, (x) => x.state === "connected" && x.view.polls.length === 1);
    expect(s.admitted).toBe(true);
    client.leave();
    t.close();
  });

  it("4440 after rekey stops the page; a room that closes makes it retry", async () => {
    const r = await createRoom({ activities });
    const t = await joinTeacher(r);
    const a = makeClient({ room: r.room, key: r.key, ...realDeps([]) });
    a.client.join();
    await waitFor(a.events, (x) => x.state === "connected");
    t.send({ v: 1, t: "close" });
    let s = await waitFor(a.events, (x) => x.state === "retrying");
    expect(s.code).toBe(4423);
    expect(s.retryInMs).toBeGreaterThanOrEqual(29000);
    a.client.leave();
    t.send({ v: 1, t: "open" });
    await t.next("state", (m) => m.open === true);
    const b = makeClient({ room: r.room, key: r.key, ...realDeps([]) });
    b.client.join();
    await waitFor(b.events, (x) => x.state === "connected");
    t.send({ v: 1, t: "rekey" });
    s = await waitFor(b.events, (x) => x.state === "stopped");
    expect(s).toMatchObject({ reason: "key_replaced", manual: false, code: 4440 });
    t.close();
  });

  it("asking for activities before admission is refused, and the reply validates against the schema", async () => {
    const r = await createRoom({ activities, requireApproval: true });
    const t = await joinTeacher(r);
    const socks = [];
    const { client, events } = makeClient({ room: r.room, key: r.key, ...realDeps([]), WebSocket: (() => {
      const C = workerSocketClass([]);
      return class extends C { constructor(u) { super(u); socks.push(this); } };
    })() });
    client.join();
    await waitFor(events, (x) => x.state === "waiting");
    client.request({ t: "activities" }, { kind: "activities" });
    await waitFor(events, (_, ev) => ev.some((e) => e.ev && e.ev.type === "error" && e.ev.code === "not_admitted"));
    const people = await t.next("people", (m) => m.waiting.length === 1);
    let got = null;
    const orig = client.onMessage.bind(client);
    client.onMessage = (raw) => { const m = JSON.parse(raw); if (m.t === "activities") got = m; orig(raw); };
    t.send({ v: 1, t: "admit", pid: people.waiting[0].pid });
    await waitFor(events, (x) => x.view.polls.length === 1);
    expect(validate(got, "serverToLearner")).toEqual([]);
    expect(got).toMatchObject({ declared: true, activities });
    expect(socks).toHaveLength(1);
    client.leave();
    t.close();
  });
});

describe("activity labels on the join and teacher pages", () => {
  it("stepText shows the label; without one, * is the whole lesson and <slide>:<k> is 'slide · step k+1'", () => {
    expect(stepText("s-cjatth:0", "4 枚目『XML の壁』・ステップ 1", "ja")).toBe("4 枚目『XML の壁』・ステップ 1");
    expect(stepText("s-cjatth:0", "Slide 4 'XML の壁', step 1", "en")).toBe("Slide 4 'XML の壁', step 1");
    expect(stepText("s-cjatth:0", undefined, "ja")).toBe("s-cjatth · ステップ 1");
    expect(stepText("s-cjatth:0", "", "en")).toBe("s-cjatth · step 1");
    expect(stepText("s-cjatth:concl", null, "ja")).toBe("s-cjatth · ステップ concl");
    expect(stepText("*", undefined, "ja")).toBe("教材全体");
    expect(stepText("*", undefined, "en")).toBe("whole lesson");
    expect(stepText("a:b:2", undefined, "en")).toBe("a:b · step 3");
  });
  it("viewOf passes each poll's label through; older polls without one have none", () => {
    const v = viewOf({
      "s-cjatth:0": [{ id: "p1", kind: "poll", prompt: "Q?", choices: ["a", "b"], label: "4 枚目『XML の壁』・ステップ 1" }],
      "s-old:1": [{ id: "p2", kind: "poll", prompt: "Old?", choices: ["a", "b"] }],
    }, true);
    expect(v.polls.map((p) => [p.id, p.label])).toEqual([["p1", "4 枚目『XML の壁』・ステップ 1"], ["p2", undefined]]);
    expect(v.polls.map((p) => stepText(p.step, p.label, "ja"))).toEqual(["4 枚目『XML の壁』・ステップ 1", "s-old · ステップ 2"]);
  });
  it("both pages render the step with stepText as text (textContent), with the key in a title tooltip", async () => {
    const join = await (await SELF.fetch(ORIGIN + "/join.js")).text();
    expect(join).toContain('h("span", "step", `${t("stepPrefix")}${stepText(p.step, p.label, lang)}`)');
    expect(join).toContain('stepPrefix: "場所："');   // the label already says ステップ: no 「ステップ: …ステップ 1」
    expect(join).toContain("st.title = p.step;");
    expect(join).not.toMatch(/innerHTML|insertAdjacentHTML/);
    const teacher = await (await SELF.fetch(ORIGIN + "/teacher.js")).text();
    expect(teacher).toContain('import { joinUrl, stepText } from "/join-core.js"');
    expect(teacher).toContain('el("p", { class: "poll-step muted", title: `${d.step} · ${id}`, text: stepText(d.step, d.label, lang) })');
    expect(teacher).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
});

describe("questions on the join page: I don't follow, replies", () => {
  const activities = { "*": [{ id: "qa", kind: "qa" }, { id: "cf", kind: "confused" }] };
  const realDeps = (urls) => ({
    WebSocket: workerSocketClass(urls), random: Math.random, now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id),
  });

  it("viewOf offers a confused activity declared for the whole lesson (this page has no step on screen)", () => {
    expect(viewOf(activities, true).confused).toEqual({ id: "cf", step: "*" });
    expect(viewOf({ "s:1": [{ id: "cf", kind: "confused" }] }, true).confused).toBeNull();
    // no activities set: questions go to "qa", but no "I don't follow" is offered (the room does not infer one)
    expect(viewOf({}, false)).toEqual({ qa: { id: "qa", step: "*" }, confused: null, polls: [] });
    expect(viewOf({ "*": [{ id: "qa", kind: "qa" }] }, true).confused).toBeNull();
    // before the room has said which activities it has, nothing is offered
    expect(viewOf({}, null)).toEqual({ qa: null, confused: null, polls: [] });
    expect(viewOf(activities, undefined)).toEqual({ qa: null, confused: null, polls: [] });
  });

  it("offers わからない only after the room declared a confused activity; a tap before the activities arrive sends nothing", () => {
    const socks = [];
    const { client, clock } = makeClient({ WebSocket: fakeSocketClass(socks) });
    client.join();
    socks[0].open();
    socks[0].recv(welcome(clock));
    expect(client.snapshot().view.confused).toBeNull();
    expect(client.snapshot().view.qa).toBeNull();
    expect(client.confused()).toBe(false);
    expect(socks[0].sent.filter((m) => m.t === "confused")).toEqual([]);
    // a room without activities: questions, but no わからない
    const req = socks[0].sent.find((m) => m.t === "activities");
    socks[0].recv({ t: "activities", ref: req.ref, activities: {}, declared: false });
    expect(client.snapshot().view.confused).toBeNull();
    expect(client.snapshot().view.qa).toEqual({ id: "qa", step: "*" });
    expect(client.confused()).toBe(false);
    // the teacher declares one: now it is offered and sent with the declared id and step "*"
    socks[0].recv({ t: "activities", activities, declared: true });
    expect(client.snapshot().view.confused).toEqual({ id: "cf", step: "*" });
    expect(client.confused()).toBe(true);
    expect(socks[0].sent.filter((m) => m.t === "confused")).toMatchObject([{ activity: "cf", step: "*", on: true }]);
    // after a reconnect nothing is offered until the room answers again
    socks[0].closeWith(1006);
    clock.advance(60_000);
    socks[1].open();
    socks[1].recv(welcome(clock));
    expect(client.snapshot().view.confused).toBeNull();
  });

  it("a room with no activities: the page connects with questions but without わからない", async () => {
    const r = await createRoom();
    const { client, events } = makeClient({ room: r.room, key: r.key, ...realDeps([]) });
    client.join();
    const s = await waitFor(events, (_, ev) => ev.some((e) => e.ev && e.ev.type === "activities"));
    expect(s.state).toBe("connected");
    expect(s.view).toEqual({ qa: { id: "qa", step: "*" }, confused: null, polls: [] });
    expect(client.confused()).toBe(false);
    client.leave();
  });

  it("join.js shows the わからない box only when the view offers it", async () => {
    const join = await (await SELF.fetch(ORIGIN + "/join.js")).text();
    expect(join).toContain('$("confused-box").hidden = !(s.admitted && view.confused);');
    const html = await (await SELF.fetch(ORIGIN + "/join")).text();
    expect(html).toContain('<div id="confused-box" class="card" hidden>');
  });

  it("a tap marks, another takes it back; the host's reply reaches only this page, and again after a reload", async () => {
    const r = await createRoom({ activities });
    const t = await joinTeacher(r);
    const urls = [], urls2 = [];
    const { client, events } = makeClient({ room: r.room, key: r.key, ...realDeps(urls) });
    const other = makeClient({ room: r.room, key: r.key, ...realDeps(urls2) });
    client.join(); other.client.join();
    // wait for the room's activities (the view offers わからない only once they have arrived)
    let s = await waitFor(events, (x) => x.state === "connected" && !!x.view.confused && x.view.confused.id === "cf");
    await waitFor(other.events, (x) => x.state === "connected" && !!x.view.confused);
    expect(client.confused()).toBe(true);
    await waitFor(events, (_, ev) => ev.some((e) => e.ev && e.ev.type === "ack" && e.ev.kind === "confused"));
    expect((await t.next("confused")).count).toBe(1);
    expect(client.snapshot().confused).toBe(true);
    client.confused();
    expect((await t.next("confused")).count).toBe(0);
    expect(client.snapshot().confused).toBe(false);

    client.ask("Why?");
    const { item } = await t.next("item");
    t.send({ v: 1, t: "reply", item: item.id, text: "Because." });
    s = await waitFor(events, (x) => x.replies.length === 1);
    expect(s.replies[0]).toMatchObject({ item: item.id, question: "Why?", text: "Because.", public: false });
    // the other learner gets nothing
    await new Promise((res) => setTimeout(res, 100));
    expect(other.client.snapshot().replies).toEqual([]);
    expect(other.client.snapshot().shown).toEqual([]);
    // public: everyone sees the question with the reply
    t.send({ v: 1, t: "reply", item: item.id, text: "Because, for all.", public: true });
    const so = await waitFor(other.events, (x) => x.shown.length === 1);
    expect(so.shown[0]).toMatchObject({ text: "Why?", reply: "Because, for all." });
    // after a reload (same pid in localStorage) the reply is there again
    const pid = client.pid();
    client.leave();
    const again = makeClient({ room: r.room, key: r.key, ...realDeps([]) });
    again.client.local.set("egatari-live-pid:" + r.room, pid);
    again.client.join();
    s = await waitFor(again.events, (x) => x.state === "connected" && x.replies.length === 1);
    expect(s.replies[0].text).toBe("Because, for all.");
    for (const m of client.ws ? client.ws.sent : []) expect(validate(m, "learnerToServer")).toEqual([]);
    again.client.leave(); other.client.leave();
    t.close();
  });

  it("both pages show replies and questions as text only, with labelled controls", async () => {
    const html = await (await SELF.fetch(ORIGIN + "/join")).text();
    expect(html).toContain('id="confused" class="confused" aria-pressed="false"');
    const join = await (await SELF.fetch(ORIGIN + "/join.js")).text();
    expect(join).toContain('confused: "わからない"');
    expect(join).not.toMatch(/innerHTML|insertAdjacentHTML/);
    const teacher = await (await SELF.fetch(ORIGIN + "/teacher.js")).text();
    expect(teacher).toContain('"aria-label": t("reply")');
    expect(teacher).toContain('replyAll: "参加者全員にも見せる"');
    expect(teacher).not.toMatch(/innerHTML|insertAdjacentHTML/);
    const room = await (await SELF.fetch(ORIGIN + "/room")).text();
    expect(room).toContain('id="btn-group"');
    expect(room).toContain('id="confused"');
  });
});
