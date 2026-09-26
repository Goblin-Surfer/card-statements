# card-statements

カード利用明細 分析ツール（GitHub Pagesで公開する静的サイト）

## ファイル

- `index.html` — ログイン画面（Supabaseのマジックリンク認証）。今はこれだけです。
- `.nojekyll` — GitHub PagesがJekyll処理をしないようにする空ファイル。削除しないでください。

## デプロイ

このリポジトリのSettings > Pagesで、Source: Deploy from a branch / Branch: main / Folder: / (root) に設定していれば、
`main` ブランチにpush（またはファイルをアップロード）するだけで自動的に公開されます。

## 今後追加する画面

明細一覧・手入力・分析ダッシュボード・カード設定・自動取得ログは、次のフェーズで `index.html` に追加していきます。
画面のデザイン案は下記のデザインキャンバスを参照してください。

https://claude.ai/artifact/PQBhn2UmdHpn37TScEFxJZ
