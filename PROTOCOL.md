# Egatari Live protocol, version 1

This document defines the wire protocol between an Egatari player (the learner's side), the teacher page, and the Egatari Live room service. It implements the extension `live` of the Egatari format (`egatari-spec/extensions/live.md`). The machine-readable parts are in [`protocol/`](protocol/):

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
| item id | `q-` + 10 base32 characters | service |

## 2. HTTP endpoints

All JSON responses carry `cache-control: no-store`. No endpoint sets CORS headers, and none uses cookies.

| Method and path | Auth | Body / reply |
|---|---|---|
| `GET /` | none | The teacher page (HTML, en/ja) with a strict CSP (§6). `/teacher.js` and `/teacher.css` are its only resources. |
| `POST /api/rooms` | none; `Origin`, if present, must be the service origin | `createRequest` → `201 createResponse`. Errors: `400`, `403` (foreign Origin), `413`, `415`. |
| `GET /api/rooms/{room}/results` | `Authorization: Bearer <adminKey>` | `200 results`; `401` without or with a wrong key; `404` when the room does not exist (or was deleted). |
| `GET /api/health` | none | `{"v":1,"ok":true,"service":"egatari-live"}` |

Errors are `httpError`: `{"v":1, "error": "<code>", "message": "..."}`.

**Create.** `createRequest` is `{v, window: {from, to}, graceHours?, requireApproval?, activities?}`:

- `window.to` must be after `window.from` and in the future; at most 7 days long; it may start at most 180 days ahead.
- `graceHours` (default 24, 0–168): how long after `window.to` the room is kept so the teacher can download results. Then the room deletes itself.
- `activities` (optional): the `extensions.live.activities` object of the lesson. If given, the room accepts only those activities; if not, it accepts any activity id (up to 64) and records the kind it first sees.

`createResponse` returns `endpoint`, `room`, `key`, `adminKey`, the `window`, `graceHours`, `expiresAt` (= `window.to` + grace), `requireApproval` and `teacherUrl` = `<endpoint>/#room=<room>&admin=<adminKey>`. The teacher page shows the link once and tells the teacher to bookmark it. There is no recovery: a teacher who loses it creates a new room.

**Results.** `results` is `{v, room, window, activities, responses, exportedAt}` (format spec live §3). `responses` is a list sorted by time; each entry has `kind` (`qa` or `poll`), `activity`, `step`, `pid`, optional `name`, `at`, and for `qa` the `id`, `text` and moderation flags (`read`, `answered`, `shown`, `hidden`), for `poll` the `choice` (index). Only the last vote of each participant per poll is kept. If the teacher never set activities, `activities` is inferred from what was received (polls then have no `choices`).

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

Projected questions carry `id`, `activity`, `step` and `text` only, never who asked.

### 3.2 Learner → server

| `t` | Members | Notes |
|---|---|---|
| `ask` | `activity`, `step`, `text` (1–500 characters) | a question for a `qa` activity. `step` is the step key under which the activity is declared, or, for an activity declared under `*`, the step key on screen when the learner pressed Send (the player MAY send `*`). |
| `vote` | `activity`, `step`, `choice` (0-based index) | a single-choice poll; a new vote replaces the previous one |
| `name` | `name` (0–40 characters; empty clears) | only if the learner typed a name; allowed while waiting, so the teacher can recognise who is waiting |
| `ping` | | keep-alive; answered without waking the room (Hibernation auto-response). Send it exactly as `{"v":1,"t":"ping"}`. At most once per 30 s. |

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
| `rate_limited` | the participant's message budget is empty | kept; closed 4429 after 10 drops |
| `quota_exceeded` | more than 20 questions from one participant | kept |
| `room_limit` | the room is full of items, activities or shown questions | kept |
| `not_admitted` | waiting for approval | kept |
| `not_found`, `bad_request`, `unauthorized`, `forbidden` | HTTP and teacher errors | — |

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
| 4430 | `room_full` | room size limit | yes, after ≥ 60 s |
| 4440 | `key_replaced` | the teacher replaced the key; this file no longer works | no |
| 4441 | `not_approved` | the teacher declined this participant | no |

The server tolerates 2 minutes of clock skew at both window edges.

## 6. Limits (constants, `src/limits.js`)

| Limit | Value |
|---|---|
| learner frame | 2048 bytes |
| question / name / poll prompt / choice | 500 / 40 / 300 / 100 characters |
| rate | bucket of 5 messages, one more every 2 s; closed after 10 dropped messages |
| questions per participant | 20 |
| concurrent learners per room | 300 |
| participants ever per room | 1000 |
| questions per room | 1000; at most 50 shown at once |
| activities per room | 64; poll choices 2–12 |
| teacher sockets | 4 |
| window | ≤ 7 days, starting ≤ 180 days ahead; grace 0–168 h (default 24 h) |

`welcome.limits` gives learners the ones a player needs to shape its UI.

## 7. Player behaviour (informative; normative text is in the format spec)

1. Read `extensions.live`. If the time is outside `window` or the context forbids network access, make no request.
2. Show the notice ("This lesson connects to a live room at live.egatari.org" / 「この教材は live.egatari.org の授業の部屋につながります」) with a **Join / 参加する** button. Connect only after the learner taps it; remember the choice for this room only.
3. Generate `pid` once per room on the device. Send `name` only if the learner typed one.
4. Show activities in a pane outside the stage. In Studio, the player-side client listens to the `deck:pos` event (`detail.key` is the step key) to show a step's poll when that step is reached; `qa` is available for the whole window.
5. While connected, show a persistent indicator with Disconnect. Reconnect only for close codes marked "retry", with backoff; never outside the window.
6. Show every server-provided string as text (`textContent`), never as HTML.
7. Producers write a CSP `<meta>` into derivatives that carry `live`, with `connect-src` limited to the endpoint (`wss://live.egatari.org`).

---

## 日本語の要約

Egatari Live は、配った教材（再生専用のファイル）から、そのまま授業の Q&A と投票に参加するための通信の約束です。

- **HTTP**：`POST /api/rooms` で部屋を作る（教員のページから）。返るのは部屋の `room`、参加の鍵 `key`（書き出すファイルに入る）、教員の鍵 `adminKey`（一度だけ表示、ページのアドレスの `#` の後ろにだけ置き、ファイルには入れない。なくしたら作り直す）。結果は `GET /api/rooms/{room}/results` に `Authorization: Bearer <adminKey>` を付けて JSON（`{room, window, activities, responses}`）で受け取る。
- **学ぶ人の WebSocket**：`/ws?room=&key=&pid=`。`file://` から開いた教材（Origin が `null`）も受け付ける。送るのは活動の id・段階の鍵・質問の文または投票の選択・端末で作った乱数の id・（入力したときだけ）名前だけ。視聴の位置や時間などの記録は送らない。最初の接続の前に「参加する」を 1 回押してもらう。
- **教員の WebSocket**：`/ws/teacher?room=`。最初のメッセージで `adminKey` を送る。部屋を開ける・閉じる、承認（待合）、参加の鍵の取り替え（古い鍵の人は切断）、質問の「読んだ・答えた・映す・隠す」、投票の集計。
- **版**：すべてのメッセージに `v: 1`。知らない項目・知らない種類は拒否する。
- **切断の番号**：4400 不正なメッセージ、4401 教員の鍵がない、4403 鍵が違う、4404 部屋がない、4409 同じ id の新しい接続、4410 期限切れ、4423 部屋が閉じた、4425 まだ始まっていない、4429 送りすぎ、4430 満員、4440 鍵が替わった、4441 承認されなかった。
- **上限**：1 通 2048 バイト、質問 500 字、名前 40 字、1 人 20 問、同時 300 人など（`src/limits.js` の定数）。
- `protocol/` の Schema と例は MIT で、Studio に取り込める。
