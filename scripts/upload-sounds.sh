#!/usr/bin/env bash
# 効果音mp3をR2バケット（hell-ict-sounds）へ投入する。
#
# 音源は効果音ラボで、規約が素材の再配布を禁じている。このリポジトリは公開なので
# assets/sounds/ は .gitignore で除外してあり、mp3の実体はコミットされていない。
# main へのマージで走る自動デプロイ（.github/workflows/deploy.yml）はクリーン
# チェックアウトなので、音源を静的アセットとして同梱することはできない。
# そのため配信元をR2へ一本化し、投入だけを手元から行う（apps/worker/src/sounds.ts）。
#
#   bash scripts/upload-sounds.sh            # 本番R2（--remote）へ入れる
#   bash scripts/upload-sounds.sh --local    # wrangler dev のローカルR2へ入れる
#
# 音源を差し替えたときと、R2バケットを作り直したときだけ実行すればよい。
# 同じキーへの再投入は上書きなので、何度実行しても構わない。
set -euo pipefail

bucket="hell-ict-sounds"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sounds_src="${repo_root}/assets/sounds"
worker_dir="${repo_root}/apps/worker"

# 既定は本番R2。--local を付けたときだけ wrangler dev が使うローカルR2を対象にする。
target="--remote"
case "${1-}" in
  --local) target="--local" ;;
  --remote | "") ;;
  *)
    echo "使い方: bash scripts/upload-sounds.sh [--local|--remote]" >&2
    exit 2
    ;;
esac

if [ ! -d "${sounds_src}" ]; then
  echo "error: ${sounds_src} が無い。効果音ラボの7点を置いてから実行する。" >&2
  exit 1
fi

# wranglerはapps/worker/wrangler.jsoncのbindingを読むので、そこで実行する。
cd "${worker_dir}"

# バケットが無ければ作る。既にあると wrangler は失敗するので、一覧で確かめてから作る。
if ! pnpm exec wrangler r2 bucket list | grep -q "^name: *${bucket}\$"; then
  echo "creating bucket: ${bucket}"
  pnpm exec wrangler r2 bucket create "${bucket}"
fi

# .DS_Store を持ち込まないよう拡張子で絞る。一致が無いときにグロブ文字列そのものを
# 渡さないよう、実在チェックで読み飛ばす（build-testplay.sh と同じ書き方）。
uploaded=0
for file in "${sounds_src}"/*.mp3; do
  [ -e "${file}" ] || continue
  key="$(basename "${file}")"
  echo "put ${bucket}/${key} (${target})"
  pnpm exec wrangler r2 object put "${bucket}/${key}" \
    --file "${file}" \
    --content-type "audio/mpeg" \
    "${target}"
  uploaded=$((uploaded + 1))
done

if [ "${uploaded}" -eq 0 ]; then
  echo "error: ${sounds_src} に .mp3 が1つも無い。" >&2
  exit 1
fi

echo "uploaded: ${uploaded} file(s) -> ${bucket} (${target})"
