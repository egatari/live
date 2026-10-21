// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live teacher page. Plain JS, no framework. Every learner-provided string is shown with textContent.
import { joinUrl, stepText } from "/join-core.js";
import { shareText } from "/join-core.js";

(function () {
  const T = {
    en: {
      createTitle: "Create a Live (questions and polls in class)",
      createIntro: "During the live time, participants send questions and votes from the lesson file you hand out (or the join link). The Live and its results are deleted automatically once the time to keep results after the Live ends has passed.",
      from: "Live starts", to: "Live ends", grace: "Keep results after the Live ends (hours, max 168)", requireApproval: "Use a waiting room (only people the teacher admits can join)",
      activitiesOpt: "Poll settings (optional; the JSON copied in Egatari Studio's Distribute with Live (questions and polls); may be left empty)",
      createBtn: "Create Live",
      createdTitle: "Live created: bookmark this page now",
      createdWarn: "The teacher link below controls this Live. It is shown only once and cannot be shown again. Anyone with this link can control the Live, so do not give it to participants. If you lose it, create a new Live.",
      copyLink: "Copy teacher link", room: "Live ID", window: "Live time", deletedAt: "deleted at",
      openBtn: "Reopen Live", closeBtn: "End Live", download: "Download results (JSON)",
      forEditor: "Settings to paste into Egatari Studio", forEditorHelp: "Paste this in Egatari Studio under Export ▾ → Distribute with Live (questions and polls)…. It contains the join code, not your teacher link.",
      copySnippet: "Copy", rekey: "Change join code",
      rekeyConfirm: "Change the join code? Everyone who has joined is disconnected, and files and join links made before stop working. You will need to export the lesson again.",
      rekeyed: "The join code was changed. Paste the settings above into Egatari Studio again and export the lesson again.",
      joinLink: "Join link", copyJoin: "Copy join link",
      shareTitle: "Text to share", copyShare: "Copy text",
      shareHelp: "A message to paste where you hand out the lesson (LMS, mail, chat), with the file attached: computers open the file, phones and tablets open the join link.",
      joinLinkHelp: "For participants whose device cannot join from the lesson file (for example a link opened inside a chat app, or a file viewer): they open this link in a browser. It contains the join code (after #, never sent to the server as part of the address), not your teacher link. Anyone with it can join during the Live, and once admitted can read the poll questions and choices.",
      joinRekeyed: "The join code was changed: join links shared before no longer work. Share the new link above.",
      waiting: "Waiting room", admitAll: "Admit all", admit: "Admit", deny: "Decline",
      questions: "Questions", showHidden: "Show hidden questions",
      read: "read", answered: "answered", shown: "show to everyone", hidden: "hidden",
      polls: "Polls", noPolls: "No votes yet.", noItems: "No questions yet.", noWaiting: "Nobody is waiting.",
      votes: "votes", activities: "Poll settings", activitiesHelp: "The poll questions and choices (JSON). The Live accepts only the questions and polls listed here; leave it empty to accept any id.",
      setActivities: "Save poll settings",
      open: "live", closed: "ended", connected: "joined",
      sConnecting: "Connecting…", sConnected: "Live", sLost: "Connection lost. Reconnecting…",
      sUnauthorized: "This teacher key is not valid for this room.", sNotFound: "This room does not exist (it may have expired).",
      sExpired: "This room has expired and was deleted.",
      anonymous: "(no name)", at: "at",
      footer: "Egatari Live, part of Egatari Studio. No accounts, no telemetry; rooms are deleted after their grace period.",
      badJson: "Activities is not valid JSON.",
      size: "Expected learners (max 60)", bookmarked: "I have bookmarked it",
      turnstileDev: "Development mode: no Turnstile site key is set, so a test token is sent.",
      turnstileWait: "Please complete the check above first.",
      err_window_too_long: "The live time is at most 3 hours. Change the start and end.", err_room_too_large: "A room holds at most 60 learners.",
      err_rate_limited: "Many rooms are being created from this network right now. Please wait a minute and try again.",
      err_turnstile_failed: "The check failed. Please try again.", err_turnstile_required: "Please complete the check first.",
    },
    ja: {
      createTitle: "ライブを作る（授業中の質問と投票）",
      createIntro: "ライブの時間のあいだ、参加者は配った教材ファイル（または参加用リンク）から質問と投票を送れます。ライブと集まった結果は、ライブの終了から「結果を残す時間」が過ぎると自動で消えます。",
      from: "ライブの開始", to: "ライブの終了", grace: "結果を残す時間（ライブの終了の後。時間単位、最大 168）", requireApproval: "待機室を使う（先生が許可した人だけが参加できる）",
      activitiesOpt: "投票の設定（任意。Egatari Studio の「ライブ（質問・投票）を付けて配る」でコピーした JSON。空のままでかまいません）",
      createBtn: "ライブを作る",
      createdTitle: "ライブができました。このページを今すぐブックマークしてください",
      createdWarn: "下の教員用リンクで、このライブを操作します。表示はこの一度だけで、あとから再表示できません。このリンクを知っている人は誰でもライブを操作できるので、参加者には配らないでください。なくした場合は、ライブを作り直してください。",
      copyLink: "教員用リンクをコピー", room: "ライブ ID", window: "ライブの時間", deletedAt: "消える日時",
      openBtn: "ライブを再開", closeBtn: "ライブを終える", download: "結果をダウンロード（JSON）",
      forEditor: "Egatari Studio に貼る設定", forEditorHelp: "Egatari Studio の「書き出す ▾」→「ライブ（質問・投票）を付けて配る…」の画面に貼ります。入っているのは参加コードで、教員用リンクは入っていません。",
      copySnippet: "コピー", rekey: "参加コードを変更",
      rekeyConfirm: "参加コードを変更しますか？ 今参加している人は全員切断され、これまでに書き出したファイルと参加用リンクでは参加できなくなります。教材を書き出し直す必要があります。",
      rekeyed: "参加コードを変更しました。上の設定を Egatari Studio に貼り直して、教材を書き出し直してください。",
      joinLink: "参加用リンク", copyJoin: "参加用リンクをコピー",
      shareTitle: "配るときの文", copyShare: "文をコピー",
      shareHelp: "教材を配るところ（LMS・メール・チャット）に、ファイルを添えてそのまま貼れる文です。パソコンはファイルを開き、スマートフォンとタブレットは参加用リンクを開きます。",
      joinLinkHelp: "教材ファイルから参加できない端末（チャットのアプリの中で開いたときや、ファイルを見るだけのアプリなど）の人は、このリンクをブラウザで開いて参加します。入っているのは参加コード（# の後ろにあり、アドレスとしてサーバーには送られません）で、教員用リンクは入っていません。ライブ中は、このリンクを持つ人は誰でも参加でき、許可された後は投票の設問と選択肢を読めます。",
      joinRekeyed: "参加コードを変更したので、前に配った参加用リンクは使えなくなりました。上の新しいリンクを配ってください。",
      waiting: "待機室", admitAll: "全員を許可", admit: "許可", deny: "許可しない",
      questions: "質問", showHidden: "隠した質問も表示",
      read: "既読", answered: "回答済み", shown: "全員に表示", hidden: "非表示",
      polls: "投票", noPolls: "まだ投票はありません。", noItems: "まだ質問はありません。", noWaiting: "待っている人はいません。",
      votes: "票", activities: "投票の設定", activitiesHelp: "投票の設問と選択肢の設定（JSON）です。ライブはここにある質問・投票だけを受け付けます。空のままなら、どの質問・投票の id も受け付けます。",
      setActivities: "投票の設定を保存",
      open: "ライブ中", closed: "終了", connected: "人が参加中",
      sConnecting: "接続しています…", sConnected: "接続中", sLost: "接続が切れました。つなぎ直しています…",
      sUnauthorized: "この教員の鍵は、この部屋には使えません。", sNotFound: "この部屋はありません（期限で消えた可能性があります）。",
      sExpired: "この部屋は期限が過ぎ、消えました。",
      anonymous: "（名前なし）", at: "",
      footer: "Egatari Live（Egatari Studio の一部）。アカウントも利用状況の記録もありません。部屋は猶予の時間のあと消えます。",
      badJson: "活動の JSON が正しくありません。",
      size: "参加する人数の見込み（最大 60）", bookmarked: "ブックマークしました",
      turnstileDev: "開発用：Turnstile のサイトキーがないため、試験用のトークンを送ります。",
      turnstileWait: "先に上の確認を済ませてください。",
      err_window_too_long: "ライブの時間は 3 時間までです。開始と終了を直してください。", err_room_too_large: "1 部屋は 60 人までです。",
      err_rate_limited: "同じネットワークから、いま部屋がたくさん作られています。1 分ほど待ってから、もう一度作ってください。",
      err_turnstile_failed: "確認に失敗しました。もう一度お試しください。", err_turnstile_required: "先に確認を済ませてください。",
    },
  };
  let lang = "en";
  let saved = null;
  try { saved = localStorage.getItem("egatari-live-lang"); } catch { /* storage blocked */ }
  lang = saved === "ja" || saved === "en" ? saved : ((navigator.language || "").startsWith("ja") ? "ja" : "en");
  const t = (k) => (T[lang] && T[lang][k]) || T.en[k] || k;
  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  function applyLang() {
    document.documentElement.lang = lang;
    for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
    $("lang").textContent = lang === "ja" ? "English" : "日本語";
    if (S.state) render();
  }

  // ------------------------------------------------------------- state
  const S = { room: null, admin: null, ws: null, state: null, retry: 0, fatal: false, showHidden: false };
  const hash = new URLSearchParams(location.hash.slice(1));
  S.room = hash.get("room");
  S.admin = hash.get("admin");

  function rfc3339(local) {
    const d = new Date(local);
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
  }
  function localInput(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const fmt = (iso) => { try { return new Date(iso).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB"); } catch { return iso; } };
  async function copy(text) { try { await navigator.clipboard.writeText(text); } catch { /* user can select manually */ } }

  // ------------------------------------------------------------- create
  // Turnstile is loaded only here, on the create page; the room page and learners never load it.
  const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";   // Cloudflare's test token, accepted only by test secrets
  const TS = { id: null, token: null };
  function loadTurnstile() {
    const box = $("turnstile"), sitekey = box.dataset.sitekey || "";
    if (!sitekey) { $("turnstile-note").hidden = false; TS.token = DUMMY_TOKEN; return; }
    const sc = document.createElement("script");
    sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    sc.addEventListener("load", () => {
      TS.id = window.turnstile.render(box, {
        sitekey, action: "create-room", language: lang,
        callback: (tok) => { TS.token = tok; },
        "expired-callback": () => { TS.token = null; },
        "error-callback": () => { TS.token = null; },
      });
    });
    document.head.append(sc);
  }
  function resetTurnstile() {
    if (TS.id !== null && window.turnstile) { window.turnstile.reset(TS.id); TS.token = null; }
  }

  function showCreate() {
    $("create").hidden = false;
    loadTurnstile();
    const now = new Date(); now.setSeconds(0, 0);
    $("from").value = localInput(now);
    $("to").value = localInput(new Date(now.getTime() + 2 * 3600 * 1000));
    $("create-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      $("create-error").textContent = "";
      if (!TS.token) { $("create-error").textContent = t("turnstileWait"); return; }
      const body = { v: 1, window: { from: rfc3339($("from").value), to: rfc3339($("to").value) },
        graceHours: Number($("grace").value || 24), requireApproval: $("approval").checked, turnstile: TS.token };
      if ($("size").value) body.size = Number($("size").value);
      const a = $("activities").value.trim();
      if (a) { try { body.activities = JSON.parse(a); } catch { $("create-error").textContent = t("badJson"); return; } }
      const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const known = T.en["err_" + out.error] ? t("err_" + out.error) : null;
        $("create-error").textContent = known || out.message || out.error || String(res.status);
        resetTurnstile();
        return;
      }
      // The teacher key goes only into the fragment of the room page; replace() keeps it out of history here.
      location.replace(`/room#room=${out.room}&admin=${out.adminKey}&new=1`);
    });
  }

  function showCreated() {
    const clean = `${location.origin}/room#room=${S.room}&admin=${S.admin}`;
    history.replaceState(null, "", clean);
    $("created").hidden = false;
    $("teacher-link").href = clean;
    $("teacher-link").textContent = clean;
    $("copy-link").addEventListener("click", () => copy(clean));
    $("dismiss-created").addEventListener("click", () => { $("created").hidden = true; });
  }

  // ------------------------------------------------------------- dashboard
  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ v: 1, ...msg })); }

  function connect() {
    $("s-socket").textContent = t("sConnecting");
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/teacher?room=${encodeURIComponent(S.room)}`);
    S.ws = ws;
    ws.addEventListener("open", () => { ws.send(JSON.stringify({ v: 1, t: "auth", adminKey: S.admin })); });
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      onMessage(m);
    });
    ws.addEventListener("close", (ev) => {
      const fatal = { 4401: "sUnauthorized", 4404: "sNotFound", 4410: "sExpired" }[ev.code];
      if (fatal) { S.fatal = true; $("s-socket").textContent = t(fatal); return; }
      $("s-socket").textContent = t("sLost");
      S.retry = Math.min(S.retry + 1, 6);
      setTimeout(connect, 500 * 2 ** S.retry);
    });
  }

  function onMessage(m) {
    switch (m.t) {
      case "state": S.state = m; S.retry = 0; $("s-socket").textContent = t("sConnected"); render(); break;
      case "people": if (S.state) { S.state.people = { connected: m.connected, waiting: m.waiting }; renderPeople(); } break;
      case "item": if (S.state) {
        const i = S.state.items.findIndex((q) => q.id === m.item.id);
        if (i >= 0) S.state.items[i] = m.item; else S.state.items.push(m.item);
        renderItems();
      } break;
      case "tally": if (S.state) { S.state.tallies[m.activity] = { counts: m.counts, total: m.total }; renderPolls(); } break;
      case "rekeyed": if (S.state) { S.state.key = m.key; $("rekeyed").hidden = false; $("join-rekeyed").hidden = false; renderStatus(); } break;
      case "error": $("dash-error").textContent = m.code + (m.message ? ": " + m.message : ""); break;
    }
  }

  function snippet(st) {
    const live = { v: 1, endpoint: location.origin, room: st.room, key: st.key, window: st.window };
    if (st.activities && Object.keys(st.activities).length) live.activities = st.activities;
    return JSON.stringify(live, null, 2);
  }

  function renderStatus() {
    const st = S.state;
    $("s-room").textContent = st.room;
    $("s-open").textContent = st.open ? t("open") : t("closed");
    $("s-open").className = "badge " + (st.open ? "open" : "closed");
    $("s-window").textContent = `${fmt(st.window.from)} – ${fmt(st.window.to)}`;
    $("s-expires").textContent = fmt(st.expiresAt);
    $("btn-open").disabled = st.open;
    $("btn-close").disabled = !st.open;
    $("chk-approval").checked = st.requireApproval;
    $("snippet").value = snippet(st);
    // Learners' join link: room and the current learner key, in the fragment only.
    const jl = joinUrl(location.origin, st.room, st.key);
    $("join-link").href = jl;
    $("join-link").textContent = jl;
    $("share-text").value = shareText(lang, jl);
    if (document.activeElement !== $("act-edit")) $("act-edit").value = JSON.stringify(st.activities || {}, null, 2);
  }

  function renderPeople() {
    const p = S.state.people;
    $("s-conn").textContent = `${p.connected} ${t("connected")}`;
    $("n-waiting").textContent = `(${p.waiting.length})`;
    $("btn-admit-all").disabled = p.waiting.length === 0;
    const ul = $("waiting");
    ul.replaceChildren(...(p.waiting.length ? p.waiting.map((w) => el("li", {},
      el("span", { text: w.name || t("anonymous") }), " ",
      el("code", { class: "muted", text: w.pid.slice(0, 6) }), " ",
      el("button", { type: "button", class: "small", text: t("admit"), onclick: () => send({ t: "admit", pid: w.pid }) }),
      el("button", { type: "button", class: "small danger", text: t("deny"), onclick: () => send({ t: "deny", pid: w.pid }) }),
    )) : [el("li", { class: "muted", text: t("noWaiting") })]));
  }

  function renderItems() {
    const items = S.state.items.filter((q) => S.showHidden || !q.hidden).slice().reverse();
    $("n-items").textContent = `(${S.state.items.length})`;
    const flag = (q, f) => el("label", { class: "check" },
      el("input", { type: "checkbox", checked: q[f], onchange: (ev) => send({ t: "mark", item: q.id, [f]: ev.target.checked }) }),
      el("span", { text: t(f) }));
    $("items").replaceChildren(...(items.length ? items.map((q) => el("li", {
      class: [q.read && "read", q.hidden && "hidden-item", q.shown && !q.hidden && "shown"].filter(Boolean).join(" "),
    },
      el("p", { class: "q-text", text: q.text }),
      el("div", { class: "q-meta", text: `${q.name || t("anonymous")} · ${q.step} · ${fmt(q.at)}` }),
      el("div", { class: "row" }, flag(q, "read"), flag(q, "answered"), flag(q, "shown"), flag(q, "hidden")),
    )) : [el("li", { class: "muted", text: t("noItems") })]));
  }

  function renderPolls() {
    const st = S.state, box = $("polls");
    const defs = {};
    for (const [step, list] of Object.entries(st.activities || {})) for (const a of list) if (a.kind === "poll") defs[a.id] = { ...a, step };
    const ids = [...new Set([...Object.keys(defs), ...Object.keys(st.tallies || {})])];
    if (!ids.length) { box.replaceChildren(el("p", { class: "muted", text: t("noPolls") })); return; }
    box.replaceChildren(...ids.map((id) => {
      const d = defs[id] || {}, tl = st.tallies[id] || { counts: [], total: 0 };
      const n = Math.max(d.choices ? d.choices.length : 0, tl.counts.length);
      const rows = [];
      for (let i = 0; i < n; i++) {
        const c = tl.counts[i] || 0;
        rows.push(el("div", { class: "poll-row" },
          el("span", { text: d.choices ? d.choices[i] : `#${i + 1}` }),
          el("progress", { max: String(Math.max(tl.total, 1)), value: String(c) }),
          el("span", { text: String(c) })));
      }
      return el("div", { class: "poll" },
        el("p", {}, el("strong", { text: d.prompt || id }), el("span", { class: "muted", text: ` (${tl.total} ${t("votes")})` })),
        // where the poll is: its label (text only), the step key in the tooltip
        d.step ? el("p", { class: "poll-step muted", title: `${d.step} · ${id}`, text: stepText(d.step, d.label, lang) }) : null,
        ...rows);
    }));
  }

  function render() { renderStatus(); renderPeople(); renderItems(); renderPolls(); }

  async function download() {
    const res = await fetch(`/api/rooms/${encodeURIComponent(S.room)}/results`, { headers: { authorization: "Bearer " + S.admin } });
    if (!res.ok) { $("dash-error").textContent = String(res.status); return; }
    const blob = new Blob([await res.text()], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `egatari-live-${S.room}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function startDash() {
    $("dash").hidden = false;
    $("btn-open").addEventListener("click", () => send({ t: "open" }));
    $("btn-close").addEventListener("click", () => send({ t: "close" }));
    $("chk-approval").addEventListener("change", (ev) => send({ t: "approval", required: ev.target.checked }));
    $("btn-rekey").addEventListener("click", () => { if (confirm(t("rekeyConfirm"))) send({ t: "rekey" }); });
    $("btn-admit-all").addEventListener("click", () => send({ t: "admitAll" }));
    $("copy-snippet").addEventListener("click", () => copy($("snippet").value));
    $("copy-join").addEventListener("click", () => copy($("join-link").href));
    $("copy-share").addEventListener("click", () => copy($("share-text").value));
    $("btn-download").addEventListener("click", download);
    $("chk-hidden").addEventListener("change", (ev) => { S.showHidden = ev.target.checked; if (S.state) renderItems(); });
    $("btn-activities").addEventListener("click", () => {
      let a; try { a = JSON.parse($("act-edit").value || "{}"); } catch { $("dash-error").textContent = t("badJson"); return; }
      $("dash-error").textContent = "";
      send({ t: "activities", activities: a });
    });
    connect();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("lang").addEventListener("click", () => {
      lang = lang === "ja" ? "en" : "ja";
      try { localStorage.setItem("egatari-live-lang", lang); } catch { /* storage blocked */ }
      applyLang();
    });
    applyLang();
    const page = document.body.dataset.page;
    if (page === "create") {
      // Old bookmarks of the form /#room=…&admin=… go to the room page.
      if (S.room && S.admin) { location.replace("/room" + location.hash); return; }
      showCreate();
    } else if (S.room && S.admin) {
      if (hash.get("new") === "1") showCreated();
      startDash();
    } else {
      location.replace("/");
    }
  });
})();
