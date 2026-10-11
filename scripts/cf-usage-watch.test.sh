#!/usr/bin/env bash
# scripts/cf-usage-watch.sh のテスト。`pnpm test:scripts`（verify:checks）から走る。
# 判定は scripts/lib/cf-usage-judge.sh を source して境界を試す。スクリプト全体は、PATH の先頭に
# 偽の curl と pnpm を置いて走らせ、通信せずに終了コードとエラーの扱いを確かめる。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="${here}/lib/cf-usage-judge.sh"
script="${here}/cf-usage-watch.sh"
failures=0
ok() { echo "ok - $1"; }
ng() {
  echo "not ok - $1" >&2
  failures=$((failures + 1))
}

# --- 判定の境界（WARN は閾値を超えたら、DANGER は上限の80%以上）
expect_judge() {
  local got
  got="$(source "${lib}" && judge_usage "$2" "$3" "$4")"
  if [ "${got}" = "$1" ]; then ok "$1: $2 / $3（WARN>$4）"; else ng "$1: $2 / $3（WARN>$4） 実際は ${got}"; fi
}
expect_judge OK 0 100000 30000
expect_judge OK 30000 100000 30000
expect_judge WARN 30001 100000 30000
expect_judge WARN 79999 100000 30000
expect_judge DANGER 80000 100000 30000
expect_judge DANGER 150000 100000 30000
expect_judge OK 70000 100000 70000
expect_judge WARN 70001 100000 70000
expect_judge OK 3900 13000 3900
expect_judge WARN 3900.1 13000 3900
expect_judge DANGER 10400 13000 3900

expect_exit_code() {
  local got
  got="$(source "${lib}" && status_exit_code "$1")"
  if [ "${got}" = "$2" ]; then ok "終了コード $1 → $2"; else ng "終了コード $1 → $2 実際は ${got}"; fi
}
expect_exit_code OK 0
expect_exit_code WARN 2
expect_exit_code DANGER 3

# --- スクリプト全体（偽の curl・pnpm）
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
fake_bin="${work}/bin"
mkdir -p "${fake_bin}"

# Fake pnpm: answers `wrangler auth token --json` and `wrangler whoami --json`.
cat >"${fake_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"auth token"*) jq -nc --arg t "${FAKE_TOKEN-secret-token}" '{type: "oauth"} + (if $t == "" then {} else {token: $t} end)' ;;
  *whoami*) echo '{"accounts":[{"id":"acct-1","name":"test"}]}' ;;
  *) exit 1 ;;
esac
EOF
# Fake curl: writes FAKE_BODY to the -o file, prints FAKE_HTTP as %{http_code},
# exits with FAKE_CURL_EXIT, and records its arguments and stdin (the headers).
cat >"${fake_bin}/curl" <<'EOF'
#!/usr/bin/env bash
out=
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[i]}" = "-o" ] && out="${args[i + 1]}"
done
printf '%s\n' "$@" >"${FAKE_LOG}.args"
cat >"${FAKE_LOG}.stdin"
[ "${FAKE_CURL_EXIT:-0}" = 0 ] || exit "${FAKE_CURL_EXIT}"
printf '%s' "${FAKE_BODY}" >"${out}"
printf '%s' "${FAKE_HTTP:-200}"
EOF
chmod +x "${fake_bin}/pnpm" "${fake_bin}/curl"

# Builds a GraphQL response body with the given totals.
#   $1 workers requests, $2 d1 rowsWritten, $3 do duration
response() {
  jq -nc --argjson w "$1" --argjson d1w "$2" --argjson dur "$3" '{data: {viewer: {accounts: [{
    workers: [{sum: {requests: $w}, dimensions: {datetimeHour: "2026-10-11T10:00:00Z"}}],
    d1: [{sum: {rowsRead: 1000, rowsWritten: $d1w}}],
    doRequests: [{sum: {requests: 10}}],
    doPeriodic: [{sum: {duration: $dur, rowsRead: 5, rowsWritten: 1}}]
  }]}}, errors: null}'
}

# Runs the script with fakes. Sets $out and $code.
run_script() {
  set +e
  out="$(PATH="${fake_bin}:${PATH}" FAKE_LOG="${work}/curl" "$@" bash "${script}" 2>&1)"
  code=$?
  set -e
}
expect_run() { # $1 description, $2 expected exit code, $3 expected text, rest: env assignments
  local desc="$1" want="$2" text="$3"
  shift 3
  run_script env "$@"
  if [ "${code}" = "${want}" ] && grep -qF -- "${text}" <<<"${out}"; then
    ok "${desc}"
  else
    ng "${desc}（終了コード ${code}、出力: ${out}）"
  fi
}

expect_run "使用量が少なければ OK で 0" 0 "OK" FAKE_BODY="$(response 1077 3214 4.3)"
expect_run "Workers 30001 で WARN・2" 2 "WARN: Workers リクエスト（hell-ict） 30.0%" FAKE_BODY="$(response 30001 0 0)"
expect_run "D1 書き込み 80000 で DANGER・3" 3 "DANGER: D1 書き込み行（hell-ict-testplay） 80.0%" FAKE_BODY="$(response 0 80000 0)"
expect_run "DANGER と WARN が混ざれば DANGER" 3 "DANGER: DO 実行時間" FAKE_BODY="$(response 30001 0 10400)"
expect_run "時間ごとの件数を出す" 0 "10-11 10:00 UTC（19:00 JST） 1077" FAKE_BODY="$(response 1077 0 0)"
expect_run "データが無い日は 0 で OK" 0 "（この期間のリクエストは無い）" \
  FAKE_BODY='{"data":{"viewer":{"accounts":[{"workers":[],"d1":[],"doRequests":[],"doPeriodic":[]}]}}}'

expect_run "接続できない（curl の失敗）は 1" 1 "ERROR: GraphQL API へ接続できない" FAKE_CURL_EXIT=28 FAKE_BODY=
expect_run "HTTP 500 は 1" 1 "HTTP 500" FAKE_HTTP=500 FAKE_BODY='oops'
expect_run "GraphQL の errors は 1" 1 "rate limited" \
  FAKE_BODY='{"data":null,"errors":[{"message":"rate limited"}]}'
expect_run "JSON でない応答は 1" 1 "JSON でない" FAKE_BODY='<html>'
expect_run "アカウントのデータが無ければ 1" 1 "データが無い" FAKE_BODY='{"data":{"viewer":{"accounts":[]}}}'
expect_run "データセットが欠ければ 1" 1 "形が想定と違う" \
  FAKE_BODY='{"data":{"viewer":{"accounts":[{"workers":[],"d1":null,"doRequests":[],"doPeriodic":[]}]}}}'
expect_run "トークンが取れなければ 1" 1 "トークンが空" FAKE_TOKEN= FAKE_BODY="$(response 0 0 0)"
expect_run "CF_USAGE_DATE の書式違いは 1" 1 "YYYY-MM-DD" CF_USAGE_DATE=2026/10/11 FAKE_BODY="$(response 0 0 0)"

# The past day covers the whole UTC day, and the token goes via stdin, not argv.
run_script env CF_USAGE_DATE=2026-10-11 FAKE_BODY="$(response 0 0 0)"
if grep -qF '"s":"2026-10-11T00:00:00Z","e":"2026-10-12T00:00:00Z"' "${work}/curl.args"; then
  ok "CF_USAGE_DATE はその日の 00:00〜24:00 UTC"
else
  ng "CF_USAGE_DATE はその日の 00:00〜24:00 UTC（引数: $(cat "${work}/curl.args")）"
fi
if ! grep -qF secret-token "${work}/curl.args" && grep -qF "Bearer secret-token" "${work}/curl.stdin"; then
  ok "トークンは curl の引数に載らず、標準入力で渡る"
else
  ng "トークンは curl の引数に載らず、標準入力で渡る"
fi
if ! grep -qF secret-token <<<"${out}"; then ok "トークンを表示しない"; else ng "トークンを表示しない"; fi

if [ "${failures}" -gt 0 ]; then
  echo "${failures} 件失敗" >&2
  exit 1
fi
echo "すべて成功"
