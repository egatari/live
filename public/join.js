// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live learner join page (/join#room=…&key=…): for devices that cannot connect from the lesson file.
// Draws the DOM for the core in /join-core.js. Every server-provided string is shown with textContent.
import { JoinClient, parseFragment, LIMITS, stepText } from "/join-core.js";

const HOST = location.host;
const T = {
  ja: {
    notice: `この教材は ${HOST} の授業の部屋につながります`, roomLabel: "部屋：", join: "参加する", again: "もう一度試す", leave: "切断する",
    badLink: "参加用のリンクが正しくありません。先生からもらったリンクを、そのまま開いてください。",
    idle: "つないでいません", connecting: "つないでいます…", connected: "つながっています", waiting: "先生の承認を待っています",
    waitingLong: "先生の承認を待っています。このままお待ちください（名前を入れると、先生が見分けやすくなります）。",
    retrying: (s) => `${s} 秒後につなぎ直します`, left: "切断しました。もう一度参加できます",
    name: "名前（任意）", nameNote: "入れたときだけ先生に見えます。", ask: "質問", send: "送る", sent: "質問を送りました",
    shown: "画面に映された質問", polls: "投票", pollsNote: "部屋にあるすべての投票です。先生が指示した投票に答えてください。",
    step: "段階", vote: "投票する", voted: "投票しました（選び直せます）",
    privacy: "送るのは、送ると決めた質問と投票（と入れたときの名前）、この端末で作った番号だけです。",
    footer: "Egatari Live（Egatari Studio の一部）。アカウントも利用状況の記録もありません。",
    stop: {
      bad_key: "このリンクの鍵では部屋に入れません。先生に新しいリンクをもらってください", room_not_found: "部屋が見つかりません（期限で消えた可能性があります）",
      superseded: "ほかのタブや端末で参加したので、ここは切れました", room_expired: "部屋の時間が終わりました",
      room_closed: "先生が部屋を閉じています。開いたらつなぎ直します", too_early: "部屋はまだ開いていません（この端末の時計も確かめてください）。開いたらつなぎ直します",
      rate_limited: "送るのが速すぎました。少し待ってからつなぎ直します", room_full: "部屋が満員です。少し待ってからつなぎ直します",
      key_replaced: "先生が参加の鍵を替えました。このリンクでは入れません。新しいリンクをもらってください",
      not_approved: "先生が参加を認めませんでした", bad_message: "通信の約束が合いません（サーバーの不具合）", unauthorized: "部屋から切断されました",
      window_over: "授業の部屋の時間は終わりました", unknown: "部屋から切断されました", network: "つなげませんでした。通信を確かめてください",
      bad_link: "参加用のリンクが正しくありません",
    },
    err: {
      unknown_activity: "この活動は部屋にありません", wrong_kind: "活動の種類が違います", bad_choice: "選択肢がありません", text_too_long: "質問が長すぎます",
      empty_text: "質問が空です", rate_limited: "送るのが速すぎます。少し待ってください", quota_exceeded: "送れる質問の数を超えました",
      room_limit: "部屋がいっぱいです", not_admitted: "先生の承認を待っています", other: "送れませんでした",
    },
  },
  en: {
    notice: `This lesson connects to a live room at ${HOST}`, roomLabel: "Room:", join: "Join", again: "Try again", leave: "Disconnect",
    badLink: "This join link is not valid. Open the link your teacher gave you exactly as it is.",
    idle: "Not connected", connecting: "Connecting…", connected: "Connected", waiting: "Waiting for the teacher to admit you",
    waitingLong: "Waiting for the teacher to admit you. Please stay on this page (typing a name helps the teacher recognise you).",
    retrying: (s) => `Reconnecting in ${s} s`, left: "Disconnected. You can join again",
    name: "Name (optional)", nameNote: "The teacher sees it only if you type one.", ask: "Question", send: "Send", sent: "Question sent",
    shown: "Questions on screen", polls: "Polls", pollsNote: "All polls in this room. Answer the one your teacher asks for.",
    step: "Step", vote: "Vote", voted: "Vote recorded (you can change it)",
    privacy: "Only what you choose to send (questions, votes, and a name if you type one) and a random id made on this device are sent.",
    footer: "Egatari Live, part of Egatari Studio. No accounts, no telemetry.",
    stop: {
      bad_key: "This link's key does not open the room. Ask your teacher for a new link", room_not_found: "The room does not exist (it may have expired)",
      superseded: "You joined in another tab or device, so this one was disconnected", room_expired: "The room's time is over",
      room_closed: "The teacher has closed the room. Reconnecting when it reopens", too_early: "The room is not open yet (also check this device's clock). Reconnecting when it opens",
      rate_limited: "Too many messages. Reconnecting after a short wait", room_full: "The room is full. Reconnecting after a short wait",
      key_replaced: "The teacher replaced the key: this link no longer works. Ask for a new link",
      not_approved: "The teacher did not admit you", bad_message: "Protocol mismatch (a server bug)", unauthorized: "Disconnected by the room",
      window_over: "The live room has ended", unknown: "Disconnected by the room", network: "Could not connect. Check your connection",
      bad_link: "This join link is not valid",
    },
    err: {
      unknown_activity: "This activity is not in the room", wrong_kind: "Wrong kind of activity", bad_choice: "No such choice", text_too_long: "The question is too long",
      empty_text: "The question is empty", rate_limited: "Sending too fast. Wait a moment", quota_exceeded: "You have sent the maximum number of questions",
      room_limit: "The room is full", not_admitted: "Waiting for the teacher to admit you", other: "Could not send",
    },
  },
};

let lang = "ja";
try { const s = localStorage.getItem("egatari-live-lang"); lang = s === "ja" || s === "en" ? s : null; } catch { lang = null; }
if (!lang) lang = /^ja\b/i.test(navigator.language || "") ? "ja" : "en";
const t = (k) => T[lang][k];
const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let snap = null, client = null, msg = "", lastStep = null;
function announce(s) { $("sr").textContent = ""; setTimeout(() => { $("sr").textContent = s; }, 30); }

function applyLang() {
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  $("lang").textContent = lang === "ja" ? "English" : "日本語";
  $("notice").textContent = t("notice");
  $("polls").removeAttribute("data-sig");
  render();
}

function barText(s) {
  if (s.state === "retrying") return `${t("stop")[s.reason] || t("stop").network} · ${t("retrying")(Math.max(1, Math.ceil(s.retryInMs / 1000)))}`;
  if (s.state === "stopped") return t("stop")[s.reason] || t("stop").unknown;
  if (s.state === "left") return t("left");
  return t(s.state) || t("idle");
}

function render() {
  if (!client) return;
  const s = snap || client.snapshot();
  const on = s.state === "connected" || s.state === "waiting";
  const busy = on || s.state === "connecting" || s.state === "retrying";
  // Before the first tap (and after a final stop) the notice and the Join button; once joined, the live view.
  $("intro").hidden = busy;
  $("live").hidden = !busy;
  // The persistent indicator (with Disconnect) while joined; a stop or a disconnect is explained in the card.
  $("bar").hidden = !busy;
  $("bar").dataset.state = s.state;
  $("bar-text").textContent = barText(s);
  $("leave").hidden = !busy;
  const canJoin = s.state === "idle" || s.state === "left" || (s.state === "stopped" && s.manual);
  $("join").hidden = !canJoin;
  $("join").textContent = s.state === "stopped" ? t("again") : t("join");
  $("stop-msg").textContent = s.state === "stopped" || s.state === "left" ? barText(s) : "";
  $("wait-msg").hidden = s.state !== "waiting";
  $("live-msg").textContent = msg;

  const view = s.view;
  $("qa").hidden = !(s.admitted && view.qa);
  $("send").disabled = !s.admitted;
  $("shown-box").hidden = !(s.admitted && s.shown.length);
  $("shown").replaceChildren(...s.shown.map((it) => h("li", "", it.text)));
  renderPolls(s.admitted ? view.polls : [], s.votes);
}

function renderPolls(polls, votes) {
  const box = $("polls");
  $("polls-box").hidden = !polls.length;
  const sig = polls.map((p) => `${p.step}/${p.id}/${p.choices.length}/${p.label || ""}`).join("|");
  if (box.getAttribute("data-sig") !== sig) {
    box.setAttribute("data-sig", sig);
    box.replaceChildren(...polls.map((p) => {
      const fs = h("fieldset"); fs.dataset.poll = p.id;
      fs.append(h("legend", "", p.prompt || p.id));
      const st = h("span", "step", `${t("step")}: ${stepText(p.step, p.label, lang)}`);
      st.title = p.step;   // the key itself, for the teacher's eye
      fs.append(st);
      p.choices.forEach((c, j) => {
        const l = h("label", "choice"), r = document.createElement("input");
        r.type = "radio"; r.name = "poll-" + p.id; r.value = String(j);
        l.append(r, h("span", "", c));
        fs.append(l);
      });
      const row = h("div", "row"), b = h("button", "", t("vote")), note = h("span", "note small-text voted");
      b.type = "button";
      b.addEventListener("click", () => {
        const sel = fs.querySelector("input:checked");
        if (sel) client.vote(p.id, Number(sel.value));   // a 0-based index
      });
      row.append(b, note); fs.append(row);
      return fs;
    }));
  }
  for (const p of polls) {
    const fs = box.querySelector(`fieldset[data-poll="${CSS.escape(p.id)}"]`);
    if (!fs) continue;
    const v = votes[p.id];
    if (v && v.ok) { const r = fs.querySelector(`input[value="${v.choice}"]`); if (r && !fs.querySelector("input:checked")) r.checked = true; }
    fs.querySelector(".note").textContent = v && v.ok ? t("voted") : "";
  }
}

function onChange(s, ev) {
  snap = s;
  if (ev) {
    if (ev.type === "error") { msg = t("err")[ev.code] || t("err").other; announce(msg); }
    else if (ev.type === "ack" && ev.kind === "ask") { $("question").value = ""; msg = ""; $("qa-note").textContent = t("sent"); announce(t("sent")); }
    else if (ev.type === "ack" && ev.kind === "vote") { msg = ""; announce(t("voted")); }
    else if (ev.type === "admitted" || ev.type === "waiting") { msg = ""; announce(t(ev.type === "admitted" ? "connected" : "waiting")); }
    else if (ev.type === "closed" && s.state === "stopped") announce(barText(s));
  }
  if (s.state !== lastStep) { lastStep = s.state; if (s.state === "connected") $("qa-note").textContent = ""; }
  render();
}

document.addEventListener("DOMContentLoaded", () => {
  $("lang").addEventListener("click", () => {
    lang = lang === "ja" ? "en" : "ja";
    try { localStorage.setItem("egatari-live-lang", lang); } catch { /* storage blocked */ }
    applyLang();
  });
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  $("lang").textContent = lang === "ja" ? "English" : "日本語";
  $("notice").textContent = t("notice");

  const link = parseFragment(location.hash);
  if (!link) { $("bad-link").hidden = false; return; }
  let ls = null, ss = null;
  try { ls = window.localStorage; } catch { /* blocked */ }
  try { ss = window.sessionStorage; } catch { /* blocked */ }
  client = new JoinClient({
    origin: location.origin, room: link.room, key: link.key, WebSocket: window.WebSocket,
    localStorage: ls, sessionStorage: ss, crypto: window.crypto, now: () => Date.now(), random: Math.random,
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id), onChange,
  });
  $("room-id").textContent = link.room;
  $("intro").hidden = false;
  $("name").maxLength = LIMITS.name;
  $("question").maxLength = LIMITS.question;
  $("join").addEventListener("click", () => { msg = ""; client.join(); });
  $("leave").addEventListener("click", () => { msg = ""; client.leave(); });
  $("send").addEventListener("click", () => { msg = ""; $("qa-note").textContent = ""; client.ask($("question").value); });
  $("question").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("send").click(); } });
  $("name").addEventListener("change", () => client.setName($("name").value));
  // A countdown while retrying
  setInterval(() => { if (snap && snap.state === "retrying") { snap = client.snapshot(); render(); } }, 1000);
  render();
  // Joined in this tab before (a reload): reconnect without another tap.
  if (client.joinedBefore()) client.join();
});
