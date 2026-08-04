# Audio assets

- `trailer/`: **宣伝トレイラー**で採用が確定した音。映像音響の標準に合わせて3つに分ける。
  - `trailer/voice/`: 台詞（DX）
  - `trailer/sfx/`: 効果音（SFX）
  - `trailer/music/`: 音楽（MX）
- `production/`: **アプリ本体**で使用する音。まだ無い。
- `test/`: 生成・収集した候補
  - `test/voice/`: 台詞の音声（Gemini 3.1 Flash TTS で生成）
  - `test/sfx/`: 効果音

採用する際は、テスト素材を上書きせず `trailer/` の該当サブディレクトリへコピーする。

`trailer/` と `production/` を分けているのは、**トレイラーとアプリで素材の公開先も寿命も違う**ため。
アプリはいずれアラーム音やタイマー音を必要とするので、その置き場を最初から空けてある。
台詞・効果音・音楽を分けているのは、最終ミックスでもステムとして別々に保つ必要があるから
（音楽だけ差し替える、台詞を抜いた版を作る、といった要求に作り直しなしで応えられる）。

## 採用テイク（`trailer/voice/`）

| ファイル | 話者 | ボイス | 状態 |
|---|---|---|---|
| `pa-announcement-ict-respond.wav` | 院内放送 | 未記録 | 確定 |
| `director-welcome-umbriel.wav` | 院長 | Umbriel | 確定 |
| `administrative-director-signature-lapetus.wav` | 事務長 | Iapetus | 確定（テイクは1本のみ） |
| `nursing-director-start-now-kore.wav` | 看護部長 | Kore | **暫定**。他テイクと迷いあり |

不採用テイクは `test/voice/` に残してある。差し替えは `trailer/voice/` の該当ファイルを
入れ替えるだけでよい。

## 音声（`test/voice/`）

Google AI Studio の Gemini 3.1 Flash TTS Preview で生成。ファイル名の末尾は使用したボイス名。
話者ごとに複数テイクを録り、聴き比べて選ぶ。

| ファイル | 話者 | 台詞 | 使用箇所 |
|---|---|---|---|
| `director-welcome-{schedar,umbriel,zuben}.wav` | 院長 | ようこそ、聖クロノス病院へ。優秀なICTの諸君。 | 14〜17秒 |
| `administrative-director-signature-lapetus.wav` | 事務長 | 署名だけで結構です。 | 17〜20秒 |
| `nursing-director-start-now-{autonoe,gacrux,kore}.wav` | 看護部長 | 説明は終わりです。今すぐ始めてください。 | 20〜23秒 |
| `pa-announcement-ict-respond.wav` | 院内放送 | 感染制御チーム、至急応答してください。 | 2〜5秒 |

院内放送のみ使用ボイス名を記録していない。再生成が必要になった場合は
`[事務的に][抑揚を抑えて]` を付けて作り直す。スピーカー越しの歪みは編集時に付ける
（EQ で低域と高域を削り、軽く歪ませる）。

## 効果音（`test/sfx/`）

| ファイル | 出典 | 元の名称 | 使用箇所 |
|---|---|---|---|
| `phone-desk-ring-a.mp3` | 効果音ラボ | 電話の着信音 | 冒頭の業務音（0〜11秒） |
| `phone-desk-ring-b.mp3` | 効果音ラボ | 電話の呼び出し音 | 同上（重ねて飽和させる） |
| `phs-ring.mp3` | 効果音ラボ | 携帯電話の着信音1 | PHS代用・同上 |
| `printer-dot-matrix.mp3` | 効果音ラボ | プリンタで印刷 | 同上 |
| `alarm-emergency.mp3` | 効果音ラボ | 警報が鳴る | 同上（業務音の芯） |
| `heartbeat-low.mp3` | Pixabay | tbsfx-heartbeat | 11秒〜（低い心拍音） |
| `id-card-drop.mp3` | Pixabay | carddrop | 14秒（職員証の着地音） |
| `unlock-beep.mp3` | 効果音ラボ | ニュースタイトル表示4 | 34〜38秒（解錠音） |
| `countdown-electronic.mp3` | 効果音ラボ | カウントダウン電子音 | 34〜38秒（ゲージの進行音） |
| `camera-shutter-burst.mp3` | Pixabay | camera burst shutter | 38〜42秒（フラッシュ音） |
| `impact-title.mp3` | 効果音ラボ | 文字表示の衝撃音2 | 42秒（タイトルの低い衝撃音） |

### ライセンス

- **効果音ラボ**（<https://soundeffect-lab.info/>）: 商用利用可・クレジット表記不要・利用報告不要。
  音源そのものの再配布は不可。
- **Pixabay**（<https://pixabay.com/sound-effects/>）: 帰属表示不要で商用利用可。

## 音楽

未定。構成案 §6 は前半を音楽なしと定めているため、**まず音楽なしで組み、
間が持たない場合に追加する**方針。追加する場合の置き場は `trailer/music/`。

## 編集

DaVinci Resolve で編集する。冒頭 0〜11秒 で業務音を4系統以上重ねる必要があり
（構成案 §6）、多層オーディオを扱えることが選定理由。
