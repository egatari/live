# Egatari Live

Part of Egatari Studio; the reference implementation behind live.egatari.org.
（Egatari Studio の一部。live.egatari.org を動かす参照実装です。）

Egatari Live lets learners ask questions and answer polls from inside a distributed Egatari lesson, without scanning a code or opening another app. The teacher creates a room on this service's page, pastes the room and its learner key into the editor's export settings, and hands out the play-only file. While the room's time window is open, a player that implements the `live` extension shows a **Join** button; after one tap the lesson connects to the room.

It runs on Cloudflare Workers with one Durable Object per room, using the WebSocket Hibernation API so that idle rooms cost nothing. There is no database outside the rooms, no R2, no accounts and no cookies.

- Protocol: [PROTOCOL.md](PROTOCOL.md), with the JSON Schema, close codes and fixture messages in [`protocol/`](protocol/).
- Format extension: `extensions/live.md` in the Egatari spec.

## Privacy

**What is stored, in the room's Durable Object only:**

- the room settings: window, grace period, open/closed, approval setting, the learner key, a SHA-256 hash of the teacher key (the teacher key itself is never stored), and the activities if the teacher gave them;
- for each participant: the random participant id generated on the learner's device, the name only if the learner typed one, whether they are admitted, waiting or declined, and how many questions they asked;
- each question (text, activity, step key, time, participant id, name if any, and the teacher's flags), and each participant's last vote per poll.

**Teachers, when creating a room:** the sender's IP address is used for the per-sender creation limit (the Workers Rate Limiting binding counts it in memory at Cloudflare for a minute; this service stores nothing) and is passed to Cloudflare Turnstile's verification together with the token. The create page loads the Turnstile widget from challenges.cloudflare.com; no other page does.

**What is not stored or sent:** no IP addresses stored, no user agents, no viewing position, timing or playback events, no telemetry of any kind. The player sends only what an activity needs. Observability (request logs) is turned off in `wrangler.toml`.

**How long:** a room and everything in it is deleted by a Durable Object alarm at the end of its window plus the grace period (24 hours by default, at most 7 days), so that the teacher can download the results. After that there is nothing left to recover. Learners are disconnected when the window ends.

**Who sees what:** questions are visible to the teacher only, unless the teacher shows (projects) one; shown questions reach learners without any name or participant id. Results belong to the teacher and are downloaded as JSON from the teacher page.

## Room size in v1

v1 rooms are for one class: text Q&A and polls, about 40 people, for up to 2 hours. The caps leave some headroom: 60 learners connected at once, 200 participants ever, a window of at most 3 hours, 400 questions (see PROTOCOL.md §6 for the reasons). A request for a larger room is refused with `room_too_large` or `window_too_long`. There are no accounts in v1; **larger rooms will need a light sign-in for teachers later.**

## Abuse controls on room creation

Anyone can open the create page, so creating a room needs:

1. **Cloudflare Turnstile.** The create page shows the widget; `POST /api/rooms` verifies the token server-side with siteverify, using the Worker secret `TURNSTILE_SECRET` (never in the repo). The public site key is the var `TURNSTILE_SITEKEY` in `wrangler.toml`. The room page (which holds the teacher key) and learners never load Turnstile. If the secret is missing, creation fails closed (`503 unavailable`).
2. **A per-sender rate limit**: 5 rooms per 60 s per `CF-Connecting-IP`, with the [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (`CREATE_LIMITER` in `wrangler.toml`). It was chosen over a Durable Object counter because Miniflare implements it locally (so it is tested offline), it keeps no state of ours, and it costs nothing extra. Its counts are per Cloudflare location and eventually consistent, so it is a brake, not an exact quota.
3. **An extra layer, recommended:** a Cloudflare rate-limiting rule (WAF) on `POST /api/rooms`, and a usage alert on the account.

For tests and offline development the server answers Cloudflare's documented Turnstile **test secrets** (`1x…AA` always passes, `2x…AA` always fails, `3x…AA` token already spent) locally, without network; with an empty site key the create page sends Cloudflare's dummy test token, which a production secret rejects. Copy `.dev.vars.example` to `.dev.vars` for `npm run dev`.

## Using it

1. Open the service page (`https://live.egatari.org/`), set the window (up to 3 hours), pass the check, and create a room.
2. **Bookmark the teacher link** that appears (`…/room#room=…&admin=…`). The teacher key in it is shown once; if it is lost, create a new room.
3. Copy the "For the editor" snippet (endpoint, room, key, window) into the editor's export settings, and export the play-only file.
4. During the lesson, keep the teacher page open: open or close the room, admit learners if approval is required, mark questions read, answered, shown or hidden, and watch poll tallies.
5. If the file leaks, **Replace learner key**: everyone with the old key is disconnected; export again with the new key.
6. After the lesson, **Download results (JSON)** before the grace period ends.

## Development

```sh
npm ci
npm test          # vitest + @cloudflare/vitest-pool-workers, fully local (Miniflare/workerd)
npm run dev       # wrangler dev on http://localhost:8787
```

Dependencies are pinned to exact versions. The tests cover creation and joining, a wrong key, key replacement, approval, close and reopen, the expiry alarm, the rate limits (messages and room creation), oversize messages, `Origin: null`, teacher endpoints without the teacher key, the results shape, hibernation, Turnstile (missing, failed and passed tokens; the siteverify call with an injected fetch), the v1 caps, both pages' CSPs, and that every fixture in `protocol/` validates against the schema. No test touches the network.

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

Egatari Live は、配った Egatari の教材の中から、学ぶ人が質問し、投票に答えられるようにするサービスです。QR コードを読んだり別のアプリを開いたりする必要はありません。教員はこのサービスのページで部屋を作り、部屋と参加の鍵を編集アプリの書き出しの設定に貼って、再生専用のファイルを配ります。部屋の時間の窓のあいだ、`live` 拡張に対応した再生アプリは「参加する」のボタンを出し、1 回押すと授業の部屋につながります。

Cloudflare Workers の上で、1 部屋に 1 つの Durable Object を使い、WebSocket Hibernation で待ち時間には課金されません。部屋の外のデータベース、R2、アカウント、Cookie はありません。

### プライバシー

- **保存するもの（その部屋の Durable Object の中だけ）**：部屋の設定（時間の窓・猶予・開閉・承認の設定・参加の鍵・教員の鍵のハッシュ。教員の鍵そのものは保存しない・教員が入れた活動）。参加者ごとに、端末で作った乱数の id、入力したときだけ名前、承認の状態、質問の数。質問（文・活動・段階の鍵・時刻・参加者の id・名前・教員の印）と、投票ごとの最後の 1 票。
- **教員が部屋を作るとき**：送り手の IP アドレスを、作成の回数の上限（Cloudflare の Rate Limiting がメモリ上で 1 分数えるだけで、このサービスは保存しない）と、Cloudflare Turnstile の確認に使います。Turnstile を読み込むのは部屋を作るページだけです。
- **保存も送信もしないもの**：IP アドレスの保存、ブラウザの情報、視聴の位置や時間・再生の操作、そのほかの利用状況の記録は一切ありません。リクエストのログも切ってあります。
- **期間**：部屋とその中身は、時間の窓の終わりから猶予の時間（既定 24 時間、最大 7 日）が過ぎると、Durable Object の alarm で消えます。消えた後は取り戻せません。窓が終わると学ぶ人の接続は切れます。
- **見える人**：質問は教員だけが見ます。教員が「映す」にした質問だけが、名前も id も付けずに学ぶ人に届きます。結果は教員のもので、教員のページから JSON でダウンロードします。

### 使い方

1. サービスのページで時間の窓を決めて、部屋を作る。
2. 表示される教員のリンク（`…/#room=…&admin=…`）を**すぐブックマークする**。教員の鍵は一度しか表示されず、なくしたら部屋を作り直す。
3. 「編集アプリに貼る」の内容（行き先・部屋・鍵・時間の窓）を書き出しの設定に貼り、再生専用のファイルを書き出す。
4. 授業中は教員のページを開いておく：部屋を開ける・閉じる、承認、質問の「読んだ・答えた・映す・隠す」、投票の集計。
5. ファイルが外に出たら「参加の鍵を替える」。古い鍵の人は切断されるので、新しい鍵で書き出し直す。
6. 授業の後、猶予が終わる前に「結果をダウンロード（JSON）」。

### v1 の部屋の大きさと悪用の対策

- v1 の部屋は 1 クラス分です（文字の Q&A と投票、40 人ほど、2 時間まで）。上限は少し余裕を持たせて、同時 60 人・延べ 200 人・時間の窓 3 時間・質問 400 件。もっと大きな部屋は `room_too_large`・`window_too_long` で断ります。v1 にはアカウントがなく、**大きな部屋には、のちに教員の軽いサインインが要ります。**
- 部屋を作るには Cloudflare Turnstile の確認が要り（秘密の鍵は Worker の secret `TURNSTILE_SECRET`、サイトキーは `wrangler.toml` の `TURNSTILE_SITEKEY`）、送り手ごとに 1 分 5 部屋までです（Workers の Rate Limiting。手元の試験でも動くのでこれを選んだ）。Cloudflare の rate limiting のルールも重ねて使うことを勧めます。

### 開発とデプロイ

`npm ci` のあと `npm test` で、手元だけで試験が通ります（Miniflare / workerd）。デプロイは Studio との通しの試験が通った後に手で行います（上の英語の「Deploy」の手順）。Cloudflare のダッシュボードで Turnstile のウィジェットを作り（ホスト名 live.egatari.org、試すなら localhost も）、秘密の鍵は `npx wrangler secret put TURNSTILE_SECRET` で入れます（会話のできるターミナルで）。本番の設定は `wrangler.production.toml`（`routes` の custom domain・`PUBLIC_ORIGIN`・サイトキー入り。`wrangler.toml` は開発と試験用のまま）で、`CLOUDFLARE_ACCOUNT_ID=<アカウントの ID> npx wrangler deploy -c wrangler.production.toml` とすると、DNS の記録と証明書は自動で作られます。アカウントの ID はリポジトリに入れません。

### ライセンス

サービス本体（`protocol/` の外）は **GNU AGPL-3.0**、`protocol/` の Schema・切断の番号・例のメッセージは Studio などが取り込めるように **MIT** です。
