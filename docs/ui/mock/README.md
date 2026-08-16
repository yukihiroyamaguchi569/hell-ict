# モックの読み方（`index.html` を読む前に）

**捨てる前提の使い捨て実装。** React 実装へ持ち越すのは CSS トークン名（`--bg` `--accent` 等、[00_共通シェルと通奏低音.md](../00_共通シェルと通奏低音.md) 実装メモ）だけで、
JS 構造そのものは資産ではない。単一ファイル・フレームワーク無し・ビルド無し。ブラウザで直接開けば動く。

このファイルは本体 4388 行を頭から読まずに済ませるための地図。**該当関数だけを Read で読む。**

> 📌 **現フェーズではこのモックが正典。** Prologue〜Final まで本編ステージが出揃った段階で、
> `docs/企画書.md` との差分は意図的に放置している（モックが固まってから企画書へ一括反映し、
> そのとき version を上げる）。企画書と食い違う記述を見つけても、**モック側を先に直さない**こと。

## 動かし方

- ブラウザで直接開く。`#devbar` から任意のシーンへジャンプできる。
- URLハッシュでも起動できる。通常は `STEPS`（後述）の `id` と一致するハッシュ（`#s1` `#s2` 等）が有効。
  **`#s1-nobrief` だけは `STEPS` の `id` ではない開発用エイリアス**——`s1SkipBrief` を立てて `s1` を起動し、
  事務長ブリーフィングを飛ばす（devbar の「Stage 1（説明を飛ばす）」ボタンと同じ経路）。

## 3層構造

| 範囲 | 内容 |
|---|---|
| 4-746 | `<style>`。テーマトークン（`data-mode="peace/alert/crisis"`）、2003年書式（`.legacy` `.reader`）、オーバーレイのCSS一式（`.blackout`/`.lock`/`.alarm`/`.callin`/`.goal` を含む） |
| 747-1055 | HTML。`#screen` 配下は中央ペイン以外ほぼ静的マークアップ＋オーバーレイの器 |
| 1056-4388 | `<script>`（IIFE, `"use strict"`） |

## シーン管理の中核（まずここを読む）

- **`view`**（1852）— 唯一のシーン識別子（文字列）。
- **`STEPS`**（4157-）— シーン定義の**唯一のテーブル**。`{ id, label, mode, note }`。devbar のボタンとURLハッシュ起動はここから自動生成されるので、新シーンを足すときは基本ここに1行足すだけでよい。
- **`go(id, keepMode)`**（4170-）— シーン遷移の本体。冒頭で `clearLater()` と各ステージの `Stop()` を呼んで前のシーンのタイマーを止める（新ステージを足したら**ここに `Stop()` を追加し忘れない**こと。Stage 4 は `s4Stop()`（罰の秒読み）と `s4StopDeadline()`（回答期限）の**2本**を呼ぶ——Stage 2 が `s2Stop()`/`s2StopDeadline()` と2本立てなのと同じ理由。Final の `fStop()` は Stage 5 の `s5Stop()` と同じ no-op）。
- **`hideOverlays()`**（1854-）— オーバーレイIDの配列を舐めて閉じる。新しいオーバーレイを足したらこの配列に追加（Final の `#ov-goal` もここに入っている）。Stage 3 以降、罰ゲームが動的に注入した `#grid` 等（`#penalty-host` の中身）もここで一緒に空にする——**`.hide` を付けるだけでは id 重複が残る**（後述の負債参照）。Stage 4 の罰（AI使用ロック）が付ける `pane-r.locked` も、離脱時にここで外す。
- **`transition()`**— 急変（Stage 1→2 の転調）専用。`go()` を経由しない。

## ステージごとのエントリ

| ステージ | エントリ関数 | 状態 |
|---|---|---|
| Stage 1 | `renderStage1Flood()`（2495） | `s1` オブジェクト1つに集約 |
| Stage 2（火の手） | `renderStage2Excel()`（2541） | `s2Grid` / `s2Hot` / `s2T0` 等、モジュール変数に散在 |
| Stage 2（二正面） | `renderStage2()`（4006） | **実装済みだがどこからも呼ばれない＝未配置**（企画書§5「未配置の素材」） |
| Stage 3（暫定） | `renderStage3()`（3038） | 3欄のテキストエリア。判定は `checkStage3()`（3072）、罠発火は `triggerTrap()`（3157）→`startPenalty()`（3170）。苅部さんの3段トリガーは2段に簡略化（`phsS3Pending`） |
| Stage 4（回答） | `renderStage4()`（3331） | 1欄のテキストエリア。判定は `checkStage4()`（3363）。罠は提出フォームではなく **`sendAI()` 内の送信前ゲート**にあり、検知すると `triggerLeak()`（3416）→`startS4Penalty()`（3427）。回答期限（`s4StartDeadline()`3296）超過で近藤さんの着信ポップアップが割り込む（`s4ShowCall()`3327）。苅部さんは1段のみ（`phsS4Pending`） |
| Stage 5（掲示） | `renderStage5()`（3605） | 提出フォームはテキストエリアではなく**画像候補の枠**（`#s5-cand`）。**判定そのものが無い**（企画書§5「提出で次ステージ解錠」）——候補が選ばれていれば `runStage5Verdict()` が即座に解錠する。罠も罰も無いので `triggerXxx()`/`startXxxPenalty()` に相当する関数が無い、`alarm`/`lock`/`blackout` を使わない最初の本編ステージ |
| Final（会見） | `renderFinal()`（3693） | Stage 3 の3欄フォームを1つ増やした**4欄**（`.box`＋`.submit-area`）。判定は `checkFinal()`（3727）、誤り→不足の順で `F_ORDER` の並びを見る4欄版 `checkStage3()`。罠も罰も無く（Stage 5 と同じく `alarm`/`lock`/`blackout` を使わない）、差し戻しのみ。4欄すべて通過すると `unlock` ではなく `goalSequence()`（3795）が専用オーバーレイ `#ov-goal` を開く——**自動で閉じない**（ゲームの終端のため） |

> **参加者に見えるステージ名は「暫定」「回答」「掲示」「会見」**。「嘘」「情報漏洩」「記者会見」は設計ドキュメント上の呼称で、
> Stage 3・4 は画面に出すと罠を予告してしまう（[../04_Stage3.md](../04_Stage3.md) 冒頭 ⚠️・[../05_Stage4.md](../05_Stage4.md) 冒頭 ⚠️）。
> Stage 5・Final に罠は無いので予告の心配自体は無いが、呼称の流儀（体言止め）を Stage 3・4 に揃えてある
> （[../06_Stage5.md](../06_Stage5.md) 冒頭 ⚠️・[../07_Final.md](../07_Final.md) 冒頭 ⚠️）。`unlock` オーバーレイの副題も同じ理由で罠の名前を書かない。

文言・教材データの定数は 1044-1641 あたりの帯にまとまっている（`MAILS`/`MAIL_S1` 等、ステージ別プレフィックス。Stage 3 は `S3_*`、Stage 4 は `S4_*`、Stage 5 は `S5_*`、Final は `F_*`）。

## Stage 3：判定の作り（`S3_REQUIRED`1305 / `S3_TRAP`1321 / `checkStage3`3072）

判定はルールベースのみ。LLM は呼ばない（企画書 §7）。**罠 → 不足の順**で、指す欄は常に画面の並び順
（`S3_ORDER = ["ppe","release","clean"]`）で最初に当たったもの。

- **罠パターンはすべて「罠語があり、かつ正解語が無い」形**にしてある。これは意図的な制約で、
  正典を読んだ上で「アルコールでは不十分」「解熱を根拠にしない」と**正しく否定して書いた提出を誤爆させない**ため。
  罠語だけを見る素朴な実装にすると、**正しく書いたチームほど引っかかる**逆転が起きる。
- **`S3_REQUIRED.ppe` が `個室|コホー` を要求するのが効きどころ。** 汚染教材（早見表）には隔離の行が無いので、
  早見表だけで済ませたチームは構造的にこの欄を満たせない。ただし書き漏らしは嘘ではないので**差し戻し（無罰）**。
- 教材の文言を変えたら**ここも必ず追従させる**。過去に、汚染教材から「アルコール」「解熱後24時間」を消した際に
  正規表現だけが取り残され、**罠が一切発火しない状態**になったことがある。

## Stage 3：罰ゲーム（消毒液ボトルの補充）

`startPenalty()`/`drawBottles()`/`fillBottle()`/`revealNotice()`/`finishPenalty()` の5つで完結する。
Stage 2 のグリッド機構とは**もう一切関わらない**——1本クリック → `S3_BOTTLE_FILL_MS` 待つ → `済`、を繰り返すだけ。
15本目で 5B病棟の6本が湧き（`S3_BOTTLES_TRIGGER`）、全数終わると `revealNotice()` が掲示と師長の一言を出して全数破棄する。

> **旧実装（接触者リストの整形）は全面削除した。** Stage 2 の `drawGrid()` を間借りするために
> `activeCols` というモジュール変数を挟んでいたが、罰の内容を差し替えたことで不要になったので
> `S2_COLS` の直接参照に戻してある。`s2GridBackup`/`s2HotBackup`/`checkContactsGrid()` と
> `docs/materials/stage3_contacts.tsv` も削除済み。**Stage 2 側にはもうStage 3のための仕掛けが無い。**

## Stage 4：送信前ゲートと黒塗り

Stage 3 と違い、**罠は提出フォームではなく AIチャットの送信前ゲートにある**。`sendAI()`（1906）が
Stage 4 のときだけ `S4_PII`（1402）で入力を検査し、ヒットすれば自分の吹き出しを出さずに `triggerLeak()`
（3416）→ `startS4Penalty()`（3427）へ進む。ヒットしなければ従来どおり吹き出しを出し、`S4_REQUEST_TRIGGER`
（1895）にマッチする内容だけ `S4_AI_REPLY` の台本を返す（Stage 3 の `S3_TRAP_TRIGGER` と同じ思想）。

- **`S4_PATIENT`（1373）が唯一の情報源。** 検知パターン（`S4_PII`）・カルテ抜粋（`S4_CHART_TEXT`）・
  黒塗り下書き（`S4_REPORT`）の3箇所とも、ここから作った値だけを参照する。Stage 3 の負債（教材の文言と
  判定の正規表現が別々の場所にあり片方だけ直すと静かに壊れる）を Stage 4 で繰り返さないための構成。
  カルテ抜粋は氏名・ID・生年月日・連絡先を独立した項目欄にせず、**経過欄の文中に織り込んである**——
  項目欄にまとめると個人情報だけが上に固まり、経過欄だけをコピーすればゲートを踏まずに正解ルートへ
  行けてしまうため（`docs/materials/stage4_chart.md` §抜粋の 📌）。
- **罰ゲームは黒塗り（`drawRedact()`/`toggleRedact()`/`submitReport()`）。** `S4_REPORT` は
  `{ t, pii }` の配列——`pii: true` が塗るべきトークン、`pii: false` が塗ってはいけない一般語のトークン、
  `pii` キー無しはクリックできない地の文。**塗る前の見た目はすべて同じ**（`.tok` に統一）——スタイルで
  答えを教えない。
- **AI使用ロックが罰の本体。** `startS4Penalty()` が `paneR.classList.add("locked")` を付け、
  `finishS4Penalty()`と `hideOverlays()` の両方で外す（Stage 3 の `#penalty-host` 後始末と同じ二重の作法）。
- 苅部さんは `S4_KARUBE_LINE`（1464・1行のみ）・`S4_KARUBE_DELAY`（短い・仮値12秒）。カルテ抜粋を `[コピー]`
  した瞬間にも `phsS4Pending` が立つ（`btn-copy` ハンドラ）——時限トリガーとどちらか早い方。
- `#ov-lock` は Stage 3 と共有する。見出し（`#lock-hd`）は `startPenalty()`/`startS4Penalty()` が
  **毎回明示的にセットし直す**（`unlock` オーバーレイと同じ流儀。後述の負債参照）。
- **回答期限（`S4_DEADLINE`＝2分・1473）は Stage 4 だけ実際のカウントダウンにしてある。** `s4StartDeadline()`
  （3296）/`s4StopDeadline()`/`s4DeadlineFrame()` は Stage 2 の `s2StartDeadline()` 系と1対1で対応する
  （課題カードに `#s4-dl`/`#s4-dl-t`/`#s4-dl-b` を持たせ、CSSクラス `.s2-dl` をそのまま再利用）。
  超過すると `s4ShowCall()`（3327）が全画面オーバーレイ `#ov-s4call`（患者相談窓口・近藤さんの着信）を開く——
  **メールの着弾ではなくポップアップにした**（devbar での指示変更。当初はメール3通目だったが、
  「焦りを即座に体感させたい」ため割り込み式に差し替えた）。事務長の Stage 1 ブリーフィングと同じ
  `.sysdlg` の窓を流用し、`.callin` 修飾クラスでタイトルバー文言とポートレートだけ差し替える。
  **近藤さんのイラストは制作済み**——`.por .frame` は
  `assets/images/production/stage4-patient-relations-kondo.png` を事務長の画像と同じ `<img>` で表示する。`alarm`/`lock` は出さない、
  提出もロックしない、判定の必須要素も増やさない——Stage 2 の締切超過（`s2LandAddendum`）と完全に同じ
  「罰は業務ではなく時間そのもの」の扱い。ポップアップは一方向・1回きりなので
  [00_お助けキャラの原則.md](../character/00_お助けキャラの原則.md) §0「窓口ではない登場人物」の枠内——
  新しいウィンドウが増えるが「窓口が増えた」ことにはならない。

## Stage 5：画像生成の出し分けと、判定が無いこと

Stage 5 に罠は無く、**判定そのものも無い**（企画書§5「判定：提出で次ステージ解錠（レースを止めない）」）。
`sendAI()`（1906）は `view === "s5"` のとき `S4_PII` の検査を素通りし、自分の吹き出しを出したあと
`s5Generate()` へ渡す——Stage 3・4 の「罠 → 台本応答」ではなく「プロンプト → 候補画像」という
別の分岐にしてある。

- **モックは gpt-image-1 を呼ばない。** `S5_POSTERS`（1494）の `tag` 正規表現とプロンプト文字列を
  照合し、最初に一致した候補を返す。どれにも一致しなければ `S5_POSTER_DEFAULT`（1502）。
  生成待ちは `S5_GEN_MS`（1550・仮値2.5秒）の `later()` で、実際にAPIを叩いているように見せる。
- **`S5_POSTERS` の `tag` は判定ではなく出し分けにしか使わない。** Stage 2〜4 は判定の正規表現と
  教材文言が食い違うと静かに壊れる負債を踏んだが、Stage 5 は判定という工程自体が無いので同種の負債が
  存在しない——`tag` がどれにも一致しなくても `S5_POSTER_DEFAULT` を返すだけで、生成は失敗しない。
- **`runStage5Verdict()` に「まだ足りません」の分岐は無い。** 候補が選ばれていれば
  （`s5Selected !== null`）、確認演出を挟んで即座に `stage5UnlockSequence()` を呼ぶだけ。
  Stage 2〜4 の `checkStageN()`/差し戻しに相当する関数は Stage 5 に存在しない。
- **生成回数の上限（`S5_GEN_LIMIT`）に達すると、生成せずに苅部さんの2段目
  （`S5_KARUBE_LIMIT_LINE`）を光らせる。** `phsRing()` のクリックハンドラで `phsS5LimitPending` を
  `phsS5Pending`（通常トリガー）より優先して見せる。**上限後も、それまでに生成した候補
  （`s5Candidates`）はいつでも選んで提出できる**——詰みを作らない（企画書§6）。
- **`s5PickCandidate()`（3580）で選んだ候補だけが `#s5-cand`（`s5DrawCandidate()`3587）に反映される。**
  AIチャット上の候補ボタンを押すまで、中央ペインの提出候補は「未選択」のまま——生成しただけでは
  提出は完了しない（`[提出する]` はUI上の親切として非活性になるだけで、これも判定ではない）。
- **画像アセットは `<img onerror>` でフォールバックする。** `assets/images/production/` に
  `stage5-poster-*.png` の4点（pictogram/multilingual/textheavy/default）がまだ無くても、
  候補ボタンとサムネイルの枠・代替テキストだけで最後まで操作できる。ファイルが揃えば
  コードを変更せずに差し替わる。

## Final：4欄判定とゴール（`renderFinal`3693 / `checkFinal`3727 / `runFinalVerdict`3735 / `goalSequence`3795）

Final に罠は無いが、**Stage 3 の3欄フォームを1欄増やして判定は残す**——Stage 5 の「判定そのものが無い」
形とは違う（企画書§5「LLM採点（ルーブリック方式）」から、モックはルールベース判定に変更した。
[../scenario/07_Final_記者会見.md](../scenario/07_Final_記者会見.md) 冒頭 📌）。

- **`checkFinal()`（3727）は `checkStage3()` の4欄版。** `F_ORDER = ["qa","family","staff","press"]`
  の並びで、誤り（`F_WRONG`）→不足（`F_REQUIRED`）の順に最初に当たった1欄だけを返す。
- **④ `press` の誤り判定は Stage 4 の `S4_PII`（1402）をそのまま参照する（`F_WRONG.press`）。**
  新規の検知パターンを作らない——教材と判定を二重管理しない Stage 4 の構成をここでも踏襲する。
- **罰は無い。** `triggerXxx()`/`startXxxPenalty()` に相当する関数は無く、`runFinalVerdict()`（3735）は
  差し戻し（`.box.warn`）を出すだけで `alarm`/`lock`/`blackout` を一度も呼ばない——Stage 5 に続き
  本編で2番目のステージ。
- **最終セーフティは差し戻し回数で発火する。** `fRejectCount` が2に達すると `fNudgeKarube()`（3780）が
  `phsFSafetyPending` を立てる——罠発火のような明確なトリガーが無いため、Stage 3/4 の「罠を踏んだら」
  ではなく「差し戻しを繰り返したら」を発火条件にした（`docs/character/苅部さん.md` §4 Final 行）。
- **通過すると `unlock` ではなく `goalSequence()`（3795）が `#ov-goal` を開く。** `hideOverlays()` の
  ID配列に `"ov-goal"` を追加済み。`#ov-unlock` と違い**自動では閉じない**——次のステージが無いため。
  `drawMarks()` は任意の第1引数 `targetId` を取れるように一般化してあり（既定 `"marks"`）、
  `goalSequence()` は `drawMarks("goal-marks")` で同じ関数をゴール演出のリーダーボードにも使い回す。
- **AIチャットは Stage 3・4 と同じ台本方式に戻る。** `sendAI()`（1906）のガードに `view !== "final"` を
  追加し、`F_REQUEST_TRIGGER` にマッチすると断定調の `F_AI_REPLY` が返る——そのまま貼ると①④の
  未確定明示チェックに当たって差し戻される（罠ではなく GPT-4o の素の癖）。送信前ゲート（PII検知）は
  Stage 5 と同じく働かせない。

## 既知の設計負債（新ステージを足すと必ず踏む）

- `TEAMS[2].pos`（自チームの位置）の直接代入が10箇所超に散在（Stage 3・4・5・Final 分でさらに増えた）。`STEPS` 側に持たせて一元化されていない。
- `#fever`（院内状況インジケータ）の直接代入も同様に散在。Stage 4・5・Final は値を動かさない（14のまま）が、リセット処理では他の値に戻す必要があり、結局同じ場所に手を入れることになる。
- `unlock` オーバーレイの文言は、表示する側（`unlockSequence()`/`stage3UnlockSequence()`/`stage4UnlockSequence()`/`stage5UnlockSequence()`）が**毎回明示的にセットし直す**形にした（Stage 3 追加時に修正済み）。**`#ov-lock` の見出し（`#lock-hd`）も Stage 4 追加時に同じ流儀に揃えた**——HTMLの初期値に頼ると、どちらが先に使われたかで文言が化ける。次のステージを足す時もこの流儀を踏襲すること（Stage 5・Final は罠・罰が無いので `#ov-lock` 自体を触らない——`stage5UnlockSequence()` は `#ov-unlock` だけを、`goalSequence()` は新設の `#ov-goal`（`#goal-t`/`#goal-s`）だけをセットし直す）。
- `data-mode="crisis"` は Stage 3 で初めて使われるようになった。Stage 4・5・Final も `crisis` のまま（転調は起きない）。
- 右ペインのAIチャットは Stage 3・4・5・Final に限り応答を返すようにした（`sendAI()` が `view !== "s3" && view !== "s4" && view !== "s5" && view !== "final"` で即 return）。**Stage 1/2 は完全なダミーのまま**——`view` チェックを外すと Stage 1/2 でも「応答しません」を返してしまうので注意。Stage 5 だけは台本の文章応答ではなく `s5Generate()` へ分岐する。Final は Stage 3・4 と同じ台本方式（`F_REQUEST_TRIGGER`→`F_AI_REPLY`）に戻る。
- `wait()`（Promise版タイマー）は `clearLater()` でキャンセルされない。Stage 3・4・5・Final の新設シーケンスは要所に `if (view !== "s3") return;` / `if (view !== "s4") return;` / `if (view !== "s5") return;` / `if (view !== "final") return;` の軽いガードを入れて緩和したが、**根本修正はしていない**——`runVerdict()`/`unlockSequence()`（Stage 2）は今も無防備。
- **動的に注入した要素は必ず後始末する。** `startPenalty()`/`startS4Penalty()` は `#penalty-host` の中身を都度生成するので、`finishPenalty()`/`finishS4Penalty()` と `hideOverlays()` の両方で空にしている。旧実装では注入側が `id="grid"` を再利用しており、消し忘れると**Stage 2 の本物の `#grid` と id が重複して `document.getElementById("grid")` が壊れた**（jsdomでの検証で実際に踏んだ）。現在の実装は id を再利用していないが、後始末の作法は同じく必要。**Stage 4 は `pane-r.locked` という別種の後始末も増えた**（同じく `finishS4Penalty()` と `hideOverlays()` の両方で外す）。**Stage 5・Final は罰ゲームが無いので `#penalty-host`/`pane-r.locked` の後始末は不要**——Stage 5 は代わりに `#s5-gen`（残り生成回数の表示）を `go()` の共通リセットで毎回 `hide` に戻し `renderStage5()` だけが外す、という独自の器を持つが、Final にはその種の専用静的要素も無い（4欄フォームは Stage 3 の `.box`/`.submit-area` を丸ごと再利用しているため）。
- **教材の文言と判定の正規表現が別々の場所にある。** Stage 3 は教材 `S3_MANUAL_TEXT`/`S3_CONTAMINATED_TEXT`/`S3_TRAP_LIE` と判定 `S3_REQUIRED`/`S3_TRAP` が別々。片方だけ直すと静かに壊れる（罠が発火しない／正解が通らない）。**Stage 4 はこの負債を踏まない設計にした**（`S4_PATIENT` を単一情報源にして検知パターン・黒塗り下書きの両方に参照させる。上記「Stage 4：送信前ゲートと黒塗り」参照）が、値を直すときは派生する定数（`S4_PII`・`S4_REPORT`）が自動的に追従することを忘れないこと（テンプレートリテラルで組んでいるので通常は壊れないが、正規表現側は `new RegExp()` で毎回組み立てている点に注意）。**Stage 5 はそもそも判定が無いので、この種の負債自体が存在しない**（企画書§5「提出で次ステージ解錠」。上記「Stage 5：画像生成の出し分けと、判定が無いこと」参照）——`S5_POSTERS` の `tag` は出し分けにしか使わないので、教材文言と食い違っても「候補画像が変わらない」以上のことは起きない。**Final の④判定は Stage 4 の `S4_PII` を直接参照するので、この負債を最初から踏まない**——ただし①③の誤り語・正解語（`F_WRONG`/`F_REQUIRED`）は Final 独自の正規表現であり、Stage 3 の教材（`stage3_manual.md`）や AI 台本（`F_AI_REPLY`）の文言を変えたら手動で追従させる必要がある点は Stage 3 と同じ負債を抱えている。
- **`go()` の分岐が8ブロックに増えた。** Final 追加で `entry/welcome/inbox`・`s1`・`s2`・`unlock`・`s3`・`s4`・`s5`・`final` の8つになり、各ブロックが後続ステージのメールフラグを手書きで消す構造（README 既知の負債）がそのまま続いている——Final を追加した際も既存7ブロック全てに `hasFJimuMail`/`hasFKohoMail` の初期化を追記する必要があった。次のステージ（あれば）を足すときも同じ作業が要る。

## 残りの宿題

- **苅部さんの3段トリガーが2段のまま**（`S3_KARUBE_LINES` は2行）。設計上は3段目＝最終セーフティ（規定時間 or 2回目の罠発火で詰み防止）。
- **`S3_KARUBE_DELAY`（40秒）/ `S3_PENALTY`（40秒）/ `S3_BOTTLE_FILL_MS`（700ms）/ `S4_KARUBE_DELAY`（12秒）/ `S4_PENALTY`（40秒）/ `S4_GATE_MS`（450ms）/ `S4_DEADLINE`（2分）/ `S5_KARUBE_DELAY`（40秒）/ `S5_GEN_LIMIT`（5回）/ `S5_GEN_MS`（2.5秒）/ `F_KARUBE_DELAY`（40秒）は仮値。** P0 実測で確定させる（罰ゲームの狙いは1分程度。`S4_DEADLINE` は企画書の「目安12分」から変更した値で、特に実測の裏付けが要る——[05_Stage4_情報漏洩.md](../scenario/05_Stage4_情報漏洩.md) 冒頭 📌）。
- **Stage 5 の候補画像4点（`stage5-poster-pictogram/multilingual/textheavy/default.png`）が未制作。** `assets/images/production/` にまだ無く、モックは `<img onerror>` のフォールバック表示で動いている。gpt-image-1 で別途制作し、`test/` → `production/` の昇格ルール（`assets/images/README.md`）に従って置く。
- **Final のゴール演出（`#ov-goal`）に音が無い。** `docs/ui/07_Final.md` §4 のとおり、モックは意図的に無音のまま実装してある。本番でファンファーレを付ける際、他のオーバーレイに音を実装するタイミングと合わせて対応する。
- **企画書が旧い罰ゲーム（接触者リスト整形）のまま。** §5・§6・§10 と `docs/research/03_地獄のICT概要.md` に記述が残っている。モックが正なので放置しているが、企画書へ一括反映するときに直す。Stage 4 の教材・罰の記述も同様に未同期。Final の判定（企画書は「LLM採点（ルーブリック方式）」、モックはルールベース）も同様に未反映（[07_Final_記者会見.md](../scenario/07_Final_記者会見.md) 冒頭 📌）。
