# Video assets

- `trailer/`: 宣伝トレイラーの生成済みクリップ（12カット）

ファイル名は `assets/images/test/trailer/` のキーフレーム画像と番号・語幹を揃えてある。
構成案 `docs/visual/宣伝トレイラー構成案.md` §2 のタイムラインとそのまま照合できる。

## 共通仕様

| 項目 | 値 |
|---|---|
| 解像度 | 1280 × 720 |
| フレームレート | 24 fps |
| コーデック | H.264 |
| 尺 | 8秒（カット01のみ5秒） |

Resolve のプロジェクトは**この値で作成する**。フレームレートはクリップ読み込み後だと
変更に制約が出るため、プロジェクト作成直後に設定すること。

720p のまま仕上げる。素材が 720p なので拡大しても実体が増えず、
1本だけ出自の違うカット01と画質を揃える方を優先した。

## カット一覧

| # | ファイル | 構成案の時間 | 生成 |
|---|---|---|---|
| 01 | `01-saint-chronos-hospital-exterior.mp4` | 2〜5秒 | Kling |
| 02b | `02b-ict-incoming-outbreak-reports.mp4` | 5〜8秒 | Veo 3.1 Lite |
| 03 | `03-alarmed-hospital-corridor.mp4` | 8〜11秒 | Veo 3.1 Lite |
| 04 | `04-overwhelming-ict-workload.mp4` | 11〜14秒 | Veo 3.1 Lite |
| 05 | `05-ict-badge-executives-pov.mp4` | 14〜17秒 | Veo 3.1 Lite |
| 06 | `06-administrative-director-documents.mp4` | 17〜20秒 | Veo 3.1 Lite |
| 07 | `07-nursing-director-red-pen.mp4` | 20〜23秒 | Veo 3.1 Lite |
| 08 | `08-director-press-conference.mp4` | 23〜26秒 | Veo 3.1 Lite |
| 09 | `09-ai-workflow-acceleration.mp4` | 30〜34秒 | Veo 3.1 Lite |
| 10 | `10-team-leaderboard-stage-doors.mp4` | 34〜38秒 | Veo 3.1 Lite |
| 11 | `11-empty-press-conference-flashes.mp4` | 38〜42秒 | Veo 3.1 Lite |
| 12 | `12-executives-final-key-visual.mp4` | 42〜46秒 | Veo 3.1 Fast |

構成案の **26〜30秒**（「次々に襲いかかる、最悪最恐のシチュエーション。」）には
対応するカットが無い。1枚の画で受けるビートではなくモンタージュを要求している箇所なので、
上記クリップの未使用部分を 0.5〜1秒ずつ刻んで繋ぐ。新規生成は不要。

## 編集時の必須事項

**8秒生成に対し使うのは3〜4秒。** どこを切り出すかは画作りの判断で選ぶ。
既定のイン点は 0.00（1フレーム目が入力したキーフレーム画像そのもので、最も構図が整っている）。

**カット04 のみ冒頭でクリップボードが浮くため 2.50 から使う。** 他11本にこの現象は出ていない。
一時期これを「フレームモード生成の性質」として全カットに適用する記述にしていたが、
実際の観測は04の1件のみであり、一般化は誤りだった。

**Veo 生成分にはネイティブ音声が焼き込まれている。** 読み込んだらオーディオを無効化する。
音響は構成案 §6 に従って自前で作るため、これが鳴っていると混ざる。
カット01（Kling）のみ音声トラックを持たない。
