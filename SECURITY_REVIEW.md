# セキュリティ点検結果

点検日: 2026-10-17 ／ 対象: このリポジトリ全体（HTML/JS、`supabase/functions/import-csv`、`supabase/config.toml`）

本番のSupabaseには触っていません。リポジトリ内のコードとコミット履歴（全43コミット）だけを調べています。
「直した？」が「手順あり」のものは、Supabaseダッシュボードでの操作が必要です。

## まとめ

| # | 重大度 | 問題 | 直した？ |
|---|---|---|---|
| 1 | 高 | RLSのポリシーがリポジトリに無く、本番の状態を確認できない | マイグレーションを追加（**本番で適用・確認が必要**） |
| 2 | 高 | Edge Functionが、ログインさえしていれば誰でも全ユーザーのカードを対象に実行できた | 直した |
| 3 | 高 | 新規登録の制限がクライアント側（`shouldCreateUser:false`）だけ | 手順あり |
| 4 | 中 | AI（Cloudflare）呼び出しの上限・連打対策が無かった | 直した |
| 5 | 中 | Edge Functionのエラー応答に内部情報（Google APIの応答など）が混ざる | 直した |
| 6 | 中 | マジックリンクのリダイレクト先の許可リストが未確認 | 手順あり |
| 7 | 低 | cron用シークレットの比較が通常の文字列比較 | 直した |
| 8 | 低 | 一部のHTML出力でエスケープ漏れ（`cards.html` の aria-label、`logs.html` のステータス） | 直した |
| 9 | 低 | supabase-js をバージョン固定・SRIなしでCDNから読み込み | 手順あり |
| 10 | 情報 | 鍵・秘密情報の混入 | 問題なし |

## 1. RLS（高）

リポジトリに `supabase/migrations/` が無く、ポリシーを確認できませんでした。JS側は全ページで `supabaseClient.from(...)` から直接テーブルを読み書きしており、`user_id` で絞り込む処理はほぼありません（`categorize.html` などで `insert` 時に `user_id` を渡すだけ）。つまり**他人の行を守っているのはRLSだけ**です。ここが未設定または不十分だと、公開されているanon keyを持つ誰でも全員の明細を読めます。

- 影響: 全ユーザーの利用明細・カード名・下4桁の漏えい／改ざん
- 直し方: `supabase/migrations/20261017000000_enable_rls.sql` を追加。`cards` `card_statements` `categories` `subcategories` `merchant_categories` は本人の行のみ select/insert/update/delete（updateは `with check` で `user_id` の付け替えも禁止）。`import_logs` は本人分の読み取りのみ。`csv_import_profiles` は読み取りのみ。いずれも anon の権限は剥奪。
- 直した？: SQLは用意した。**本番への適用は手動**。

### RLSの確認手順（本番に流す前に）

1. ダッシュボード → Authentication → Policies で、上記7テーブルの現状のポリシーを確認する（既にあるなら内容が同等かを見る）。
2. SQL Editor でこのマイグレーションを流す（冪等。同名ポリシーは作り直される）。または `supabase db push`。
3. 確認:
   - ログアウト状態で `curl "https://<project>.supabase.co/rest/v1/card_statements?select=*" -H "apikey: <anon key>"` → `[]` または401になること。
   - 別のテストユーザーでログインし、本人以外の行が `select` で見えないこと。
4. 注意: テーブルに `user_id` 列が無い場合、`create policy` がエラーになります（その場合は列名に合わせて修正してください）。`csv_import_profiles` を画面から編集する運用がある場合は、書き込みポリシーを足す必要があります。

## 2. Edge Function の権限（高・修正済み）

`import-csv` は `--no-verify-jwt` でデプロイされ、関数内で「ログイン中のユーザーなら誰でも」実行を許可し、その後 service_role で**全ユーザーの有効なカードすべて**を処理していました。

- 影響: 別のログインユーザーが他人の分まで実行を起動できる（Drive/AI APIの消費、他人のログ作成）。応答の `summary` に他人のカード名・ファイル名が含まれる。
- 直し方: 画面（JWT）からの呼び出しは、**呼び出したユーザー本人のカードだけ**を対象にした。Cronからの呼び出し（`x-cron-secret`）は従来どおり全員分。
- 直した？: はい。**再デプロイが必要**（`supabase functions deploy import-csv --no-verify-jwt`）。

その他の確認結果:
- CORS: `Access-Control-Allow-Origin` は `https://goblin-surfer.github.io` に限定されており問題なし（`*` ではない）。
- ユーザーIDの扱い: ユーザーIDはリクエストボディではなくJWT（`auth.getUser()`）から取っており、信頼してよい。リクエストボディは使っていない。
- 入力検証: 入力はCSVの中身のみ（Google Drive上のファイル）。金額・日付は検証してから登録している。

## 3. 新規登録の制限（高・手順あり）

`index.html` は `shouldCreateUser: false` を渡していますが、これはクライアント側の指定です。anon keyは公開なので、直接Auth APIを叩けば**新規ユーザーを作れる**可能性があります（Supabaseのサインアップが有効な場合）。ユーザーが作れると、RLSが正しければ自分の行しか見えませんが、Edge Functionやストレージの消費に使われます。

- 直し方（ダッシュボード）: Authentication → Sign In / Providers（または Settings）で **「Allow new users to sign up」をオフ**にする。以後のユーザーは Authentication → Users → Add user（Send invite または Create new user）で作成する。
- ローカル用 `supabase/config.toml` の `enable_signup = true` は本番設定ではない（ローカル開発用）ため触っていない。

## 4. AI APIのコスト乱用（中・修正済み）

- 問題: 初めての利用先ごとにCloudflare Workers AIを呼ぶが、1回の実行あたりの上限が無かった。画面の「今すぐ実行」も連打できた。
- 直し方: 1回の実行あたりのAI呼び出しを200回までに制限（`MAX_AI_CALLS_PER_RUN`）。画面からの実行は、前回の実行から60秒以内なら429で断る（`MANUAL_RUN_MIN_INTERVAL_SEC`）。利用先名は改行を除き100文字に切ってからプロンプトに入れる（プロンプトの汚染を減らす）。AIの出力は選択肢との完全一致でしか使わないため、出力側の注入は問題なし。
- 鍵の扱い: `CLOUDFLARE_API_TOKEN` などは `Deno.env` から読んでおり、リポジトリには無い。Cloudflare側では、トークンの権限を Workers AI のみに絞り、利用上限（アラート）を設定しておくと安心。

## 5. エラーメッセージからの情報漏れ（中・修正済み）

- 問題: 最上位の `catch` が `errorMessage(e)`（例: Googleのトークン更新失敗の応答JSONそのもの）をクライアントに返していた。
- 直し方: クライアントには固定の文言を返し、詳細は `console.error`（Supabaseの関数ログ）のみ。Googleの応答を例外メッセージに含めるのもやめた。ユーザー自身の `import_logs.error_message` にはこれまでどおりファイル単位のエラーが残る。

## 6. マジックリンクのリダイレクト先（中・手順あり）

`index.html` は `emailRedirectTo: location.origin + location.pathname` を使っています。値自体は固定的で問題ありませんが、サーバー側の許可リストが緩いと、細工したリンクでトークンが別オリジンに渡る危険があります。

- 手順: Authentication → URL Configuration で
  - Site URL: 公開しているURL（`https://goblin-surfer.github.io/card-statements/` など実際の公開先）
  - Redirect URLs: 上記のみ。`*` や `http://localhost` 系は本番では入れない。
- `supabase/config.toml` の `site_url` は `http://127.0.0.1:3000`（ローカル用）なので、本番には影響しない。

## 7. cronシークレットの比較（低・修正済み）

`x-cron-secret` の比較を定数時間の比較に変更。シークレット未設定のときはCron経由の認証を通さない。

## 8. HTMLのXSS（低・一部修正）

利用先名・カテゴリ名・メモ・カード名を `innerHTML` に入れる箇所はほぼすべて `escapeHtml` / `esc` を通していました。見つかった漏れは次の2つで、いずれも**本人が入れたデータが本人の画面にしか出ない**ため影響は小さいが、直しました。
- `cards.html`: スイッチの `aria-label` に `c.name` を無加工で埋め込んでいた → `escapeAttr` を通した。
- `logs.html`: ステータス表示が、未知のステータス値のときにDBの値をそのまま出していた → `escapeHtml` を通した。

CSPヘッダー（GitHub Pagesでは `<meta http-equiv>` で代用）はインラインスクリプトが多く、入れるとページが動かなくなるため今回は見送り。

## 9. CDNのスクリプト（低・手順あり）

全ページが `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2` を、バージョン固定・SRI（`integrity`）なしで読み込んでいます。CDN側が改ざんされるとログイン情報を盗まれ得ます。

- 手順: 動作確認した版（例 `@supabase/supabase-js@2.x.y`）に固定し、`integrity="sha384-..."` と `crossorigin="anonymous"` を付ける。画面の動作確認が必要なため、今回は変更していません。

## 10. 鍵・秘密情報（情報）

全コミット履歴を検索し、`service_role`・`sb_secret_`・JWT形式の鍵・Googleのクライアントシークレット／リフレッシュトークン・DB接続文字列は見つかりませんでした（`service_role` は説明文のコメントのみ）。`supabase-client.js` にあるのは Project URL と publishable key だけで、公開される仕様なので問題ありません。`supabase/.gitignore` は `.env.local` 等を除外済み。

## デプロイ時のチェックリスト

- [ ] RLSのSQLを適用し、上記の手順で確認
- [ ] サインアップをオフにする
- [ ] Auth の Site URL / Redirect URLs を確認
- [ ] `supabase functions deploy import-csv --no-verify-jwt` で再デプロイ
- [ ] （任意）supabase-jsのバージョン固定とSRI
