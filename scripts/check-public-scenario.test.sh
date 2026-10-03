#!/usr/bin/env bash
# scripts/check-public-scenario.sh と、scripts/hooks/pre-commit のネタバレ語の検査のテスト。
# `pnpm test:scripts`（verify:checks）から走る。一時ディレクトリに小さなリポジトリを作って試す。
# 語は架空の目印（MARK_*）だけを使い、本物のネタバレ語はここに書かない（このファイルは公開に残る）。
set -euo pipefail

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="${scripts_dir}/check-public-scenario.sh"
hook="${scripts_dir}/hooks/pre-commit"
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

# 手元のグローバルなgitフックに左右されないよう、フックを切る。
git_q() { git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
put() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}
dummy_id='export const scenarioId = "dummy";'

# 公開検査を root に対して走らせ、終了コードで期待と比べる。止めるときは、その理由で止まったこと
# （エラーの文言の一部 $4）まで確かめる。
expect_check() {
  local name="$1" want="$2" root="$3" why="${4:-}" code=0 out
  out="$(bash "${check}" "${root}" 2>&1)" || code=$?
  if [ "${code}" -eq "${want}" ] && { [ -z "${why}" ] || grep -qF "${why}" <<<"${out}"; }; then
    ok "${name}"
  else
    ng "${name} (exit ${code}: ${out})"
  fi
}

# --- 1〜3: scenarioId・test/scenario・マーカー（語のリストが無いので 4 は飛ばす）
base="${work}/base"
put "${base}/packages/content/src/scenario.ts" "/** 識別子。 */
${dummy_id}"
expect_check "ダミーで、test/scenario もマーカーも無ければ通す" 0 "${base}"

variant() {
  local dir="${work}/v$1"
  rm -rf "${dir}"
  cp -R "${base}" "${dir}"
  echo "${dir}"
}

v="$(variant 1)"
put "${v}/packages/content/src/scenario.ts" 'export const scenarioId = "real-1";'
expect_check "scenarioId が dummy でなければ止める" 1 "${v}" "scenarioId が dummy ではない"

v="$(variant 2)"
put "${v}/packages/content/src/scenario.ts" "// ${dummy_id}
export const scenarioId = \"real-1\";"
expect_check "コメントの中の dummy にはだまされない" 1 "${v}" "scenarioId が dummy ではない"

v="$(variant 3)"
put "${v}/packages/content/src/scenario.ts" "${dummy_id}
export const scenarioId2 = \"real-1\";"
expect_check "scenarioId を含む行が2つあれば止める" 1 "${v}" "scenarioId が dummy ではない"

v="$(variant 4)"
rm "${v}/packages/content/src/scenario.ts"
expect_check "scenario.ts が無ければ止める" 1 "${v}" "scenario.ts が無い"

v="$(variant 5)"
put "${v}/packages/content/test/scenario/real.test.ts" "real"
expect_check "packages/content/test/scenario があれば止める" 1 "${v}" "packages/content/test/scenario がある"

v="$(variant 6)"
mkdir -p "${v}/packages/domain/test/scenario"
expect_check "packages/domain/test/scenario があれば（空でも）止める" 1 "${v}" "packages/domain/test/scenario がある"

v="$(variant 7)"
put "${v}/.scenario-overlay" "commit=abc"
expect_check "overlay のマーカーがあれば止める" 1 "${v}" "overlay 中"

# --- 4: 語のリストがあるときは公開用スナップショット（HEAD）を検査する
repo="${work}/repo"
cp -R "${base}" "${repo}"
mkdir -p "${repo}/scripts/lib"
cp "${scripts_dir}/public-snapshot.sh" "${repo}/scripts/"
cp "${scripts_dir}/lib/public-lists.sh" "${repo}/scripts/lib/"
put "${repo}/scripts/public-exclude.txt" "docs/"
put "${repo}/docs/public-banned-words.txt" "# 架空の語
MARK_SECRET"
put "${repo}/docs/notes.md" "MARK_SECRET は docs/ にあれば公開から外れる"
put "${repo}/src/app.ts" "export const app = 1;"
git_q init -q -b main "${repo}"
git_q -C "${repo}" add -A
git_q -C "${repo}" commit -q -m clean
expect_check "HEAD の公開用スナップショットにネタバレ語が無ければ通す" 0 "${repo}"

put "${repo}/src/app.ts" "export const app = 'MARK_SECRET';"
expect_check "未コミットの変更は見ない（HEAD を見る）" 0 "${repo}"
git_q -C "${repo}" commit -q -am leak
expect_check "HEAD の公開に残るファイルにネタバレ語があれば止める" 1 "${repo}" "公開用スナップショット（HEAD）"

v="$(variant 8)"
put "${v}/docs/public-banned-words.txt" "# コメントと空行だけ

"
expect_check "語のリストに語が1つも無ければ止める" 1 "${v}" "語が1つも無い"

# --- 4（public repo）: docs/ に語のリストが無ければ HELL_ICT_BANNED_WORDS が指す写しを読む。
# HEAD にはネタバレ語が残っているので、検査が効けば止まり、飛ばせば通る。
pub="${work}/pub"
cp -R "${repo}" "${pub}"
git_q -C "${pub}" rm -q docs/public-banned-words.txt
git_q -C "${pub}" commit -q -m "drop words"
words_copy="${work}/scenario-words.txt"
put "${words_copy}" "MARK_SECRET"
expect_check "語のリストがどこにも無ければ語の検査を飛ばす" 0 "${pub}" "検査は飛ばす"
HELL_ICT_BANNED_WORDS="${words_copy}" expect_check "環境変数が指す語のリストで検査する" 1 "${pub}" "公開用スナップショット（HEAD）"
put "${pub}/.deploy.env" "HELL_ICT_BANNED_WORDS=${words_copy}"
expect_check ".deploy.env が指す語のリストで検査する" 1 "${pub}" "公開用スナップショット（HEAD）"
put "${pub}/.deploy.env" "HELL_ICT_BANNED_WORDS=${work}/no-such.txt"
expect_check ".deploy.env が無いファイルを指せば止める" 1 "${pub}" "指すネタバレ語のリストが無い"
put "${work}/empty-words.txt" "# コメントだけ"
put "${pub}/.deploy.env" "HELL_ICT_BANNED_WORDS=${work}/empty-words.txt"
expect_check ".deploy.env が指す語のリストに語が1つも無ければ止める" 1 "${pub}" "語が1つも無い"
put "${pub}/.deploy.env" "HELL_ICT_BANNED_WORDS=${words_copy}"
chmod 000 "${pub}/.deploy.env"
expect_check ".deploy.env を読めなければ（飛ばさずに）止める" 1 "${pub}" ".deploy.env を読めない"
chmod 644 "${pub}/.deploy.env"
rm "${pub}/.deploy.env"

# --- pre-commit: ステージした追加行のネタバレ語
hook_repo="${work}/hook"
mkdir -p "${hook_repo}/scripts/lib"
cp "${scripts_dir}/lib/public-lists.sh" "${hook_repo}/scripts/lib/"
put "${hook_repo}/scripts/public-exclude.txt" "docs/
!docs/public.md"
put "${hook_repo}/docs/public-banned-words.txt" "MARK_SECRET
  MARK_INDENTED  "
put "${hook_repo}/src/old.ts" "const old = 'MARK_SECRET';"
put "${hook_repo}/src/keep.ts" "const keep = 'MARK_SECRET';"
git_q init -q -b main "${hook_repo}"
git_q -C "${hook_repo}" add -A
git_q -C "${hook_repo}" commit -q -m base

# ステージした状態でフックを走らせ、終了コードで期待と比べてから、ステージと作業ツリーを戻す。
# 止めるときは、語の検査で止まったこと（ファイル名と語を挙げていること）まで確かめる。
expect_hook() {
  local name="$1" want="$2" hit="${3:-}" code=0 out
  out="$(cd "${hook_repo}" && "${hook}" 2>&1)" || code=$?
  if [ "${code}" -eq "${want}" ] && { [ -z "${hit}" ] || grep -qF "${hit}" <<<"${out}"; }; then
    ok "${name}"
  else
    ng "${name} (exit ${code}: ${out})"
  fi
  git_q -C "${hook_repo}" reset -q --hard
  git_q -C "${hook_repo}" clean -qfd
}

put "${hook_repo}/src/new.ts" "const leak = 'MARK_SECRET';"
git_q -C "${hook_repo}" add -A
expect_hook "公開に残るファイルの追加行に語があれば止める" 1 "src/new.ts: MARK_SECRET"

put "${hook_repo}/src/name with space.ts" "  MARK_INDENTED"
git_q -C "${hook_repo}" add -A
expect_hook "語のリストの前後の空白は無視し、空白を含むファイル名でも見つける" 1 "src/name with space.ts: MARK_INDENTED"

put "${hook_repo}/src/line"$'\n'"break.ts" "MARK_SECRET"
git_q -C "${hook_repo}" add -A
expect_hook "改行を含むファイル名でも追加行を見る" 1 "MARK_SECRET"

put "${hook_repo}/src/header.ts" "++ b/MARK_SECRET"
git_q -C "${hook_repo}" add -A
expect_hook "ファイル見出しに似た追加行（+++ b/…）も見る" 1 "src/header.ts: MARK_SECRET"

put "${hook_repo}/src/a|b&c.ts" "MARK_SECRET"
git_q -C "${hook_repo}" add -A
expect_hook "記号を含むファイル名もそのまま挙げる" 1 "src/a|b&c.ts: MARK_SECRET"

put "${hook_repo}/docs/scenario.md" "MARK_SECRET"
git_q -C "${hook_repo}" add -A
expect_hook "公開から外すパスの変更は見ない" 0

put "${hook_repo}/docs/public.md" "MARK_SECRET"
git_q -C "${hook_repo}" add -A
expect_hook "再包含（!）で公開に戻したパスは見る" 1 "docs/public.md: MARK_SECRET"

put "${hook_repo}/src/old.ts" "const old = 1;"
git_q -C "${hook_repo}" add -A
expect_hook "語を消す変更（削除行だけに語がある）は通す" 0

printf '%s\n' "const keep = 'MARK_SECRET';" "const more = 1;" >"${hook_repo}/src/keep.ts"
git_q -C "${hook_repo}" add -A
expect_hook "前からある行の語は見ない（追加行だけを見る）" 0

put "${hook_repo}/src/new.ts" "const leak = 'MARK_SECRET';"
expect_hook "ステージしていない変更は見ない" 0

put "${hook_repo}/docs/public-banned-words.txt" "# コメントだけ"
git_q -C "${hook_repo}" commit -q -am "empty words"
put "${hook_repo}/src/new.ts" "const ok = 1;"
git_q -C "${hook_repo}" add -A
expect_hook "語のリストに語が1つも無ければ止める" 1 "語が1つも無い"

rm "${hook_repo}/docs/public-banned-words.txt"
git_q -C "${hook_repo}" commit -q -am "drop words"
put "${hook_repo}/src/new.ts" "const leak = 'MARK_SECRET';"
git_q -C "${hook_repo}" add -A
expect_hook "語のリストが無ければ語の検査を飛ばす" 0

# docs/ に語のリストが無い public repo では、HELL_ICT_BANNED_WORDS が指す写しを読む。
# expect_hook は未追跡のファイルを片付けるので、.deploy.env は毎回置き直し、src だけをステージする。
put "${hook_repo}/src/new.ts" "const leak = 'MARK_SECRET';"
git_q -C "${hook_repo}" add src/new.ts
HELL_ICT_BANNED_WORDS="${words_copy}" expect_hook "環境変数が指す語のリストで止める" 1 "src/new.ts: MARK_SECRET"
put "${hook_repo}/.deploy.env" "HELL_ICT_BANNED_WORDS=${words_copy}"
put "${hook_repo}/src/new.ts" "const leak = 'MARK_SECRET';"
git_q -C "${hook_repo}" add src/new.ts
expect_hook ".deploy.env が指す語のリストで止める" 1 "src/new.ts: MARK_SECRET"
put "${hook_repo}/.deploy.env" "HELL_ICT_BANNED_WORDS=${work}/no-such.txt"
put "${hook_repo}/src/new.ts" "const ok = 1;"
git_q -C "${hook_repo}" add src/new.ts
expect_hook ".deploy.env が無いファイルを指せば止める" 1 "指すネタバレ語のリストが無い"
put "${hook_repo}/.deploy.env" "HELL_ICT_BANNED_WORDS=${work}/empty-words.txt"
put "${hook_repo}/src/new.ts" "const ok = 1;"
git_q -C "${hook_repo}" add src/new.ts
expect_hook ".deploy.env が指す語のリストに語が1つも無ければ止める" 1 "語が1つも無い"
put "${hook_repo}/.deploy.env" "HELL_ICT_BANNED_WORDS=${words_copy}"
chmod 000 "${hook_repo}/.deploy.env"
put "${hook_repo}/src/new.ts" "const leak = 'MARK_SECRET';"
git_q -C "${hook_repo}" add src/new.ts
expect_hook ".deploy.env を読めなければ（飛ばさずに）止める" 1 ".deploy.env を読めない"

if [ "${failures}" -gt 0 ]; then
  echo "${failures} 件失敗" >&2
  exit 1
fi
echo "すべて成功"
