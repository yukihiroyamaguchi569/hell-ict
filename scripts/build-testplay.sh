#!/usr/bin/env bash
# テストプレイ用に、モックHTML（docs/ui/mock/index.html）とproduction画像を
# apps/worker/public/ へコピーする。wranglerのAssets配信（apps/worker/wrangler.jsonc）が
# このディレクトリを配信する。生成物はコミットしない（.gitignore対象）。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mock_html="${repo_root}/docs/ui/mock/index.html"
assets_src="${repo_root}/assets/images/production"
sounds_src="${repo_root}/assets/sounds"
public_dir="${repo_root}/apps/worker/public"

rm -rf "${public_dir}"
mkdir -p "${public_dir}/assets/images/production"
# .gitkeepはwranglerのassets.directory実在チェック（クリーンチェックアウト時のbuild/
# test:e2e）を通すために追跡している。rm -rfで消えるので、生成のたびに復元する。
touch "${public_dir}/.gitkeep"

# モックHTMLは"../../../assets/..."という相対パスで画像を参照している
# （docs/ui/mock/からリポジトリ直下assets/への相対パス）。配信ルートでは
# 同じ階層に置くため"assets/..."へ書き換える。
sed 's#\.\./\.\./\.\./assets/#assets/#g' "${mock_html}" > "${public_dir}/index.html"

# 配信版だけ、開発用の枠（見出し .masthead／開発用スイッチャ .devbar／選択中
# ステージの解説 .caption／画面右端のジャンプ引き出し .jump）を既定で隠す。
# 解説文には罠の種明かしがそのまま書いてあり、ジャンプ引き出しは参加者が
# ステージを飛ばせてしまうため、どちらも参加者の画面に出したままにできない。
# モック本体（docs/ui/mock/
# index.html）は変更しないので、ブラウザで直接開く開発時は今までどおり見える
# （モック側 .masthead のコメントに書かれた「加工はbuild-testplay.shの責務」）。
#
# ファシリテーター用の切り替えは URL ハッシュ #devbar：アドレスバーの末尾に
# 付けてEnterを押すと、リロードなしで表示/非表示が切り替わる（hashchange）。
# リロードを伴う復帰時（進行台本 §5-1）は、最初から #devbar を付けて開けば
# 表示された状態で始まる。押した後にハッシュは消すので、同じ操作を何度でも
# 繰り返せる。
cat >> "${public_dir}/index.html" <<'HTML'

<!-- ===== ここから下は scripts/build-testplay.sh が配信版にだけ足すもの ===== -->
<style>
  body:not(.chrome-on) .masthead,
  body:not(.chrome-on) .devbar,
  body:not(.chrome-on) .caption,
  body:not(.chrome-on) .jump { display: none !important; }
</style>
<script>
(() => {
  "use strict";
  const KEY = "#devbar";
  const clearHash = () => history.replaceState(null, "", location.pathname + location.search);
  if (location.hash === KEY) { document.body.classList.add("chrome-on"); clearHash(); }
  window.addEventListener("hashchange", () => {
    if (location.hash !== KEY) return;
    document.body.classList.toggle("chrome-on");
    clearHash();
  });
})();
</script>
HTML

# "-R ... /." + 宛先末尾の"/"で、将来サブディレクトリが増えてもset -eで
# 止まらずに再帰コピーする（"*"グロブは深い階層を素通りしてしまう）。
cp -R "${assets_src}"/. "${public_dir}/assets/images/production/"

# 効果音（効果音ラボ）。mp3は.gitignoreでリポジトリから除外してあるので、
# クリーンチェックアウトや音源を置いていない環境ではディレクトリごと存在しない。
# 音が鳴らないだけでモックは動く（モック側 sfx() が再生失敗を握りつぶす）ため、
# 無くてもビルドは失敗させない。モックは "sounds/<name>.mp3" で参照する。
# .DS_Store を持ち込まないよう、拡張子で明示的に絞ってコピーする。
if [ -d "${sounds_src}" ]; then
  mkdir -p "${public_dir}/sounds"
  # nullglob 相当：一致が無いときにグロブ文字列そのものをcpへ渡さない。
  found=0
  for f in "${sounds_src}"/*.mp3; do
    [ -e "${f}" ] || continue
    cp "${f}" "${public_dir}/sounds/"
    found=$((found + 1))
  done
  echo "sounds: ${found} file(s)"
else
  echo "sounds: skipped (${sounds_src} not found)"
fi

echo "built: ${public_dir}"
