# モックの読み方（`index.html` を読む前に）

**捨てる前提の使い捨て実装。** React 実装へ持ち越すのは CSS トークン名（`--bg` `--accent` 等、[00_共通シェルと通奏低音.md](../00_共通シェルと通奏低音.md) 実装メモ）だけで、
JS 構造そのものは資産ではない。単一ファイル・フレームワーク無し・ビルド無し。ブラウザで直接開けば動く。

このファイルは本体 3160 行を頭から読まずに済ませるための地図。**該当関数だけを Read で読む。**

## 動かし方

- ブラウザで直接開く。`#devbar` から任意のシーンへジャンプできる。
- URLハッシュでも起動できる。通常は `STEPS`（後述）の `id` と一致するハッシュ（`#s1` `#s2` 等）が有効。
  **`#s1-nobrief` だけは `STEPS` の `id` ではない開発用エイリアス**——`s1SkipBrief` を立てて `s1` を起動し、
  事務長ブリーフィングを飛ばす（devbar の「Stage 1（説明を飛ばす）」ボタンと同じ経路）。

## 3層構造

| 範囲 | 内容 |
|---|---|
| 4-653 | `<style>`。テーマトークン（`data-mode="peace/alert/crisis"`）、2003年書式（`.legacy` `.reader`）、オーバーレイのCSS一式（`.blackout`/`.lock` を含む） |
| 655-897 | HTML。`#screen` 配下は中央ペイン以外ほぼ静的マークアップ＋オーバーレイの器 |
| 898-3160 | `<script>`（IIFE, `"use strict"`） |

## シーン管理の中核（まずここを読む）

- **`view`**（1362）— 唯一のシーン識別子（文字列）。
- **`STEPS`**（2990-）— シーン定義の**唯一のテーブル**。`{ id, label, mode, note }`。devbar のボタンとURLハッシュ起動はここから自動生成されるので、新シーンを足すときは基本ここに1行足すだけでよい。
- **`go(id, keepMode)`**（3000-）— シーン遷移の本体。冒頭で `clearLater()` と各ステージの `Stop()` を呼んで前のシーンのタイマーを止める（新ステージを足したら**ここに `Stop()` を追加し忘れない**こと）。
- **`hideOverlays()`**（1364-）— オーバーレイIDの配列を舐めて閉じる。新しいオーバーレイを足したらこの配列に追加。Stage 3 以降、罰ゲームが動的に注入した `#grid` 等（`#penalty-grid-host` の中身）もここで一緒に空にする——**`.hide` を付けるだけでは id 重複が残る**（後述の負債参照）。
- **`transition()`**（2896-）— 急変（Stage 1→2 の転調）専用。`go()` を経由しない。

## ステージごとのエントリ

| ステージ | エントリ関数 | 状態 |
|---|---|---|
| Stage 1 | `renderStage1Flood()`（1957） | `s1` オブジェクト1つに集約 |
| Stage 2（火の手） | `renderStage2Excel()`（2004） | `s2Grid` / `s2Hot` / `s2T0` 等、モジュール変数に散在 |
| Stage 2（二正面） | `renderStage2()` | **実装済みだがどこからも呼ばれない＝未配置**（企画書§5「未配置の素材」） |
| Stage 3（嘘） | `renderStage3()`（2474） | 3欄のテキストエリア。判定は `checkStage3()`、罠発火は `triggerTrap()`→`startPenalty()`。苅部さんの3段トリガーは2段に簡略化（`phsS3Pending`） |

文言・教材データの定数は 907-1044 あたりの帯にまとまっている（`S1_MAILS` 等、ステージ別プレフィックス。Stage 3 は `S3_*`）。

## Stage 3：罰ゲームが Stage 2 のグリッド機構を間借りする仕組み

`drawGrid()`/`parseTable()`/`updateRecog()` はデータ非依存だが、列見出しだけ `S2_COLS` を直接見ていたため
`activeCols`（モジュール変数、既定値 `S2_COLS`）を新設し、そこを参照するように変えてある。
`startPenalty()` が `s2Grid`/`s2Hot`/`activeCols` を接触者リスト用に一時退避・差し替え、`finishPenalty()` が復元する。
**Stage 2 の `runVerdict()`/`checkGrid()`/`unlockSequence()` は一切呼ばない**——文言・副作用が Stage 2 専用に直書きされているため、Stage 3 側は `checkStage3()`/`runStage3Verdict()`/`stage3UnlockSequence()`/`checkContactsGrid()`/`finishPenalty()` を別に持つ。

## 既知の設計負債（新ステージを足すと必ず踏む）

- `TEAMS[2].pos`（自チームの位置）の直接代入が8箇所超に散在（Stage 3 分でさらに増えた）。`STEPS` 側に持たせて一元化されていない。
- `#fever`（院内状況インジケータ）の直接代入も同様に散在。
- `unlock` オーバーレイの文言は、表示する側（`unlockSequence()`/`stage3UnlockSequence()`）が**毎回明示的にセットし直す**形にした（Stage 3 追加時に修正済み）。次のステージを足す時もこの流儀を踏襲すること——HTMLの初期値に頼ると、どちらが先に使われたかで文言が化ける。
- `data-mode="crisis"` は Stage 3 で初めて使われるようになった（もう「定義のみで未使用」ではない）。
- 右ペインのAIチャットは Stage 3 に限り台本応答を返すようにした（`sendAI()` が `view !== "s3"` で即 return）。**Stage 1/2 は完全なダミーのまま**——`view` チェックを外すと Stage 1/2 でも「応答しません」を返してしまうので注意。
- `wait()`（Promise版タイマー）は `clearLater()` でキャンセルされない。Stage 3 の新設シーケンス（`triggerTrap()`/`runStage3Verdict()`/`stage3UnlockSequence()`）は要所に `if (view !== "s3") return;` の軽いガードを入れて緩和したが、**根本修正はしていない**——`runVerdict()`/`unlockSequence()`（Stage 2）は今も無防備。
- **動的に注入した要素の id 重複に注意。** `startPenalty()` は `#penalty-grid-host` の中に `id="grid"`/`id="recog"` 等を都度生成する（Stage 2 のグリッドと同じ id をあえて再利用し、`drawGrid()` 等をそのまま使い回すため）。`finishPenalty()` と `hideOverlays()` の両方で `#penalty-grid-host` を空にしないと、**Stage 2 の本物の `#grid` と id が重複して `document.getElementById("grid")` が壊れる**（jsdomでの検証で実際に踏んだ）。同じパターンで新しい注入型UIを足すときは同様の後始末を忘れないこと。
