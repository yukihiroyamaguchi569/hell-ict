#!/usr/bin/env bash
# 配信物を apps/worker/public/ へ組み立てる。wranglerのAssets配信
# （apps/worker/wrangler.jsonc）がこのディレクトリを配信する。生成物はコミットしない
# （.gitignore対象）。
#
# - `/`（public/index.html と public/app/）: 本番のVueアプリ（apps/web のViteビルド。Issue #238）
# - `/assets/images/production/`: production画像（Vueが参照する）
# - `/dashboard.html`: 会場前面ディスプレイ用の進捗ボード
# - `/ranking.html`: デブリーフィングで会場前面へ映す番付と申し送り（GMトークンで守る）
#
# Vueのビルドをここで行うのは、デプロイ（scripts/deploy-prod.sh）とE2Eの
# webServer（playwright.config.ts）がこのスクリプトしか呼ばないためである。
#
# 効果音mp3はここでは扱わない。再配布禁止のためリポジトリに入っておらず、デプロイ
# （scripts/deploy-prod.sh）が組み立てる origin/main の一時worktreeには無い。
# 配信元はR2（apps/worker/src/sounds.ts）に一本化してあり、投入は
# `bash scripts/upload-sounds.sh` で別に行う。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
assets_src="${repo_root}/assets/images/production"
dashboard_html="${repo_root}/apps/worker/dashboard/index.html"
ranking_html="${repo_root}/apps/worker/dashboard/ranking.html"
public_dir="${repo_root}/apps/worker/public"

web_dist="${repo_root}/apps/web/dist"

rm -rf "${public_dir}"
mkdir -p "${public_dir}/assets/images/production"
# .gitkeepはwranglerのassets.directory実在チェック（クリーンチェックアウト時のbuild/
# test:e2e）を通すために追跡している。rm -rfで消えるので、生成のたびに復元する。
touch "${public_dir}/.gitkeep"

# Vueアプリ（`/`）。ビルド成果物は index.html と app/（vite.config.ts の build.assetsDir）
# だけで、画像の /assets/ とは重ならない。
pnpm --filter @hell-ict/web build
cp -R "${web_dist}"/. "${public_dir}/"

# "-R ... /." + 宛先末尾の"/"で、将来サブディレクトリが増えてもset -eで
# 止まらずに再帰コピーする（"*"グロブは深い階層を素通りしてしまう）。
cp -R "${assets_src}"/. "${public_dir}/assets/images/production/"

# 会場前面ディスプレイ用の進捗ボード（/dashboard.html）。public_dirは毎回rm -rfするので、
# ソースはapps/worker/dashboard/に置き、生成のたびにコピーする。
cp "${dashboard_html}" "${public_dir}/dashboard.html"
cp "${ranking_html}" "${public_dir}/ranking.html"

echo "built: ${public_dir}"
