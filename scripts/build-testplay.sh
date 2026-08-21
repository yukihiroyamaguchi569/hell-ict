#!/usr/bin/env bash
# テストプレイ用に、モックHTML（docs/ui/mock/index.html）とproduction画像を
# apps/worker/public/ へコピーする。wranglerのAssets配信（apps/worker/wrangler.jsonc）が
# このディレクトリを配信する。生成物はコミットしない（.gitignore対象）。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mock_html="${repo_root}/docs/ui/mock/index.html"
assets_src="${repo_root}/assets/images/production"
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

# "-R ... /." + 宛先末尾の"/"で、将来サブディレクトリが増えてもset -eで
# 止まらずに再帰コピーする（"*"グロブは深い階層を素通りしてしまう）。
cp -R "${assets_src}"/. "${public_dir}/assets/images/production/"

echo "built: ${public_dir}"
