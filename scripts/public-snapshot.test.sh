#!/usr/bin/env bash
# scripts/public-snapshot.sh のテスト。`pnpm test:scripts`（verify:checks）から走る。
# 一時gitリポジトリに小さな除外リストと語のリストを置き、除外・再包含・ネタバレ語・除外漏れを試す。
# 語は架空の目印（MARK_*）だけを使い、本物のネタバレ語はここに書かない（このファイルは公開に残る）。
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/public-snapshot.sh"
# 手元の環境変数（public repo で語のリストの場所を指す）に左右されないよう、消してから始める。
unset HELL_ICT_BANNED_WORDS
failures=0
ok() { echo "ok - $1"; }
ng() {
  echo "not ok - $1" >&2
  failures=$((failures + 1))
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
repo="${work}/repo"
# スクリプトが作る一時ディレクトリをここへ集め、終了後に残っていないことを確かめる。
snap_tmp="${work}/tmp"
mkdir -p "${snap_tmp}"
git init -q -b main "${repo}"
cd "${repo}"

git_commit() {
  git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null commit -q -m "$1"
}
put() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}

put docs/secret.md "MARK_KEEP MARK_SECRET"
put docs/keep.md "MARK_KEEP"
put docs/sub/deep.md "nothing"
put assets/sfx/boom.wav "MARK_SECRET"
put assets/music/theme.txt "public"
put fixtures/real.json "MARK_SECRET"
put tests/real.test.ts "import data from '../fixtures/real.json'"
put src/app.ts "export const app = 1"
put scripts/public-exclude.txt "# test list
docs/
!docs/keep.md
assets/sfx/
fixtures/real.json
tests/real.test.ts"
git add -A
git_commit "c0"

# 語のリストは作業ツリーのものを読む（docs/ ごと公開から外れる）。
words() { printf '%s\n' "# comment" "" "$@" >docs/public-banned-words.txt; }
run() { TMPDIR="${snap_tmp}" bash "${script}" "$@" 2>&1; }
code_of() {
  set +e
  out="$(run "$@")"
  code=$?
  set -e
}

# --- 何も当たらなければ 0。除外と再包含の結果、残るのは4ファイル
words "MARK_SECRET"
code_of main
if [ "${code}" -eq 0 ]; then ok "除外したファイルの語には当たらず 0 で終わる"; else ng "除外したファイルの語には当たらず 0 で終わる (${code}): ${out}"; fi
if grep -qF "除外漏れ: なし" <<<"${out}"; then ok "除外漏れなしと報告する"; else ng "除外漏れなしと報告する"; fi
# docs/keep.md、assets/music/theme.txt、src/app.ts、scripts/public-exclude.txt
if grep -qF "4 ファイル" <<<"${out}"; then ok "残るファイル数を報告する"; else ng "残るファイル数を報告する: ${out}"; fi
if grep -qF "除外したファイル: 5 件" <<<"${out}"; then ok "除外した件数を報告する"; else ng "除外した件数を報告する: ${out}"; fi

# --- 再包含したファイルの語には当たり、2 で終わる。外したファイルの同じ語は出ない
words "MARK_KEEP"
code_of main
if [ "${code}" -eq 2 ]; then ok "ネタバレ語に当たれば 2 で終わる"; else ng "ネタバレ語に当たれば 2 で終わる (${code})"; fi
if grep -qF "docs/keep.md: MARK_KEEP ×1" <<<"${out}"; then ok "再包含したファイルは残り、ヒットに出る"; else ng "再包含したファイルは残り、ヒットに出る: ${out}"; fi
if grep -qF "docs/secret.md" <<<"${out}"; then ng "外したファイルはヒットに出ない"; else ok "外したファイルはヒットに出ない"; fi

# --- 同じファイルの件数を数える
put src/app.ts "MARK_KEEP MARK_KEEP"
git add -A
git_commit "c1"
code_of main
if grep -qF "src/app.ts: MARK_KEEP ×2" <<<"${out}"; then ok "同じ語の件数を数える"; else ng "同じ語の件数を数える: ${out}"; fi

# --- 外したファイルの名前を参照するファイルが残れば除外漏れ（1）。ネタバレ語より優先する
put src/loader.ts "const path = 'fixtures/real.json'"
git add -A
git_commit "c2"
code_of main
if [ "${code}" -eq 1 ]; then ok "外したファイルへの参照が残れば 1 で終わる"; else ng "外したファイルへの参照が残れば 1 で終わる (${code})"; fi
if grep -qF "src/loader.ts （外した real.json を参照している）" <<<"${out}"; then ok "参照しているファイルを名指しする"; else ng "参照しているファイルを名指しする: ${out}"; fi
git rm -q src/loader.ts
git_commit "c3"

# --- 規則は下の行が勝つ。再包含を上に書くと、後の docs/ で外れる
put scripts/public-exclude.txt "!docs/keep.md
docs/
assets/sfx/
fixtures/real.json
tests/real.test.ts
gone/"
code_of main
if grep -qF "docs/keep.md" <<<"${out}"; then ng "上に書いた再包含は後の除外に負ける"; else ok "上に書いた再包含は後の除外に負ける"; fi
if grep -qF "  gone/" <<<"${out}"; then ok "どこにも当たらない行を知らせる"; else ng "どこにも当たらない行を知らせる: ${out}"; fi
git checkout -q -- scripts/public-exclude.txt

# --- ref を指定すると、その時点の中身を検査する（c0 では src/app.ts に語が無い）
code_of "$(git rev-list --max-parents=0 HEAD)"
if grep -qF "src/app.ts: MARK_KEEP" <<<"${out}"; then ng "指定した ref の中身を検査する"; else ok "指定した ref の中身を検査する"; fi

# --- --verify。pnpm を偽物に差し替え、FAKE_PNPM_EXIT で成否を決める
bin="${work}/bin"
mkdir -p "${bin}"
printf '%s\n' '#!/usr/bin/env bash' 'echo "fake pnpm $*"' 'exit "${FAKE_PNPM_EXIT:-0}"' >"${bin}/pnpm"
chmod +x "${bin}/pnpm"
verify_with() {
  local pnpm_exit="$1"
  shift
  FAKE_PNPM_EXIT="${pnpm_exit}" PATH="${bin}:${PATH}" code_of "$@"
}
expect_code() {
  if [ "${code}" -eq "$1" ]; then ok "$2"; else ng "$2 (${code}): ${out}"; fi
}

words "MARK_SECRET"
verify_with 0 main --verify
if grep -qF "fake pnpm install --frozen-lockfile" <<<"${out}" && grep -qF "fake pnpm verify:checks" <<<"${out}"; then
  ok "--verify でスナップショットの install と verify:checks を流す"
else
  ng "--verify でスナップショットの install と verify:checks を流す: ${out}"
fi
expect_code 0 "verify が通り、ほかに問題が無ければ 0"
verify_with 1 main --verify
expect_code 3 "verify が落ちれば 3"
verify_with 0 main
if grep -qF "fake pnpm" <<<"${out}"; then ng "--verify が無ければ pnpm を呼ばない"; else ok "--verify が無ければ pnpm を呼ばない"; fi

words "MARK_KEEP"
verify_with 0 main --verify
expect_code 2 "verify が通ってもネタバレ語に当たれば 2"
verify_with 1 main --verify
expect_code 3 "verify の失敗はネタバレ語のヒットより優先する（3）"
put src/loader.ts "const path = 'fixtures/real.json'"
git add -A
git_commit "c4"
verify_with 1 main --verify
expect_code 1 "除外漏れは verify の失敗より優先する（1）"
git rm -q src/loader.ts
git_commit "c5"

# --- ファイルが多くても、上位10件を取るところで途中終了しない（SIGPIPE を受けない）
mkdir -p many
long="$(printf '%0120d' 0)"
for i in $(seq 1 2000); do echo "${i}" >"many/${long}-${i}.txt"; done
git add -A
git_commit "many"
code_of main
expect_code 2 "ファイルが多くてもネタバレ語の検査まで進む"
git rm -rq many
git_commit "c6"

# --- 使い方の誤り
code_of no-such-ref
if [ "${code}" -eq 64 ]; then ok "無い ref は 64 で止める"; else ng "無い ref は 64 で止める (${code})"; fi
code_of main other
if [ "${code}" -eq 64 ]; then ok "ref を2つ渡せば 64 で止める"; else ng "ref を2つ渡せば 64 で止める (${code})"; fi
rm docs/public-banned-words.txt
code_of main
if [ "${code}" -eq 64 ]; then ok "語のリストが無ければ 64 で止める"; else ng "語のリストが無ければ 64 で止める (${code})"; fi
words
code_of main --out "${work}/empty-out"
expect_code 64 "語のリストに語が1つも無ければ 64 で止める"
if [ ! -e "${work}/empty-out" ]; then ok "語が無いリストでは --out に置かない"; else ng "語が無いリストでは --out に置かない"; fi
rm docs/public-banned-words.txt

# --- docs/ に語のリストが無い public repo では、HELL_ICT_BANNED_WORDS が指す写しを読む
outside="${work}/scenario-words.txt"
printf '%s\n' "# 写し" "MARK_KEEP" >"${outside}"
HELL_ICT_BANNED_WORDS="${outside}" code_of main
expect_code 2 "環境変数 HELL_ICT_BANNED_WORDS が指す語のリストで検査する"
printf '%s\n' "HELL_ICT_PROD_URL=https://example.invalid" "HELL_ICT_BANNED_WORDS='${outside}'" >.deploy.env
code_of main
expect_code 2 ".deploy.env の HELL_ICT_BANNED_WORDS が指す語のリストで検査する"
words "MARK_SECRET"
code_of main
expect_code 0 "docs/ に語のリストがあれば、それを .deploy.env より優先する"
rm docs/public-banned-words.txt
printf '%s\n' "HELL_ICT_BANNED_WORDS=${work}/no-such.txt" >.deploy.env
code_of main
expect_code 64 "HELL_ICT_BANNED_WORDS が指すファイルが無ければ 64 で止める"
if grep -qF "no-such.txt" <<<"${out}"; then ok "無いファイルの場所を示す"; else ng "無いファイルの場所を示す: ${out}"; fi
rm .deploy.env
words "MARK_SECRET"

# --- --out: 検査がすべて通ったときだけ置く
dest="${work}/out"
expect_no_dest() {
  if [ ! -e "${dest}" ]; then ok "$1"; else ng "$1（${dest} が置かれた）"; fi
}
code_of main --out "${dest}"
expect_code 0 "--out で検査が通れば 0"
placed="$(cd "${dest}" 2>/dev/null && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
if [ "${placed}" = "assets/music/theme.txt docs/keep.md scripts/public-exclude.txt src/app.ts " ]; then
  ok "--out に除外を当てたスナップショットだけを置く"
else
  ng "--out に除外を当てたスナップショットだけを置く: ${placed}"
fi
before="$(ls -A "${dest}")"
code_of main --out "${dest}"
expect_code 64 "--out の置き場所がすでにあれば 64 で止める"
if [ "$(ls -A "${dest}")" = "${before}" ]; then ok "すでにある置き場所には触らない"; else ng "すでにある置き場所には触らない"; fi
rm -rf "${dest}"

words "MARK_KEEP"
code_of main --out "${dest}"
expect_code 2 "--out でもネタバレ語に当たれば 2"
expect_no_dest "ネタバレ語に当たれば --out に置かない"
words "MARK_SECRET"
put src/loader.ts "const path = 'fixtures/real.json'"
git add -A
git_commit "c7"
code_of main --out "${dest}"
expect_code 1 "--out でも除外漏れなら 1"
expect_no_dest "除外漏れがあれば --out に置かない"
git rm -q src/loader.ts
git_commit "c8"

# verify は写しの中で流し、置くスナップショットに node_modules を混ぜない。
printf '%s\n' '#!/usr/bin/env bash' 'mkdir -p node_modules' 'echo "fake pnpm $* words=${HELL_ICT_BANNED_WORDS:-none}"' \
  'exit "${FAKE_PNPM_EXIT:-0}"' >"${bin}/pnpm"
verify_with 1 main --verify --out "${dest}"
expect_code 3 "--out でも verify が落ちれば 3"
expect_no_dest "verify が落ちれば --out に置かない"
HELL_ICT_BANNED_WORDS="${outside}" verify_with 0 main --verify --out "${dest}"
expect_code 0 "--verify --out で検査が通れば 0"
if [ -f "${dest}/src/app.ts" ] && [ ! -e "${dest}/node_modules" ]; then
  ok "verify で入れた node_modules は置かない"
else
  ng "verify で入れた node_modules は置かない: $(ls -A "${dest}" 2>&1)"
fi
if grep -qF "words=none" <<<"${out}" && ! grep -qF "words=${outside}" <<<"${out}"; then
  ok "スナップショットの verify に HELL_ICT_BANNED_WORDS を持ち込まない"
else
  ng "スナップショットの verify に HELL_ICT_BANNED_WORDS を持ち込まない: ${out}"
fi
rm -rf "${dest}"

code_of main --out "${work}/no-parent/out"
expect_code 64 "--out の親ディレクトリが無ければ 64 で止める"
code_of main --out
expect_code 64 "--out に置き場所が無ければ 64 で止める"
mkdir -p "${work}/locked"
chmod 555 "${work}/locked"
code_of main --out "${work}/locked/out"
expect_code 4 "--out に書き出せなければ 4"
if [ ! -e "${work}/locked/out" ]; then ok "書き出せなければ何も置かない"; else ng "書き出せなければ何も置かない"; fi
chmod 755 "${work}/locked"

# --- 一時ディレクトリは毎回消える
if [ -z "$(ls -A "${snap_tmp}")" ]; then ok "一時ディレクトリを残さない"; else ng "一時ディレクトリを残さない: $(ls -A "${snap_tmp}")"; fi

# --- このリポジトリの除外リストが、本番参加者の提出文の fixture をすべて外しているか
#     （git の外、たとえば公開用スナップショットの中で走るときは調べようがないので飛ばす）
real_root="$(cd "$(dirname "${script}")/.." && pwd)"
if fixtures="$(git -C "${real_root}" ls-files 'packages/domain/test/scenario/fixtures/golden-*' 2>/dev/null)"; then
  missing=""
  while IFS= read -r f; do
    [ -z "${f}" ] || grep -qxF "${f}" "${real_root}/scripts/public-exclude.txt" || missing+=" ${f}"
  done <<<"${fixtures}"
  if [ -z "${missing}" ]; then ok "本番の提出文の fixture をすべて除外リストに載せている"; else ng "除外リストに無い fixture:${missing}"; fi
fi

if [ "${failures}" -gt 0 ]; then
  echo "${failures} 件失敗" >&2
  exit 1
fi
echo "すべて成功"
