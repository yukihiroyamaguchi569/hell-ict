#!/usr/bin/env bash
# 他社の予備（AI_ROUTE=fallback。Anthropic の OpenAI 互換の接続先）へ、手元の Worker を
# 通して本物のチャットを数回送る確認。本番には触れない。
#
#   read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY
#   bash scripts/ai-fallback-smoke.sh
#
# wrangler dev --local を予備の設定で起動し、テスト用のチームで入室してチャットを送り、
# 応答の有無・所要時間・活動ログの aiRoute を表示して、終わったら dev を止める。
#
# キーの扱い: ファイル（.dev.vars など）には書かない。wrangler dev へ --var で渡すので、
# dev が動いている間（数十秒）はプロセスの引数に載り、同じ機械の ps から見える。
# 自分の端末で実行し、終わったら dev を止める（このスクリプトが止める）。
# D1・DO は一時ディレクトリ（--persist-to）のローカルだけを使い、終わったら消す。
# --remote は使わない。主系（OpenAI）の宛先は届かないアドレスへ向けるので、予備へ
# 切り替わっていなければ OpenAI へは送らずに失敗する。
#
# 任意の環境変数:
#   AI_FALLBACK_MODEL  予備のモデル（既定 claude-haiku-5-5）
#   SMOKE_PORT         wrangler dev のポート（既定 8931）
set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY が無い。read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY してから実行する。" >&2
  exit 1
fi
for tool in curl jq uuidgen; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool が無い。" >&2; exit 1; }
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worker_dir="$root/apps/worker"
wrangler="$worker_dir/node_modules/.bin/wrangler"
[ -x "$wrangler" ] || { echo "ERROR: wrangler が無い。pnpm install してから実行する。" >&2; exit 1; }

port="${SMOKE_PORT:-8931}"
origin="http://127.0.0.1:${port}"
model="${AI_FALLBACK_MODEL:-claude-haiku-5-5}"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/ai-fallback-smoke.XXXXXX")"
dev_log="$state_dir/wrangler-dev.log"
dev_pid=

cleanup() {
  if [ -n "$dev_pid" ] && kill -0 "$dev_pid" 2>/dev/null; then
    kill "$dev_pid" 2>/dev/null || true
    wait "$dev_pid" 2>/dev/null || true
  fi
  rm -rf "$state_dir"
}
trap cleanup EXIT INT TERM

if curl -fsS -o /dev/null "$origin/api/health" 2>/dev/null; then
  echo "ERROR: ポート $port で別のサーバが動いている。SMOKE_PORT=<空いているポート> で実行する。" >&2
  exit 1
fi

# 開催回は手元だけの値（99）。.dev.vars に EVENT_NO があっても、ここで決めたチームコードで入れる。
event_no=99
team_code="${event_no}$(printf '%04d' $((RANDOM % 9999 + 1)))"

echo "wrangler dev を予備の設定で起動する（ポート ${port}、モデル ${model}）..."
(
  cd "$worker_dir"
  exec "$wrangler" dev --local --ip 127.0.0.1 --port "$port" --persist-to "$state_dir/state" \
    --var "AI_ROUTE:fallback" \
    --var "AI_FALLBACK_BASE_URL:https://api.anthropic.com/v1" \
    --var "AI_FALLBACK_API_KEY:${ANTHROPIC_API_KEY}" \
    --var "AI_FALLBACK_MODEL:${model}" \
    --var "OPENAI_BASE_URL:http://127.0.0.1:9/v1" \
    --var "OPENAI_API_KEY:unused-on-fallback" \
    --var "EVENT_NO:${event_no}" \
    --var "TEAM_MAX:9999"
) >"$dev_log" 2>&1 &
dev_pid=$!

health=
for _ in $(seq 1 60); do
  if health=$(curl -fsS "$origin/api/health" 2>/dev/null); then break; fi
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    echo "ERROR: wrangler dev が起動しなかった。ログ:" >&2
    tail -30 "$dev_log" >&2
    exit 1
  fi
  sleep 1
done
[ -n "$health" ] || { echo "ERROR: 60秒待っても /api/health が返らない。" >&2; tail -30 "$dev_log" >&2; exit 1; }
echo "health の ai: $(jq -c .ai <<<"$health")"
if [ "$(jq -r .ai.route <<<"$health")" != "fallback" ]; then
  echo "ERROR: ai.route が fallback になっていない（予備の設定が読まれていない）。" >&2
  exit 1
fi

# API は Origin を見るので、Worker 自身の Origin を付ける。
post() {
  curl -sS -o "$state_dir/body.json" -w '%{http_code} %{time_total}\n' \
    -H "Origin: $origin" -H 'content-type: application/json' -d "$2" "$origin$1"
}
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

read -r status _ < <(post /api/session "$(jq -nc --arg t "$team_code" '{teamCode: $t}')")
[ "$status" = 200 ] || { echo "ERROR: 入室に失敗（${status}）: $(cat "$state_dir/body.json")" >&2; exit 1; }
generation=$(jq -r '.generation' "$state_dir/body.json")
echo "入室: チーム ${team_code}（generation ${generation}）"

read -r status _ < <(post "/api/teams/$team_code/chat/threads" \
  "$(jq -nc --arg c "$(uuid)" --argjson g "$generation" \
    '{type: "create-thread", commandId: $c, title: "予備の確認", generation: $g}')")
[ "$status" = 200 ] || { echo "ERROR: 会話の作成に失敗（${status}）: $(cat "$state_dir/body.json")" >&2; exit 1; }
thread_id=$(jq -r '.snapshot.threads[0].threadId' "$state_dir/body.json")

prompts=(
  "来週の感染対策委員会の開催案内を、病棟の看護師長向けに3行で書いてください。"
  "手指衛生の遵守率が下がっています。朝礼で使える一言の呼びかけを2つ考えてください。"
  "インフルエンザの面会制限を家族へ知らせる掲示文を、やさしい言葉で5行以内にしてください。"
)
failed=0
for i in "${!prompts[@]}"; do
  read -r status seconds < <(post "/api/teams/$team_code/chat/messages" \
    "$(jq -nc --arg c "$(uuid)" --arg th "$thread_id" --arg tx "${prompts[$i]}" --argjson g "$generation" \
      '{type: "send-message", commandId: $c, threadId: $th, text: $tx, generation: $g}')")
  if [ "$status" = 200 ]; then
    reply=$(jq -r '.assistant.text' "$state_dir/body.json" | tr '\n' ' ' | cut -c1-80)
    echo "送信$((i + 1)): 200 ${seconds}秒 応答: ${reply}"
  else
    echo "送信$((i + 1)): ${status} ${seconds}秒 失敗: $(head -c 200 "$state_dir/body.json")"
    failed=1
  fi
done

# 活動ログは応答の後に書かれる（waitUntil）ので、少し待ってから読む。
sleep 2
echo "活動ログ（このチームの chat.*）:"
rows=$(cd "$worker_dir" && "$wrangler" d1 execute hell-ict-testplay --local --persist-to "$state_dir/state" --json \
  --command "SELECT kind, json_extract(meta, '\$.aiRoute') AS aiRoute, json_extract(meta, '\$.failureReason') AS failureReason, json_extract(meta, '\$.httpStatus') AS httpStatus FROM activity_events WHERE team_code = '${team_code}' AND kind LIKE 'chat.%' ORDER BY id" 2>/dev/null)
jq -r '.[0].results[] | "  \(.kind)\taiRoute=\(.aiRoute)\(if .failureReason then "\tfailure=\(.failureReason) \(.httpStatus // "")" else "" end)"' <<<"$rows"
if jq -e '[.[0].results[] | select(.kind != "chat.user" and .aiRoute != "fallback")] | length > 0' <<<"$rows" >/dev/null; then
  echo "ERROR: aiRoute が fallback でない行がある。" >&2
  failed=1
fi

if [ "$failed" = 0 ]; then
  echo "OK: 予備（${model}）で応答が返り、活動ログの aiRoute は fallback。"
else
  echo "NG: 失敗した送信があった。上の表示と、Anthropic のキー・クレジットを確かめる。" >&2
  exit 1
fi
