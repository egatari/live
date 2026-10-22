# Egatari Live

Part of Egatari Studio; the reference implementation behind live.egatari.org.
（Egatari Studio の一部。live.egatari.org を動かす参照実装です。）

Egatari Live lets participants ask questions and answer polls from inside a distributed Egatari lesson, without scanning a code or opening another app. The teacher (the host) creates a Live on this service's page, pastes its settings (Live ID, join code, live time) into Egatari Studio (**Export ▾ → Distribute with Live (questions and polls)…**), and hands out the Egatari file (play only). During the live time, a player that implements the `live` extension shows a **Join** button; after one tap the lesson joins the Live. (In the protocol and the code a Live is a *room*, and the join code is the learner *key*.)

For devices that cannot connect from the file (a lesson opened inside a chat app's browser such as Slack on iPhone, a file viewer that runs no scripts such as iOS Files), the host page also gives a **join link**, `https://live.egatari.org/join#room=…&key=…`, that participants open in a browser. The Live ID and join code are only in the fragment, so they never reach the server or its logs; the page speaks the same learner protocol with the same data rules (PROTOCOL.md §7.1).

It runs on Cloudflare Workers with one Durable Object per room, using the WebSocket Hibernation API so that idle rooms cost nothing. There is no database outside the rooms, no R2, no accounts and no cookies.

- Protocol: [PROTOCOL.md](PROTOCOL.md), with the JSON Schema, close codes and fixture messages in [`protocol/`](protocol/).
- Format extension: `extensions/live.md` in the Egatari spec.

## Privacy

**What is stored, in the room's Durable Object only:**

- the room settings: window, grace period, open/closed, approval setting, the learner key, a SHA-256 hash of the teacher key (the teacher key itself is never stored), and the activities if the teacher gave them;
- for each participant: the random participant id generated on the learner's device, the name only if the learner typed one, whether they are admitted, waiting or declined, and how many questions they asked;
- each question (text, activity, step key, time, participant id, name if any, and the teacher's flags; the area the participant circled on the slide and the lesson's version hash, if the player sent them; the host's group and reply), each participant's last vote per poll, and each participant's "I don't follow" mark per step (on or taken back, with its time; no text).

**Teachers, when creating a room:** the sender's IP address is used for the per-sender creation limit (the Workers Rate Limiting binding counts it in memory at Cloudflare for a minute; this service stores nothing) and is passed to Cloudflare Turnstile's verification together with the token. The create page loads the Turnstile widget from challenges.cloudflare.com; no other page does.

**What is not stored or sent:** no IP addresses stored, no user agents, no viewing position, timing or playback events, no telemetry of any kind. The player sends only what an activity needs. Observability (request logs) is turned off in `wrangler.toml`.

**How long:** a room and everything in it is deleted by a Durable Object alarm at the end of its window plus the grace period (24 hours by default, at most 7 days), so that the teacher can download the results. After that there is nothing left to recover. Learners are disconnected when the window ends.

**Who sees what:** questions are visible to the teacher only, unless the teacher marks one **show to everyone** or replies with **Also show to all participants**; shown questions (and such replies) reach participants without any name or participant id. Any other reply reaches only the participant who asked. "I don't follow" reaches the host as a count per step and never reaches other participants. Results belong to the teacher and are downloaded as JSON from the teacher page.

## Room size in v1

v1 rooms are for one class: text Q&A and polls, about 40 people, for up to 2 hours. The caps leave some headroom: 60 learners connected at once, 200 participants ever, a window of at most 3 hours, 400 questions (see PROTOCOL.md §6 for the reasons). A request for a larger room is refused with `room_too_large` or `window_too_long`. There are no accounts in v1; **larger rooms will need a light sign-in for teachers later.**

## Abuse controls on room creation

Anyone can open the create page, so creating a room needs:

1. **Cloudflare Turnstile.** The create page shows the widget; `POST /api/rooms` verifies the token server-side with siteverify, using the Worker secret `TURNSTILE_SECRET` (never in the repo). The public site key is the var `TURNSTILE_SITEKEY` in `wrangler.toml`. The room page (which holds the teacher key) and learners never load Turnstile. If the secret is missing, creation fails closed (`503 unavailable`).
2. **A per-sender rate limit**: 5 rooms per 60 s per `CF-Connecting-IP`, with the [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (`CREATE_LIMITER` in `wrangler.toml`). It was chosen over a Durable Object counter because Miniflare implements it locally (so it is tested offline), it keeps no state of ours, and it costs nothing extra. Its counts are per Cloudflare location and eventually consistent, so it is a brake, not an exact quota.
3. **An extra layer, recommended:** a Cloudflare rate-limiting rule (WAF) on `POST /api/rooms`, and a usage alert on the account.

For tests and offline development the server answers Cloudflare's documented Turnstile **test secrets** (`1x…AA` always passes, `2x…AA` always fails, `3x…AA` token already spent) locally, without network; with an empty site key the create page sends Cloudflare's dummy test token, which a production secret rejects. Copy `.dev.vars.example` to `.dev.vars` for `npm run dev`.

## Using it

1. Open the service page (`https://live.egatari.org/`), set the live time (start and end, up to 3 hours), choose **Use a waiting room** if only people you admit may join, pass the check, and **Create Live**.
2. **Bookmark the host link** that appears (`…/room#room=…&admin=…`). It is shown once; if it is lost, create a new Live.
3. Copy **Settings to paste into Egatari Studio** (server, Live ID, join code, live time) into Egatari Studio's **Distribute with Live (questions and polls)…**, and export the Egatari file (play only). When you hand it out, paste the **Text to share** (Copy button on the room page, in the page's language) next to the file: computers download the file and open it in a browser, phones and tablets open the join link (iPhone and iPad cannot run a downloaded HTML file; chat apps such as Slack may not preview a large file).
4. During the lesson, keep the host page open: **End Live** or **Reopen Live**, admit participants from the waiting room (**Admit**, **Decline**, **Admit all**), mark questions read, answered, show to everyone or hidden, group similar questions and send a short reply (to the askers only, or also to all participants), watch poll tallies and the "I don't follow" count per step.
5. If a participant's device cannot join from the file, send them the **Join link** (Copy button on the host page). They open it in a browser, tap **Join**, and see the question box, an **I don't follow** button, your replies to their questions, the questions you show to everyone, and all the Live's polls (each labelled with where it is in the lesson, e.g. "Slide 4 'XML の壁', step 1", or its step key for activities made before labels existed, since the page has no slide position: tell them which poll to answer).
6. If the file leaks, **Change join code**: everyone who joined with the old code is disconnected; export again with the new code, and share the new join link (old join links stop working too).
7. After the lesson, **Download results (JSON)** before the time to keep results ends.

## Development

```sh
npm ci
npm test          # vitest + @cloudflare/vitest-pool-workers, fully local (Miniflare/workerd)
npm run dev       # wrangler dev on http://localhost:8787
```

Dependencies are pinned to exact versions. The tests cover creation and joining, a wrong key, key replacement, approval, close and reopen, the expiry alarm, the rate limits (messages and room creation), oversize messages, `Origin: null`, teacher endpoints without the teacher key, the results shape, hibernation, Turnstile (missing, failed and passed tokens; the siteverify call with an injected fetch), the v1 caps, the pages' CSPs, the join page (its headers and files, the join link on the teacher page before and after rekey, its retry table, and its client core driven against a live room: join, ask→ack, vote→ack, waiting→admitted, 4440 stops, 4423 retries, and that the only URL carrying the key is the WebSocket), and that every fixture in `protocol/` validates against the schema. No test touches the network.

## Deploy (for the maintainer; not done yet)

Deploying is done by hand after the end-to-end tests with Studio pass.

1. Sign in, if this machine is not signed in yet: `npx wrangler login`.
2. **Turnstile widget.** In the Cloudflare dashboard → Turnstile → Add widget: name "Egatari Live", hostname `live.egatari.org` (add `localhost` too if you want to try the real widget with `wrangler dev`), mode "Managed". Copy the site key and the secret key.
   - Put the site key in `wrangler.toml`: `TURNSTILE_SITEKEY = "<site key>"` (it is public).
   - Store the secret as a Worker secret (it is never written to the repo): `npx wrangler secret put TURNSTILE_SECRET` and paste the secret key.
3. Production settings live in `wrangler.production.toml` (a copy of `wrangler.toml` with the `live.egatari.org` route as a Custom Domain, `PUBLIC_ORIGIN` and the Turnstile site key; `wrangler.toml` stays the development and test config). The zone `egatari.org` must be in the same Cloudflare account. With `custom_domain = true`, `wrangler deploy` creates the DNS record and the certificate itself; no manual DNS entry is needed. The account id is passed at deploy time, not committed.
4. `npm ci && npm test && CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler deploy -c wrangler.production.toml` (Workers paid plan; Durable Objects use the SQLite backend via the `v1` migration).
5. Check:

   ```sh
   curl -s https://live.egatari.org/api/health
   # {"v":1,"ok":true,"service":"egatari-live"}
   curl -sI https://live.egatari.org/ | grep -i content-security-policy
   # the learner join page: strict CSP, no third party
   curl -sI https://live.egatari.org/join | grep -i -E 'content-security-policy|x-frame-options|referrer-policy'
   # content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' wss://live.egatari.org; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
   # room creation without a token must be refused:
   curl -s -X POST https://live.egatari.org/api/rooms -H 'content-type: application/json' \
     -d '{"window":{"from":"2030-01-01T09:00:00Z","to":"2030-01-01T10:00:00Z"}}'
   # {"v":1,"error":"turnstile_required",...}
   ```

   Then create one room from the page in a browser to see the widget pass.

6. Recommended extra layer: a Cloudflare rate-limiting rule on `POST /api/rooms` (e.g. 10 per minute per IP), and a usage alert on the account, since room creation needs no account.

To opt out of Wrangler's own usage metrics on the maintainer's machine: `npx wrangler telemetry disable`.

## License

The service (everything outside `protocol/`) is licensed under the **GNU Affero General Public License v3.0** ([LICENSE](LICENSE)); if you run a modified version as a network service, you must offer its source to its users. The protocol files in [`protocol/`](protocol/) (schema, close codes, fixtures) are **MIT** ([protocol/LICENSE](protocol/LICENSE)) so that players and editors such as Egatari Studio can vendor them.

---

## 日本語

**Egatari Studio の一部。live.egatari.org を動かす参照実装です。**

Egatari Live は、配った Egatari の教材の中から、参加者が質問し、投票に答えられるようにするサービスです。QR コードを読んだり別のアプリを開いたりする必要はありません。教員（ホスト）はこのサービスのページでライブを作り、その設定（ライブ ID・参加コード・ライブの時間）を Egatari Studio の **書き出す ▾ →「ライブ（質問・投票）を付けて配る…」** に貼って、Egatari ファイル（再生のみ）を配ります。ライブの時間のあいだ、`live` 拡張に対応した再生アプリは「参加する」のボタンを出し、1 回押すとライブにつながります（通信の約束とコードでは、ライブは room、参加コードは学ぶ人の key と呼びます）。

教材のファイルからつながらない端末（Slack などチャットのアプリの中のブラウザで開いたとき、iOS の「ファイル」のようにスクリプトを動かさないアプリ）のために、ホストのページは**参加用リンク** `https://live.egatari.org/join#room=…&key=…` も出します。参加者はこれをブラウザで開きます。ライブ ID と参加コードは `#` の後ろにだけあるので、サーバーにもログにも届きません。通信の約束と送るものの決まりは再生アプリと同じです（PROTOCOL.md §7.1）。

Cloudflare Workers の上で、1 部屋に 1 つの Durable Object を使い、WebSocket Hibernation で待ち時間には課金されません。部屋の外のデータベース、R2、アカウント、Cookie はありません。

### プライバシー

- **保存するもの（その部屋の Durable Object の中だけ）**：部屋の設定（時間の窓・猶予・開閉・承認の設定・参加の鍵・教員の鍵のハッシュ。教員の鍵そのものは保存しない・教員が入れた活動）。参加者ごとに、端末で作った乱数の id、入力したときだけ名前、承認の状態、質問の数。質問（文・活動・ステップの鍵・時刻・参加者の id・名前・ホストの印。再生アプリが送ったときは、スライドの上で囲んだところと教材の版のハッシュ。ホストのまとめと返事）と、投票ごとの最後の 1 票と、ステップごとの「わからない」の印（押した・取り消した、と時刻。文はない）。
- **教員が部屋を作るとき**：送り手の IP アドレスを、作成の回数の上限（Cloudflare の Rate Limiting がメモリ上で 1 分数えるだけで、このサービスは保存しない）と、Cloudflare Turnstile の確認に使います。Turnstile を読み込むのは部屋を作るページだけです。
- **保存も送信もしないもの**：IP アドレスの保存、ブラウザの情報、視聴の位置や時間・再生の操作、そのほかの利用状況の記録は一切ありません。リクエストのログも切ってあります。
- **期間**：部屋とその中身は、時間の窓の終わりから猶予の時間（既定 24 時間、最大 7 日）が過ぎると、Durable Object の alarm で消えます。消えた後は取り戻せません。窓が終わると学ぶ人の接続は切れます。
- **見える人**：質問はホストだけが見ます。ホストが「全員に表示」にした質問と、「参加者全員にも見せる」を付けて返事をした質問（と返事）だけが、名前も id も付けずに参加者に届きます。ほかの返事は、質問した人にだけ届きます。「わからない」は、ステップごとの人数としてホストにだけ届き、ほかの参加者には届きません。結果は教員のもので、ホストのページから JSON でダウンロードします。

### 使い方

1. サービスのページでライブの時間（開始と終了。3 時間まで）を決め、ホストが許可した人だけにするなら「待機室を使う」をオンにし、確認を済ませて「ライブを作る」。
2. 表示されるホスト用リンク（`…/room#room=…&admin=…`）を**すぐブックマークする**。一度しか表示されず、なくしたらライブを作り直す。
3. 「Egatari Studio に貼る設定」（接続先・ライブ ID・参加コード・ライブの時間）を Egatari Studio の「ライブ（質問・投票）を付けて配る…」に貼り、Egatari ファイル（再生のみ）を書き出す。
4. 授業中はホストのページを開いておく：「ライブを終える」「ライブを再開」、待機室の「許可」「許可しない」「全員を許可」、質問の「既読・回答済み・全員に表示・非表示」、似た質問をまとめる、短い返事（質問した人にだけ、または参加者全員にも）、投票の集計、ステップごとの「わからない」の人数。
5. 教材ファイルから参加できない端末の人には「参加用リンク」を送る（ホストのページのコピーのボタン）。ブラウザで開いて「参加する」を押すと、質問の欄、「わからない」のボタン、自分の質問への返事、全員に表示した質問、このライブのすべての投票が出る（このページには今のスライドがないので、投票には教材のどこか（例「4 枚目『XML の壁』・ステップ 1」。表示名のない古い投票ではステップの鍵）を添えて全部出す。どれに答えるかは口で伝える）。
6. ファイルが外に出たら「参加コードを変更」。古い参加コードで参加していた人は切断されるので、新しい参加コードで書き出し直し、新しい参加用リンクを配る（古いリンクも使えなくなる）。
7. 授業の後、結果を残す時間が終わる前に「結果をダウンロード（JSON）」。

### v1 の部屋の大きさと悪用の対策

- v1 の部屋は 1 クラス分です（文字の Q&A と投票、40 人ほど、2 時間まで）。上限は少し余裕を持たせて、同時 60 人・延べ 200 人・時間の窓 3 時間・質問 400 件。もっと大きな部屋は `room_too_large`・`window_too_long` で断ります。v1 にはアカウントがなく、**大きな部屋には、のちに教員の軽いサインインが要ります。**
- 部屋を作るには Cloudflare Turnstile の確認が要り（秘密の鍵は Worker の secret `TURNSTILE_SECRET`、サイトキーは `wrangler.toml` の `TURNSTILE_SITEKEY`）、送り手ごとに 1 分 5 部屋までです（Workers の Rate Limiting。手元の試験でも動くのでこれを選んだ）。Cloudflare の rate limiting のルールも重ねて使うことを勧めます。

### 開発とデプロイ

`npm ci` のあと `npm test` で、手元だけで試験が通ります（Miniflare / workerd）。デプロイは Studio との通しの試験が通った後に手で行います（上の英語の「Deploy」の手順）。Cloudflare のダッシュボードで Turnstile のウィジェットを作り（ホスト名 live.egatari.org、試すなら localhost も）、秘密の鍵は `npx wrangler secret put TURNSTILE_SECRET` で入れます（会話のできるターミナルで）。本番の設定は `wrangler.production.toml`（`routes` の custom domain・`PUBLIC_ORIGIN`・サイトキー入り。`wrangler.toml` は開発と試験用のまま）で、`CLOUDFLARE_ACCOUNT_ID=<アカウントの ID> npx wrangler deploy -c wrangler.production.toml` とすると、DNS の記録と証明書は自動で作られます。アカウントの ID はリポジトリに入れません。

### ライセンス

サービス本体（`protocol/` の外）は **GNU AGPL-3.0**、`protocol/` の Schema・切断の番号・例のメッセージは Studio などが取り込めるように **MIT** です。
