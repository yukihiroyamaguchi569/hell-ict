#!/usr/bin/env bash
# scripts/cf-usage-watch.sh が使う、無料枠の使用量の判定。
# テスト（scripts/cf-usage-watch.test.sh）から source して試せるよう、ここでは通信しない。

# Ratio of the daily limit at which a metric becomes DANGER.
CF_USAGE_DANGER_RATIO=0.8

# Prints OK, WARN or DANGER for one metric.
#   $1 value used so far today, $2 free daily limit, $3 WARN threshold (strictly above it)
# DANGER takes precedence: value >= 80% of the limit.
judge_usage() {
  awk -v v="$1" -v limit="$2" -v warn="$3" -v ratio="$CF_USAGE_DANGER_RATIO" 'BEGIN {
    if (v >= limit * ratio) print "DANGER"
    else if (v > warn) print "WARN"
    else print "OK"
  }'
}

# Prints the share of the limit used, with one decimal (e.g. 12.3).
usage_percent() {
  awk -v v="$1" -v limit="$2" 'BEGIN { printf "%.1f", v * 100 / limit }'
}

# Maps the worst status to the script exit code: OK 0, WARN 2, DANGER 3.
status_exit_code() {
  case "$1" in
    OK) echo 0 ;;
    WARN) echo 2 ;;
    DANGER) echo 3 ;;
    *) return 1 ;;
  esac
}
