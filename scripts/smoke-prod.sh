#!/usr/bin/env bash
# 本番Worker（hell-ict）の配信物を確かめる。デプロイの最後に
# scripts/deploy-prod.sh が呼ぶ。GETだけなので、単体で何度実行してもよい。
#
#   HELL_ICT_PROD_URL=https://... bash scripts/smoke-prod.sh
#
# 本番のURLはリポジトリに書かず、環境変数 HELL_ICT_PROD_URL で受け取る。deploy-prod.sh は
# リポジトリ直下の .deploy.env（コミットしない）から読んで渡す。
# 反映に少し間があるので、どの確認も数回だけ待って再試行する。
set -euo pipefail

# shellcheck source=scripts/lib/deploy-checks.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-checks.sh"

if [ -z "${HELL_ICT_PROD_URL:-}" ]; then
  echo "ERROR: HELL_ICT_PROD_URL が無い。本番WorkerのURLを渡す（例: set -a; . ./.deploy.env; set +a してから実行する）。" >&2
  exit 1
fi
base="${HELL_ICT_PROD_URL%/}"

# 入口ガードが本番の設定で立ち上がっているかを確かめる。
# eventNoがfalse（EVENT_NO未設定）や"invalid"（書き損じ）なら失敗させる。
# teamMaxは数値のときだけ規則が効いている——"invalid"（TEAM_MAXの書き損じ）は
# 全チームが404になるので、ここで捕まえる。
# scenarioはダミー（"dummy"）でなく、HELL_ICT_EXPECTED_SCENARIO があればそれと一致すること
# ——overlay し損ねてダミーのシナリオが載っていないかを見る（判定は deploy-checks.sh の health_body_ok）。
check_health() {
  for i in 1 2 3 4 5; do
    body=$(curl -fsS "${base}/api/health") && \
      health_body_ok "$body" "${HELL_ICT_EXPECTED_SCENARIO:-}" && \
      echo "health ok: $body" && return 0
    echo "health not ready (attempt $i): ${body:-<no response>}"
    sleep 5
  done
  echo "ERROR: /api/health が status=ok / guards.eventNo=true / guards.teamMax=数値 / scenario=${HELL_ICT_EXPECTED_SCENARIO:-dummy以外} になりません（EVENT_NO・TEAM_MAXの設定と、シナリオの overlay を確認する）" >&2
  exit 1
}

# `/` は本番のVueアプリ（scripts/build-testplay.sh）。
# public/の組み立てを誤ると、APIは生きたまま参加者の開く画面だけが壊れる。200だけでは
# `/` に旧いページが残った場合も通るので、本文で見分ける。
# `/` はViteビルドの器（#root と /app/ のバンドル。apps/web/vite.config.ts の
# build.assetsDir）であり、HTMLが参照する /app/ のJS・CSSもそれぞれ200で返る——
# HTMLだけ届いてバンドルが404だと、参加者の画面は真っ白になる
app_assets_ok() {
  local assets asset
  assets=$(grep -oE '(src|href)="/app/[^"]+"' <<<"$1" | sed -E 's/^(src|href)="//; s/"$//')
  [ -n "$assets" ] || return 1
  for asset in $assets; do
    curl -fsS -o /dev/null "${base}${asset}" || { echo "${asset} が取れません"; return 1; }
  done
}
root_ok() {
  grep -qF '<div id="root"></div>' <<<"$1" &&
    grep -qF 'src="/app/' <<<"$1" &&
    app_assets_ok "$1"
}
check_pages() {
  for check in "/ root_ok"; do
    read -r path fn <<<"$check"
    ok=
    for i in 1 2 3 4 5; do
      if body=$(curl -fsS "${base}${path}") && "$fn" "$body"; then
        echo "${path} ok"
        ok=1
        break
      fi
      echo "${path} not ready (attempt $i)"
      sleep 5
    done
    if [ -z "$ok" ]; then
      echo "ERROR: ${path} の中身が想定と違います（/ はVueアプリとその /app/ のJS・CSS。pnpm build:testplay が public/ を組み立てたかを確認する）" >&2
      exit 1
    fi
  done
}

# 効果音はR2バケット（hell-ict-sounds）から配る。mp3はリポジトリに無いので
# デプロイでは運ばれず、投入し忘れると本番だけ無音になる（進行は止まらないので
# 当日まで気づけない）。代表として1点が200で返ることを確かめる。
# 投入は `bash scripts/upload-sounds.sh`（docs/development-harness.md）。
check_sounds() {
  for i in 1 2 3 4 5; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "${base}/sounds/decision1.mp3")
    if [ "$code" = "200" ]; then
      echo "sounds ok: $code"
      return 0
    fi
    echo "sounds not ready (attempt $i): $code"
    sleep 5
  done
  echo "ERROR: /sounds/decision1.mp3 が200になりません（R2バケット hell-ict-sounds への投入を確認する: bash scripts/upload-sounds.sh）" >&2
  exit 1
}

check_health
check_pages
check_sounds
