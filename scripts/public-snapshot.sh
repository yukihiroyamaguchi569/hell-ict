#!/usr/bin/env bash
# 公開用スナップショット（public repo の中身）を一時ディレクトリに組み立てて検査する（Issue #368）。
#
#   bash scripts/public-snapshot.sh [--verify] [--out <dir>] [<ref>]    # ref の既定は origin/main
#
# ref を git archive で取り出し、scripts/public-exclude.txt の除外を当ててから、次を報告する。
#   1. 除外漏れ: 外すはずのファイルが残っていないか。外したファイルの名前を参照しているファイルが
#      残っていないか（ファイル単位の除外だけを見る）。
#   2. サイズ・ファイル数・大きいファイル上位10件。
#   3. ネタバレ語: ネタバレ語のリストの語（固定文字列）を全文検索する。
#   4. --verify を付けたときだけ、スナップショットの写しの中で pnpm install と pnpm verify:checks を流す。
# --out を付けたときは、1〜4 がすべて通ったときだけ、スナップショット（verify で入れた
# node_modules などは含まない）を <dir> に置く。<dir> がすでにあれば、検査の前に止まる。
#
# 除外リストは、ref ではなく今いるリポジトリ（作業ツリー）のものを読む。語のリストは
# docs/public-banned-words.txt、無ければ HELL_ICT_BANNED_WORDS（環境変数か .deploy.env）が指す
# hell-ict-scenario の写しを読む（scripts/lib/public-lists.sh）。どちらも無ければ使い方の誤りで止まる。
# push や GitHub への操作はしない。一時ディレクトリは終了時に消す。
#
# 終了コード: 0 問題なし / 1 除外漏れ / 2 ネタバレ語のヒット / 3 verify の失敗 / 4 --out の書き出しの失敗 /
# 64 使い方の誤り。複数に当たるときは 1、3、2 の順に優先する。
set -euo pipefail

# shellcheck source=scripts/lib/public-lists.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/public-lists.sh"

fail() {
  echo "エラー: $*" >&2
  exit 64
}

verify=0
ref=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify) verify=1 ;;
    --out)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "--out には置き場所を指定する"
      out="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) fail "知らないオプション: $1" ;;
    *)
      [ -z "${ref}" ] || fail "ref は1つだけ指定する"
      ref="$1"
      ;;
  esac
  shift
done
ref="${ref:-origin/main}"

if [ -n "${out}" ]; then
  [ ! -e "${out}" ] && [ ! -L "${out}" ] || fail "--out の置き場所がすでにある: ${out}"
  [ -d "$(dirname "${out}")" ] || fail "--out の置き場所の親ディレクトリが無い: ${out}"
  out="$(cd "$(dirname "${out}")" && pwd)/$(basename "${out}")"
fi

root="$(git rev-parse --show-toplevel)"
exclude_list="${root}/scripts/public-exclude.txt"
[ -f "${exclude_list}" ] || fail "除外リストが無い: ${exclude_list}"
banned_list="$(public_banned_words_file "${root}")" || exit 64
[ -n "${banned_list}" ] ||
  fail "ネタバレ語のリストが無い（${root}/docs/public-banned-words.txt も HELL_ICT_BANNED_WORDS も無い）"
# 語が1つも無いリストでは語の検査が黙って効かなくなる（--out で未検査のものを置いてしまう）ので止める。
[ -n "$(public_banned_words "${banned_list}")" ] || fail "ネタバレ語のリスト（${banned_list}）に語が1つも無い"
git -C "${root}" rev-parse --verify --quiet "${ref}^{commit}" >/dev/null || fail "ref が見つからない: ${ref}"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
snap="${work}/snapshot"
mkdir -p "${snap}"

rules="${work}/rules.txt"
public_strip_list "${exclude_list}" >"${rules}"

# 標準入力のパスのうち、除外されるものを出す。mode=unused なら、どのパスにも当たらなかった行を出す。
apply_rules() { public_apply_rules "${rules}" "${1:-excluded}"; }

list_snapshot() { (cd "${snap}" && find . \( -type f -o -type l \) | sed 's|^\./||' | LC_ALL=C sort); }

echo "== 対象: ${ref}（$(git -C "${root}" rev-parse --short "${ref}^{commit}")）"
git -C "${root}" archive --format=tar "${ref}" | tar -x -C "${snap}"

unused="$(list_snapshot | apply_rules unused)"
if [ -n "${unused}" ]; then
  echo "注意: 除外リストのうち、ref のどのファイルにも当たらない行がある（古い行かもしれない）"
  echo "${unused}" | sed 's/^/  /'
fi

removed=0
while IFS= read -r path; do
  rm -f "${snap}/${path}"
  removed=$((removed + 1))
done < <(list_snapshot | apply_rules excluded)
find "${snap}" -type d -empty -delete
echo "除外したファイル: ${removed} 件"

# --- 1. 除外漏れ
leaks="$(list_snapshot | apply_rules excluded)"
exclude_rel="scripts/public-exclude.txt"
while IFS= read -r line; do
  case "${line}" in !* | */) continue ;; esac
  name="$(basename "${line}")"
  refs="$(cd "${snap}" && LC_ALL=C grep -rlF --binary-files=text -e "${name}" . | sed 's|^\./||' | grep -vxF "${exclude_rel}" || true)"
  [ -z "${refs}" ] || leaks+="${leaks:+$'\n'}$(echo "${refs}" | sed "s|\$| （外した ${name} を参照している）|")"
done <"${rules}"

status=0
if [ -n "${leaks}" ]; then
  echo "== 除外漏れ: あり"
  echo "${leaks}" | sed 's/^/  /'
  status=1
else
  echo "== 除外漏れ: なし"
fi

# --- 2. サイズ
count="$(list_snapshot | wc -l | tr -d ' ')"
size_kb="$(du -sk "${snap}" | cut -f1)"
echo "== サイズ: ${size_kb} KB、${count} ファイル"
echo "大きいファイル上位10件（バイト）:"
(cd "${snap}" && list_snapshot | perl -ne 'chomp; printf "%10d  %s\n", -s $_, $_' | sort -rn | awk 'NR <= 10')

# --- 3. ネタバレ語
words="${work}/words.txt"
public_banned_words "${banned_list}" >"${words}"
hits="$(cd "${snap}" && LC_ALL=C grep -roF --binary-files=text -f "${words}" . | sed 's|^\./||' | LC_ALL=C sort | uniq -c || true)"
if [ -n "${hits}" ]; then
  echo "== ネタバレ語: ヒットあり（$(echo "${hits}" | awk '{s += $1} END {print s}') 件）"
  # uniq -c の「件数 パス:語」を「パス: 語 ×件数」に並べ替える。
  echo "${hits}" | awk '{c = $1; sub(/^ *[0-9]+ /, ""); i = index($0, ":"); printf "  %s: %s ×%d\n", substr($0, 1, i - 1), substr($0, i + 1), c}'
  [ "${status}" -ne 0 ] || status=2
else
  echo "== ネタバレ語: ヒットなし"
fi

# --- 4. verify
if [ "${verify}" -eq 1 ]; then
  # --out で置くスナップショットに node_modules などを混ぜないよう、写しの中で流す。
  verify_dir="${work}/verify"
  cp -R "${snap}" "${verify_dir}"
  echo "== verify: pnpm install --frozen-lockfile && pnpm verify:checks"
  # スナップショットの中は語のリストを持たない公開の状態として検査する（手元の環境変数を持ち込まない）。
  if (cd "${verify_dir}" && env -u HELL_ICT_BANNED_WORDS pnpm install --frozen-lockfile &&
    env -u HELL_ICT_BANNED_WORDS pnpm verify:checks); then
    echo "== verify: 成功"
  else
    echo "== verify: 失敗"
    [ "${status}" -eq 1 ] || status=3
  fi
fi

# --- 書き出し（検査がすべて通ったときだけ）
if [ -n "${out}" ]; then
  if [ "${status}" -ne 0 ]; then
    echo "== 書き出し: 検査に通らなかったので ${out} には置かない"
  # mkdir で置き場所を確保してから写す（検査の間に作られていたら、そのものには触らず止まる）。
  elif ! mkdir "${out}"; then
    echo "エラー: --out の置き場所を作れない（すでにある？）: ${out}" >&2
    status=4
  elif cp -R "${snap}/." "${out}/"; then
    echo "== 書き出し: ${out}"
  else
    # 自分で作った置き場所なので、途中まで写したものを消して何も置かない。
    rm -rf "${out}"
    echo "エラー: スナップショットを ${out} に写せない（途中まで写した分は消した）" >&2
    status=4
  fi
fi

exit "${status}"
