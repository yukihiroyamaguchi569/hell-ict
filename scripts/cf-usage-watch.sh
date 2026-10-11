#!/usr/bin/env bash
# 本番の Cloudflare アカウント（無料プラン）の、今日の使用量を無料枠の1日の上限と比べて表示する。
# 10/31 本番の最中に定期的に実行し、アプリが止まる前に Workers Paid へ上げる判断に使う。
# 読み取り（GraphQL Analytics API）だけで、Cloudflare には何も書かない。
#
#   bash scripts/cf-usage-watch.sh
#   CF_USAGE_DATE=2026-10-11 bash scripts/cf-usage-watch.sh   # 過去の1日（UTC）をまるごと見る
#
# 期間は今日の 00:00 UTC（＝ 09:00 JST。無料枠がリセットされる時刻）から今まで。
# CF_USAGE_DATE を渡すと、その日の 00:00〜24:00 UTC になる。
# 集計は数分遅れて反映される。
#
# 認証は apps/worker の wrangler のログイン（wrangler login 済みであること）を使う。
# トークンは表示しない。curl の引数にも載せず、ヘッダーを標準入力（-H @-）で渡す。
# 照会するアカウントは CLOUDFLARE_ACCOUNT_ID があればそれ、無ければ wrangler whoami の
# アカウント（1つだけのとき。複数あれば CLOUDFLARE_ACCOUNT_ID を求めて止まる）。
#
# 終了コード: 0 OK、1 エラー（API の失敗、道具が無い）、2 WARN、3 DANGER。
set -euo pipefail

# shellcheck source=scripts/lib/cf-usage-judge.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf-usage-judge.sh"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

for tool in curl jq pnpm; do
  command -v "$tool" >/dev/null || fail "$tool が無い。"
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worker_dir="$root/apps/worker"
script_name="hell-ict"
# D1 database hell-ict-testplay (apps/worker/wrangler.jsonc).
database_id="cac14ad2-c5d1-44de-9a5a-c644cabbc146"
graphql_url="https://api.cloudflare.com/client/v4/graphql"

# --- period (UTC)
if [ -n "${CF_USAGE_DATE:-}" ]; then
  [[ "$CF_USAGE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
    fail "CF_USAGE_DATE は YYYY-MM-DD で渡す（例: 2026-10-11）。"
  day="$CF_USAGE_DATE"
  end=$(jq -nr --arg d "$day" '($d + "T00:00:00Z" | fromdateiso8601) + 86400 | todate' 2>/dev/null) ||
    fail "CF_USAGE_DATE が日付として読めない: $day"
else
  day=$(date -u +%Y-%m-%d)
  end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi
start="${day}T00:00:00Z"

# --- credentials (the token stays in shell variables only)
token=$(cd "$worker_dir" && pnpm exec wrangler auth token --json 2>/dev/null | jq -r '.token // empty') ||
  fail "wrangler のトークンが取れない。cd apps/worker && pnpm exec wrangler login してから実行する。"
[ -n "$token" ] || fail "wrangler のトークンが空。cd apps/worker && pnpm exec wrangler login してから実行する。"
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  account_id="$CLOUDFLARE_ACCOUNT_ID"
else
  account_ids=$(cd "$worker_dir" && pnpm exec wrangler whoami --json 2>/dev/null | jq -r '.accounts[].id') ||
    fail "wrangler whoami が失敗した。"
  case "$(printf '%s' "$account_ids" | grep -c .)" in
    0) fail "アカウントが無い（wrangler whoami --json の accounts が空）。" ;;
    1) account_id="$account_ids" ;;
    *) fail "ログイン中のアカウントが複数ある。照会するアカウントIDを CLOUDFLARE_ACCOUNT_ID に入れてから実行する。" ;;
  esac
fi

# --- query
# DO の periodic（実行時間・SQLite の行）はスクリプト名で絞れないので、アカウント全体の値。
# 無料枠の上限もアカウント全体にかかる。
query='query($a:String!,$s:Time!,$e:Time!,$db:String!,$w:String!){viewer{accounts(filter:{accountTag:$a}){
workers:workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$s,datetime_lt:$e,scriptName:$w}){sum{requests} dimensions{datetimeHour}}
d1:d1AnalyticsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_lt:$e,databaseId:$db}){sum{rowsRead rowsWritten}}
doRequests:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_lt:$e,scriptName:$w}){sum{requests}}
doPeriodic:durableObjectsPeriodicGroups(limit:100,filter:{datetime_geq:$s,datetime_lt:$e}){sum{duration rowsRead rowsWritten}}
}}}'
body=$(jq -nc --arg q "$query" --arg a "$account_id" --arg s "$start" --arg e "$end" \
  --arg db "$database_id" --arg w "$script_name" \
  '{query: $q, variables: {a: $a, s: $s, e: $e, db: $db, w: $w}}')

response_file="$(mktemp "${TMPDIR:-/tmp}/cf-usage-watch.XXXXXX")"
trap 'rm -f "$response_file"' EXIT
http_code=$(printf 'Authorization: Bearer %s\n' "$token" |
  curl -sS --max-time 30 -o "$response_file" -w '%{http_code}' -H @- \
    -H 'Content-Type: application/json' --data "$body" "$graphql_url") ||
  fail "GraphQL API へ接続できない（ネットワークかタイムアウト）。"
unset token
case "$http_code" in
  2??) ;;
  *) fail "GraphQL API が HTTP $http_code を返した: $(head -c 500 "$response_file")" ;;
esac
jq -e . "$response_file" >/dev/null 2>&1 ||
  fail "GraphQL API の応答が JSON でない: $(head -c 500 "$response_file")"
if jq -e '(.errors // []) | length > 0' "$response_file" >/dev/null; then
  fail "GraphQL API がエラーを返した: $(jq -c '[.errors[].message]' "$response_file")"
fi
acct=$(jq -c '.data.viewer.accounts[0] // empty' "$response_file")
[ -n "$acct" ] || fail "GraphQL API の応答にアカウント $account_id のデータが無い。"
# Each dataset must be an array; an empty array means no traffic (genuinely zero).
echo "$acct" | jq -e '[.workers, .d1, .doRequests, .doPeriodic] | all(type == "array")' >/dev/null ||
  fail "GraphQL API の応答の形が想定と違う: $(echo "$acct" | head -c 500)"

total() { echo "$acct" | jq -r "[.$1[].sum.$2] | add // 0"; }

# --- metrics: label, value, free daily limit, WARN threshold (strictly above)
# Free plan limits: developers.cloudflare.com/workers/platform/limits/,
# /d1/platform/pricing/, /durable-objects/platform/pricing/.
metrics=(
  "Workers リクエスト（${script_name}）|$(total workers requests)|100000|30000"
  "D1 読み取り行（hell-ict-testplay）|$(total d1 rowsRead)|5000000|1500000"
  "D1 書き込み行（hell-ict-testplay）|$(total d1 rowsWritten)|100000|70000"
  "DO リクエスト（${script_name}）|$(total doRequests requests)|100000|30000"
  "DO 実行時間 GB-s（アカウント全体）|$(total doPeriodic duration)|13000|3900"
  "DO SQLite 読み取り行（アカウント全体）|$(total doPeriodic rowsRead)|5000000|1500000"
  "DO SQLite 書き込み行（アカウント全体）|$(total doPeriodic rowsWritten)|100000|30000"
)

echo "Cloudflare 無料枠の使用量: ${start} 〜 ${end}（上限は毎日 09:00 JST にリセット。集計は数分遅れる）"
# Header is written out by hand: printf pads by bytes, not by display width.
echo "判定     使用率         合計 / 上限     指標"
worst=OK
warn_items=()
danger_items=()
for m in "${metrics[@]}"; do
  IFS='|' read -r label value limit warn_at <<<"$m"
  status=$(judge_usage "$value" "$limit" "$warn_at")
  percent=$(usage_percent "$value" "$limit")
  shown=$(awk -v v="$value" 'BEGIN { printf (v == int(v) ? "%d" : "%.1f"), v }')
  printf '%-7s %6s%% %12s / %-8s %s\n' "$status" "$percent" "$shown" "$limit" "$label"
  case "$status" in
    DANGER)
      worst=DANGER
      danger_items+=("$label ${percent}%")
      ;;
    WARN)
      [ "$worst" = DANGER ] || worst=WARN
      warn_items+=("$label ${percent}%")
      ;;
  esac
done

echo
echo "直近の Workers リクエスト（1時間ごと、最大6時間）:"
echo "$acct" | jq -r '.workers | sort_by(.dimensions.datetimeHour) | .[-6:][] |
  (.dimensions.datetimeHour | fromdateiso8601) as $t |
  "  \($t | strftime("%m-%d %H:00")) UTC（\($t + 32400 | strftime("%H:00")) JST） \(.sum.requests)"'
[ "$(echo "$acct" | jq '.workers | length')" -gt 0 ] || echo "  （この期間のリクエストは無い）"

echo
join_items() {
  local IFS=','
  echo "$*" | sed 's/,/, /g'
}
case "$worst" in
  OK) echo "OK" ;;
  WARN) echo "WARN: $(join_items "${warn_items[@]}")" ;;
  DANGER) echo "DANGER: $(join_items "${danger_items[@]}")" ;;
esac
exit "$(status_exit_code "$worst")"
