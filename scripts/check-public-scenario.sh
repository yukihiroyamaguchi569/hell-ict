#!/usr/bin/env bash
# public に本物のシナリオが紛れ込んでいないかを確かめる（Issue #368）。`pnpm verify:checks` から走る。
#
#   bash scripts/check-public-scenario.sh [<root>]    # root の既定はこのスクリプトのあるリポジトリ
#
# 次をすべて満たせば 0、どれかが外れれば 1 で止まる。
#   1. packages/content/src/scenario.ts の scenarioId が "dummy"（public の content はダミーシナリオ）
#   2. packages/content/test/scenario/・packages/domain/test/scenario/ が無い（本物のテストは private だけ）
#   3. overlay のマーカー .scenario-overlay が無い（本物を重ねた作業ツリーではない）
#   4. ネタバレ語のリストがあるときだけ、bash scripts/public-snapshot.sh HEAD が 0
#      （除外漏れ・ネタバレ語が無い）。リストは docs/public-banned-words.txt、無ければ
#      HELL_ICT_BANNED_WORDS（環境変数か、root 直下の .deploy.env）が指す hell-ict-scenario の写し。
#      語のリストは private 側にだけあるので、CI や公開用スナップショットの中では飛ばす。
#      HEAD を見るので、未コミットの変更は見ない。変数が指すファイルが無いときと、リストは
#      あるのに語が1つも無いときは止まる（検査が黙って効かなくなるため）。
set -euo pipefail

root="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)"
failures=0
fail() {
  echo "エラー: $1" >&2
  failures=$((failures + 1))
}

scenario_file="${root}/packages/content/src/scenario.ts"
if [ ! -f "${scenario_file}" ]; then
  fail "scenario.ts が無い: ${scenario_file}"
else
  # コメント行を除き、scenarioId を含む行がちょうど1行で、それが dummy の export であることを求める
  # （別の値で上書きする行や、2つ目の export を見逃さない）。
  code="$(grep -vE '^[[:space:]]*(//|/\*|\*)' "${scenario_file}" || true)"
  mentions="$(grep -c 'scenarioId' <<<"${code}" || true)"
  ids="$(sed -nE 's/^export const scenarioId = "([^"]*)";$/\1/p' <<<"${code}")"
  if [ "${mentions}" != "1" ] || [ "${ids}" != "dummy" ]; then
    fail "scenarioId が dummy ではない（${scenario_file}）。public の content はダミーシナリオにする。"
  fi
fi

for dir in packages/content/test/scenario packages/domain/test/scenario; do
  [ ! -e "${root}/${dir}" ] || fail "${dir} がある。本物のシナリオのテストは hell-ict-scenario にだけ置く。"
done

[ ! -e "${root}/.scenario-overlay" ] ||
  fail "本物のシナリオを overlay 中（${root}/.scenario-overlay）。bash scripts/scenario-overlay.sh restore で戻す。"

# shellcheck source=scripts/lib/public-lists.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/public-lists.sh"
if ! banned_list="$(public_banned_words_file "${root}")"; then
  fail "ネタバレ語のリストの場所を決められない（HELL_ICT_BANNED_WORDS か .deploy.env を直す）。"
elif [ -z "${banned_list}" ]; then
  echo "注意: ネタバレ語のリスト（docs/public-banned-words.txt か HELL_ICT_BANNED_WORDS）が無いので、公開用スナップショットの検査は飛ばす。"
elif ! grep -qvE '^[[:space:]]*(#|$)' "${banned_list}"; then
  # 語が1つも無いリストは、検査を黙って無効にする（リストが無い＝CI や公開用スナップショットの中とは別）。
  fail "ネタバレ語のリスト（${banned_list}）に語が1つも無い。語の検査が効かなくなる。"
elif ! (cd "${root}" && HELL_ICT_BANNED_WORDS="${banned_list}" bash scripts/public-snapshot.sh HEAD >/dev/null); then
  fail "公開用スナップショット（HEAD）に除外漏れかネタバレ語がある。bash scripts/public-snapshot.sh HEAD で中身を見る。"
fi

if [ "${failures}" -gt 0 ]; then
  exit 1
fi
echo "public のシナリオ: ダミーのみ（問題なし）"
