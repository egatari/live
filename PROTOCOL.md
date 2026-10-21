# Egatari Live protocol, version 1

This document defines the wire protocol between an Egatari player (the learner's side; the service's own join page `/join` speaks the same learner protocol), the teacher page, and the Egatari Live room service. It implements the extension `live` of the Egatari format (`egatari-spec/extensions/live.md`). The machine-readable parts are in [`protocol/`](protocol/):

| File | Contents |
|---|---|
| `protocol/schema.json` | JSON Schema (2020-12). Entry points: `#/$defs/learnerToServer`, `serverToLearner`, `teacherToServer`, `serverToTeacher`, `createRequest`, `createResponse`, `results`, `httpError`. |
| `protocol/close-codes.json` | Close codes with names, meaning and whether a player may retry. |
| `protocol/fixtures/**.json` | One example per message type and HTTP body. Every fixture validates against the schema (checked by `npm test`). |

`protocol/` is MIT-licensed so that players and editors can vendor it. The server is AGPL-3.0.

## 1. Conventions

- Every WebSocket message is one UTF-8 JSON object in a text frame, with `"v": 1` and a type `"t"`. Binary frames are refused.
- A client may add `"ref"` (1–32 characters of `[A-Za-z0-9_-]`) to a request; the reply (`ack` or `error`) echoes it.
- Unknown members are refused (`additionalProperties: false`), so that a v1 server never silently ignores a field a newer client relies on. A future version changes `v`; a v1 server answers any other `v` with `error unsupported_version` and closes with 4400.
- Times are RFC 3339 with an offset (`Z` or `±hh:mm`).
- Identifiers:

| Name | Format | Made by |
|---|---|---|
| `room` | `r-` + 8 base32 characters (`a-z`, `2-7`), 40 bits | service |
| `key` (learner capability) | base64url, 22 characters (128 bits) | service; goes into the exported play-only file |
| `adminKey` (teacher key) | base64url, 43 characters (256 bits) | service; shown once, kept in the teacher page's fragment, never in a file |
| `pid` (participant id) | 16–43 characters of `[A-Za-z0-9_-]` | the learner's device, at random (e.g. 16 random bytes, base64url), kept in `localStorage` per room |
| step key | `slideKey:stepKey` as in the format spec, or `*` | the lesson |
| activity id | 1–32 characters of `[A-Za-z0-9_-]` | the lesson |
| activity label (optional) | up to 80 characters of display text, e.g. `Slide 4 'XML の壁', step 1` | the editor, when it creates the activity |
| item id | `q-` + 10 base32 characters | service |

## 2. HTTP endpoints

All JSON responses carry `cache-control: no-store`. No endpoint sets CORS headers, and none uses cookies.

| Method and path | Auth | Body / reply |
|---|---|---|
| `GET /` | none | The create page (HTML, en/ja). The only page that loads Cloudflare Turnstile. |
| `GET /room` | none (the teacher key is in the fragment) | The room page (teacher dashboard). Its CSP allows no third party. `/teacher.js`, `/teacher.css` and `/join-core.js` are its only own resources. |
| `GET /join` | none (room and learner key are in the fragment) | The learner join page (§7.1). Same CSP as `/room`. Its only resources are `/join.js`, `/join-core.js` and `/join.css`. |
| `POST /api/rooms` | a Turnstile token in the body; `Origin`, if present, must be the service origin; 5 per minute per sender | `createRequest` → `201 createResponse`. Errors: `400` (`bad_request`, `window_too_long`, `room_too_large`, `turnstile_required`), `403` (`forbidden`: foreign Origin; `turnstile_failed`), `413`, `415`, `429` (`rate_limited`), `503` (`unavailable`: Turnstile or the limiter not configured, or siteverify unreachable). |
| `GET /api/rooms/{room}/results` | `Authorization: Bearer <adminKey>` | `200 results`; `401` without or with a wrong key; `404` when the room does not exist (or was deleted). |
| `GET /api/health` | none | `{"v":1,"ok":true,"service":"egatari-live"}` |

Errors are `httpError`: `{"v":1, "error": "<code>", "message": "..."}`.

**Create.** `createRequest` is `{v, window: {from, to}, turnstile, size?, graceHours?, requireApproval?, activities?}`:

- `turnstile`: the Cloudflare Turnstile token from the widget on the create page (action `create-room`). The service verifies it with siteverify after validating the rest of the request, so a malformed request does not spend the token. Each token works once.
- `window.to` must be after `window.from` and in the future; at most **3 hours** long (`window_too_long`); it may start at most 180 days ahead.
- `size` (optional): the number of learners expected. More than **60** is refused (`room_too_large`). v1 rooms are for one class.
- `graceHours` (default 24, 0–168): how long after `window.to` the room is kept so the teacher can download results. Then the room deletes itself.
- `activities` (optional): the `extensions.live.activities` object of the lesson. If given, the room accepts only those activities; if not, it accepts any activity id (up to 64) and records the kind it first sees. Each activity (`qa` or `poll`) may carry `label` (optional, at most 80 characters after trimming, whitespace runs folded to one space; `text_too_long` if longer): display text for where it is in the lesson, written by the editor (slide number, slide heading, step number). It is text only: keys and step keys stay as they are, the server never interprets it, and pages show it with `textContent`. An activity without a label is shown by its step key (`*` as "whole lesson"; `s-xxx:0` as `s-xxx · step 1`).

`createResponse` returns `endpoint`, `room`, `key`, `adminKey`, the `window`, `graceHours`, `expiresAt` (= `window.to` + grace), `requireApproval` and `teacherUrl` = `<endpoint>/room#room=<room>&admin=<adminKey>`. The teacher page shows the link once and tells the teacher to bookmark it. There is no recovery: a teacher who loses it creates a new room.

**Results.** `results` is `{v, room, window, activities, responses, exportedAt}` (format spec live §3). `responses` is a list sorted by time; each entry has `kind` (`qa` or `poll`), `activity`, `step`, `pid`, optional `name`, `at`, and for `qa` the `id`, `text` and moderation flags (`read`, `answered`, `shown`, `hidden`), for `poll` the `choice` (index). Only the last vote of each participant per poll is kept. `activities` keeps each activity's `label`. If the teacher never set activities, `activities` is inferred from what was received (polls then have no `choices`).

## 3. Learner WebSocket

```
wss://live.egatari.org/ws?room=<room>&key=<key>&pid=<pid>
```

- Any `Origin` is accepted, including `null` (lessons opened from `file://`), because the key is the capability.
- The server always completes the upgrade and reports refusals as close codes (§5), because browsers do not expose HTTP status codes of a failed WebSocket handshake.
- Only one connection per `pid`: a newer one closes the older with 4409.
- The player connects only inside the window and only after the learner has tapped **Join / 参加する** once (§7).

### 3.1 Server → learner

| `t` | Members | When |
|---|---|---|
| `welcome` | `room`, `pid`, `status` (`admitted` \| `waiting`), `window`, `shown` (projected questions), `limits` | first message after connecting |
| `admitted` | `shown` | the teacher admitted a waiting learner |
| `shown` | `items` | the list of projected questions changed (the full list, at most 50) |
| `ack` | `ref?`, `item?` (item id for `ask`) | a request was accepted |
| `error` | `code`, `ref?` | a request was refused; see §4 |
| `pong` | | reply to `ping` |
| `activities` | `ref?`, `activities`, `declared` | reply to `activities` (and later updates to the sockets that asked). `activities` is the same object as `extensions.live.activities`; `declared: false` means the teacher set none, so the list is inferred from what was received (any activity id is then accepted, and polls have no `choices`). |

Projected questions carry `id`, `activity`, `step` and `text` only, never who asked.

### 3.2 Learner → server

| `t` | Members | Notes |
|---|---|---|
| `ask` | `activity`, `step`, `text` (1–500 characters) | a question for a `qa` activity. `step` is the step key under which the activity is declared, or, for an activity declared under `*`, the step key on screen when the learner pressed Send (the player MAY send `*`). |
| `vote` | `activity`, `step`, `choice` (0-based index) | a single-choice poll; a new vote replaces the previous one |
| `name` | `name` (0–40 characters; empty clears) | only if the learner typed a name; allowed while waiting, so the teacher can recognise who is waiting |
| `ping` | | keep-alive; answered without waking the room (Hibernation auto-response). Send it exactly as `{"v":1,"t":"ping"}`. At most once per 30 s. |
| `activities` | | ask for the room's activities. Used by the join page (§7.1), which has no lesson file; a player has them in `extensions.live` and need not send it. Only from admitted learners (`error not_admitted` otherwise). The reply is `activities`, and the server sends it again to that socket whenever the teacher changes the activities. Carries no learner data. |

**Approval.** In a room that requires approval, a learner the teacher has not decided on yet gets `welcome` with `status: "waiting"` and **stays connected**; `admitted` follows when the teacher admits them. Close code **4441 always means a definite decline**: it is sent only after the teacher declined this pid (`deny`), either at that moment or when the declined pid connects again. It never means "still pending". A player shows "The teacher did not admit you" and does not reconnect by itself (the teacher may later admit the pid; a manual "Try again" is fine).

Nothing else is sent: no viewing position, timing, playback events or device information. `ask` and `vote` from a learner who is still waiting get `error not_admitted`.

## 4. Teacher WebSocket

```
wss://live.egatari.org/ws/teacher?room=<room>
```

The first message must be `{"v":1,"t":"auth","adminKey":"…"}` within 10 s; otherwise, or with a wrong key, the server closes with 4401. The admin key is not put in the URL so that it does not appear in logs. Browsers must connect from the service origin (`Origin` checked; 403 before upgrade otherwise). At most 4 teacher sockets per room.

### 4.1 Teacher → server

| `t` | Members | Effect |
|---|---|---|
| `auth` | `adminKey` | first message; reply `state` |
| `state` | | reply `state` |
| `open` / `close` | | open or close the room. Closing disconnects all learners (4423) and refuses new ones until reopened. |
| `approval` | `required` (bool) | require approval; turning it off admits everyone waiting |
| `admit` | `pid` | admit one waiting learner (remembered for reconnects) |
| `admitAll` | | admit everyone waiting |
| `deny` | `pid` | decline; the learner is closed with 4441 and refused afterwards |
| `rekey` | | replace the learner key; all learners are closed with 4440; reply `rekeyed` |
| `mark` | `item`, any of `read`, `answered`, `shown`, `hidden` (bool) | moderate a question. `hidden: true` clears `shown`; `shown: true` clears `hidden`. Showing broadcasts `shown` to admitted learners. |
| `activities` | `activities` | set or replace the room's activities (same object as `extensions.live.activities`) |

### 4.2 Server → teacher

| `t` | Members |
|---|---|
| `state` | `room`, `key`, `window`, `graceHours`, `expiresAt`, `open`, `requireApproval`, `activities`, `people` (`connected`, `waiting[]`), `items[]` (with `pid`, `name`, `at` and flags), `tallies` (`{activityId: {counts[], total}}`) |
| `people` | `connected`, `waiting[]` (`pid`, `name`, `since`) |
| `item` | `item` (new or changed question) |
| `tally` | `activity`, `counts[]`, `total` |
| `rekeyed` | `room`, `key` (the new learner key, to paste into the editor) |
| `ack`, `error` | as for learners; teacher errors may carry `message` |

## 5. Error codes and close codes

**Error codes** (`error.code`, `httpError.error`):

| Code | Meaning | Learner connection |
|---|---|---|
| `bad_message` | not JSON, not an object, missing or unexpected members | closed 4400 |
| `too_large` | frame larger than 2048 bytes (learner) / 32768 (teacher) | closed 4400 |
| `unsupported_version` | `v` is not 1 | closed 4400 |
| `unknown_type` | unknown `t` | closed 4400 |
| `unknown_activity` | activity not declared (when the room has activities), or declared under another step | kept |
| `wrong_kind` | `ask` to a poll or `vote` to a Q&A | kept |
| `bad_choice` | choice out of range | kept |
| `text_too_long`, `empty_text` | text caps | kept |
| `rate_limited` | the participant's message budget is empty; on create: too many rooms from this sender | kept; closed 4429 after 10 drops |
| `quota_exceeded` | more than 20 questions from one participant | kept |
| `room_limit` | the room is full of items, activities or shown questions | kept |
| `not_admitted` | waiting for approval | kept |
| `not_found`, `bad_request`, `unauthorized`, `forbidden` | HTTP and teacher errors | — |
| `window_too_long` | create: window longer than 3 hours | — |
| `room_too_large` | create: `size` above 60 | — |
| `turnstile_required` | create: no Turnstile token | — |
| `turnstile_failed` | create: siteverify refused the token (invalid, expired, spent, wrong action or hostname) | — |
| `unavailable` | create: Turnstile secret or limiter not configured, or siteverify unreachable (fails closed) | — |

**Close codes** (also in `protocol/close-codes.json`). "Retry" says whether a player may reconnect by itself (with backoff, still only inside the window).

| Code | Name | Meaning | Retry |
|---|---|---|---|
| 4400 | `bad_message` | protocol violation (malformed, oversize, unknown type, wrong version) | no |
| 4401 | `unauthorized` | teacher socket without a valid admin key | no |
| 4403 | `bad_key` | wrong learner key (or malformed pid) | no |
| 4404 | `room_not_found` | no such room (never created, or deleted) | no |
| 4409 | `superseded` | the same pid connected again elsewhere | no |
| 4410 | `room_expired` | the window is over / the room was deleted | no |
| 4423 | `room_closed` | the teacher closed the room | yes, slowly (≥ 30 s, with jitter) |
| 4425 | `too_early` | the window has not started (clock skew) | yes, at `window.from` |
| 4429 | `rate_limited` | too many messages | yes, after ≥ 60 s |
| 4430 | `room_full` | room size limit (60 connected, 200 participants ever, or 60 waiting) | yes, after ≥ 60 s |
| 4440 | `key_replaced` | the teacher replaced the key; this file no longer works | no |
| 4441 | `not_approved` | definite decline by the teacher (never "pending"; pending is a `waiting` welcome) | no |

The server tolerates 2 minutes of clock skew at both window edges.

## 6. Limits (constants, `src/limits.js`)

v1 rooms are sized for one class: text Q&A and polls, about 40 people, for up to 2 hours. Each cap leaves headroom over that target. Larger rooms will need a light sign-in for teachers in a later version.

| Limit | Value | Why |
|---|---|---|
| learner frame | 2048 bytes | a 500-character question in UTF-8 plus the envelope |
| question / name / poll prompt / choice / activity label | 500 / 40 / 300 / 100 / 80 characters | text only |
| rate | bucket of 5 messages, one more every 2 s; closed after 10 dropped messages | a person types far slower |
| questions per participant | 20 | |
| concurrent learners per room | **60** | 40 + 50 % for late joiners and a second device |
| participants ever per room | **200** | 5× the class: a new browser or private window makes a new pid |
| waiting at once | 60 | the whole room may wait |
| questions per room | **400**; at most 30 shown at once | 10 per expected learner; 30 fit a projected screen |
| activities per room | 64; poll choices 2–12 | |
| teacher sockets | 4 | a laptop, a projector, a phone |
| window | **≤ 3 h**, starting ≤ 180 days ahead | a 2-hour lesson plus an hour of slack |
| grace for results | 0–168 h, default 24 h | time to download results |
| room creation | 5 per 60 s per sender (Workers Rate Limiting binding, by `CF-Connecting-IP`), plus Turnstile | |

`welcome.limits` gives learners the ones a player needs to shape its UI.

## 7. Player behaviour (informative; normative text is in the format spec)

1. Read `extensions.live`. If the time is outside `window` or the context forbids network access, make no request.
2. Show the notice ("This lesson connects to a live room at live.egatari.org" / 「この教材は live.egatari.org の授業の部屋につながります」) with a **Join / 参加する** button. Connect only after the learner taps it; remember the choice for this room only.
3. Generate `pid` once per room on the device. Send `name` only if the learner typed one.
4. Show activities in a pane outside the stage. In Studio, the player-side client listens to the `deck:pos` event (`detail.key` is the step key) to show a step's poll when that step is reached; `qa` is available for the whole window.
5. While connected, show a persistent indicator with Disconnect. Reconnect only for close codes marked "retry", with backoff; never outside the window.
6. Show every server-provided string as text (`textContent`), never as HTML.
6a. Never load Turnstile or anything else from the endpoint. Turnstile exists only on the service's create page; the learner endpoint does not use it.
7. Producers write a CSP `<meta>` into derivatives that carry `live`, with `connect-src` limited to the endpoint (`wss://live.egatari.org`).

### 7.1 The join page (`/join`)

Some devices cannot connect from the distributed file: a lesson opened inside a chat app's browser (for example Slack on iPhone), a file viewer that runs no scripts (iOS Files), a frame. For them the teacher page shows a **Join link / 参加用のリンク** with a Copy button:

```
https://live.egatari.org/join#room=<room>&key=<key>
```

- The room and the learner key are **only in the fragment**, which browsers never send, so they reach neither the server's request line nor any log. The page reads them with `location.hash`. Its own requests are `/join`, `/join.js`, `/join-core.js` and `/join.css`, with no query; the only URL that carries the key is the learner WebSocket `/ws?room=&key=&pid=` (§3), which already carries it.
- The link is built from the room and the **current** learner key. After `rekey` the teacher page updates it and warns that links shared before stop working (the page then stops with 4440).
- Same data rules as a player (format spec live §2.3): it sends only `ask`, `vote`, `name` (only if typed), `activities` and `ping`. The `pid` is random (16 bytes, base64url), kept in `localStorage` per room (key `egatari-live-pid:<room>`), in memory if storage is blocked. No telemetry; no third parties; every server string is shown with `textContent`. Same CSP as `/room` (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' wss://<host>; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`), with `referrer-policy: no-referrer`, `x-content-type-options: nosniff`, `x-frame-options: DENY`. No Turnstile.
- Before connecting it shows the notice 「この教材は live.egatari.org の授業の部屋につながります」 / "This lesson connects to a live room at live.egatari.org" and a **参加する / Join** button; it connects only after the tap (remembered for the tab in `sessionStorage`, so a reload reconnects). While joined, a persistent indicator with **Disconnect**; while waiting for approval, a waiting notice (and the name field, so the teacher can recognise the learner).
- Retry table, the same as the Studio player: never by itself after 4400, 4401, 4403, 4404, 4409, 4410, 4440 or 4441 (4441 and 4409 offer a manual "Try again"); 4423 after ≥ 30 s with jitter; 4425 at `window.from`; 4429 and 4430 after ≥ 60 s; network errors with backoff 1–30 s, only inside the window. The link does not carry the window, so before the first `welcome` the page does not know it: a network error is then retried at most 8 times before a manual "Try again", and 4425 waits ≥ 30 s, growing to 5 min.
- What it shows: the Q&A with a send box (the first `qa` activity, preferring one under `*`; with no activities set, activity `qa` under `*`), the questions the teacher marked "shown", and **all polls the room has activities for**, in declaration order, each with its prompt and its step: the activity's `label` if it has one, otherwise the step key ("whole lesson" for `*`, `s-xxx · step 1` for `s-xxx:0`), with the step key in a tooltip. The page has no deck position and the protocol has no notion of an "open" poll, so it cannot show only the current one; the learner answers the one the teacher points to. A `qa` declared under `*` is sent with step `*` (§3.2); a vote is sent with the poll's declared step key and the 0-based choice index.
- ja and en, from `navigator.language`, with a manual toggle (remembered in `localStorage`). Mobile first; it works from 320 px wide.

---

## 日本語の要約

Egatari Live は、配った教材（再生専用のファイル）から、そのまま授業の Q&A と投票に参加するための通信の約束です。

- **HTTP**：`POST /api/rooms` で部屋を作る（教員のページから。Cloudflare Turnstile のトークンが要る。送り手ごとに 1 分 5 部屋まで。時間の窓は 3 時間まで（`window_too_long`）、人数の見込みは 60 人まで（`room_too_large`））。返るのは部屋の `room`、参加の鍵 `key`（書き出すファイルに入る）、教員の鍵 `adminKey`（一度だけ表示、ページのアドレスの `#` の後ろにだけ置き、ファイルには入れない。なくしたら作り直す）。結果は `GET /api/rooms/{room}/results` に `Authorization: Bearer <adminKey>` を付けて JSON（`{room, window, activities, responses}`）で受け取る。
- **参加用のページ**：教材のファイルからつながらない端末（スマートフォンのチャットのアプリの中のブラウザ、ファイルを見るだけのアプリなど）のために、`/join#room=…&key=…` のリンクを教員のページに出す。部屋と鍵は `#` の後ろにだけあり、サーバーには送られない。送るもの・決まり・つなぎ直し方は再生アプリと同じ。投票は、部屋にあるものをすべて、段階の表示（活動の `label`。なければ段階の鍵。`*` は「教材全体」）と一緒に出す（このページには今の段階がなく、通信の約束にも「いま開いている投票」がないため）。部屋の活動は、新しい `activities` の問い合わせで受け取る（§7.1）。
- **学ぶ人の WebSocket**：`/ws?room=&key=&pid=`。`file://` から開いた教材（Origin が `null`）も受け付ける。送るのは活動の id・段階の鍵・質問の文または投票の選択・端末で作った乱数の id・（入力したときだけ）名前だけ。視聴の位置や時間などの記録は送らない。最初の接続の前に「参加する」を 1 回押してもらう。
- **活動の表示名**：活動（`qa`・`poll`）は任意で `label`（80 字まで。例「4 枚目『XML の壁』・段階 1」）を持てる。編集アプリが活動を作るときに書く表示のための字で、鍵や段階の鍵はそのまま。教員のページと参加用のページは、段階の鍵の代わりにこれを出し（鍵は title の吹き出し）、結果の JSON の `activities` にも残る。`label` のない古い活動は段階の鍵（「s-xxx · 段階 1」）で出す。
- **教員の WebSocket**：`/ws/teacher?room=`。最初のメッセージで `adminKey` を送る。部屋を開ける・閉じる、承認（待合）、参加の鍵の取り替え（古い鍵の人は切断）、質問の「読んだ・答えた・映す・隠す」、投票の集計。
- **版**：すべてのメッセージに `v: 1`。知らない項目・知らない種類は拒否する。
- **承認**：待っている人には `welcome`（`status: "waiting"`）が届き、接続は切れない。4441 は教員が「断る」を選んだときだけで、「まだ待っている」の意味にはならない。
- **切断の番号**：4400 不正なメッセージ、4401 教員の鍵がない、4403 鍵が違う、4404 部屋がない、4409 同じ id の新しい接続、4410 期限切れ、4423 部屋が閉じた、4425 まだ始まっていない、4429 送りすぎ、4430 満員、4440 鍵が替わった、4441 承認されなかった。
- **上限**：v1 の部屋は 1 クラス分（文字の Q&A と投票、40 人ほど、2 時間まで）。1 通 2048 バイト、質問 500 字、名前 40 字、1 人 20 問、同時 60 人、延べ 200 人、部屋の質問 400 件、時間の窓 3 時間まで（`src/limits.js` の定数）。もっと大きな部屋には、のちの版で軽いサインインが要る。
- `protocol/` の Schema と例は MIT で、Studio に取り込める。
