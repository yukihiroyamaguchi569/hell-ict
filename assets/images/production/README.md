# 本番画像の出典

ここに列挙していない PNG は本プロジェクトで生成した肖像。

| ファイル | 出典 | 作者 | ライセンス | 加工 |
|---|---|---|---|---|
| `stage3-penalty-bottle.svg` | Wikimedia Commons [File:Hand_sanitizer.svg](https://commons.wikimedia.org/wiki/File:Hand_sanitizer.svg)（Open Clip Art Library 由来） | Algot Runeman | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)（帰属不要・改変自由） | 原色（ポンプとキャップのマゼンタ、ラベルのシアン、液の赤）を暗い病院UIに馴染むグレー系へ塗り替え、Inkscape の編集メタデータを削除。ラベル面の英字「HAND SANITIZER」は小さなマスでは読めないため削除し、無地にして状態の文字を重ねる。形はそれ以外原本のまま |
| `stage3-penalty-sanitizer-irasutoya.png` | いらすとや [アルコール消毒液のイラスト](https://www.irasutoya.com/2020/02/blog-post_103.html) | いらすとや（みふねたかし） | [いらすとやの利用規約](https://www.irasutoya.com/p/terms.html)（商用可・クレジット不要。1作品につき素材20点まで。素材自体を主体とする再配布は禁止） | 611×679 の原本を 108×120 へ縮小（配信を軽くするため。表示は高さ54pxなのでDPR2でも足りる）。絵そのものは切り取りも塗り替えもしていない |

どちらも Stage 3 の罰ゲーム（拡大対応業務：消毒液ボトルの補充）で使う。使い方は
[docs/ui/04_Stage3.md](../../../docs/ui/04_Stage3.md) §罰ゲーム を参照。

## 解像度の決め方

当日は会場の回線でこのディレクトリごと配る（`scripts/build-testplay.sh`）ので、**表示寸法の2倍（DPR 2）を超える画素は持たない**。

画面は1280×720の固定サイズで、`fit()` が `Math.min(1, 幅/1280)` で**縮める方向にしか**変倍しない。つまりCSSの表示寸法が device px の上限であり、その2倍が必要な解像度の上限になる。

| 用途 | 表示寸法（CSS px） | 置く解像度 |
|---|---|---|
| 肖像（`.sysdlg .por .frame`。`object-fit: cover` で幅が効く） | 138×150 固定（`--fs-scale` を掛けない） | 幅280前後 |
| 罰ゲームの消毒液（`.lock .note.icon img`） | 高さ54 固定 | 108×120 |
| ポスター（`stage5-poster-*.png`） | ライトボックス（`#ov-lightbox`）でビューポート高に応じて伸びる（下記） | 800×1131 を保つ（縮めると拡大時に粗くなる） |

ポスターだけは表の上限が効かない。`.lightbox img` は `width/height: auto` に `max-height: 90vh` と `max-width: 90vw` を掛けただけなので、**画像は自然寸法（800×1131 CSS px）まで素直に大きくなり、`90vh` はそれを超えないよう頭を押さえるだけ**である。したがって要素の描画寸法は最大 800×1131 CSS px ＝ DPR 2 で 1600×2262 device px 相当まで要求されうる。

ビューポート 1512×860（`fit()` の倍率が1になる幅、DPR 2）で実測すると要素は 547×774 CSS px、必要量は 1094×1548 device px で、**すでに原本の 1131 では足りていない**（1.37倍に引き伸ばされている）。どの条件でもポスターは必要量を下回る側にしかならないので、削れる画素が無い。

`.screen` は 720px 高で `overflow: hidden` なので、774 CSS px の要素は上下がクリップされて 720 分しか見えない。ただし**根拠に使うのは可視領域ではなく要素の寸法**である——見えている帯も要素全体と同じ倍率でラスタライズされるため、クリップは必要解像度を下げない。
