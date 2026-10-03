#!/usr/bin/env bash
# scripts/lib/scenario-overlay.sh と scripts/hooks/pre-commit のテスト。`pnpm test:scripts`
# （verify:checks）から走る。一時の git リポジトリを2つ（public 役と scenario 役）作って試す。
set -euo pipefail

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="${scripts_dir}/lib/scenario-overlay.sh"
hook="${scripts_dir}/hooks/pre-commit"
failures=0
ok() { echo "ok - $1"; }
ng() {
  echo "not ok - $1" >&2
  failures=$((failures + 1))
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
public="${work}/public"
scenario="${work}/scenario"
origin="${work}/scenario-origin.git"

# 手元のグローバルなgitフック（mainへのコミット禁止など）に左右されないよう、フックを切る。
git_q() { git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
put() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}

# --- public 役。content/src の overlay 対象は scenario.ts と stage1.ts
git init -q -b main "${public}"
put "${public}/.gitignore" ".scenario-overlay"
put "${public}/packages/content/src/index.ts" "public index"
put "${public}/packages/content/src/schemas.ts" "public schemas"
put "${public}/packages/content/src/scenario.ts" 'export const scenarioId = "dummy";'
put "${public}/packages/content/src/stage1.ts" "public stage1"
put "${public}/packages/content/test/scenario/old.test.ts" "public old test"
put "${public}/packages/domain/test/scenario/old.test.ts" "public old domain test"
put "${public}/packages/domain/src/judge.ts" "public judge"
git_q -C "${public}" add -A
git_q -C "${public}" commit -q -m public

# --- scenario 役。origin（bare）へ push したものだけが取り出される
git init -q --bare -b main "${origin}"
git init -q -b main "${scenario}"
put "${scenario}/README.md" "scenario readme"
put "${scenario}/.gitignore" "node_modules/"
put "${scenario}/docs/public-banned-words.txt" "word"
# 設計文書（docs/**）と素材（assets/**）は overlay の対象外として読み飛ばす。
put "${scenario}/docs/scenario/stage1.md" "design"
put "${scenario}/assets/video/clip.mp4" "video"
put "${scenario}/packages/content/src/scenario.ts" 'export const scenarioId = "real-1";'
put "${scenario}/packages/content/src/stage1.ts" "real stage1"
put "${scenario}/packages/content/test/scenario/new.test.ts" "real test"
# 名前に .. を含むファイルも restore で消える（パス要素の .. とは区別する）。
put "${scenario}/packages/content/test/scenario/foo..bar.ts" "real dots"
put "${scenario}/packages/domain/test/scenario/fixtures/golden.json" "{}"
git_q -C "${scenario}" add -A
git_q -C "${scenario}" commit -q -m scenario
git_q -C "${scenario}" remote add origin "${origin}"
git_q -C "${scenario}" push -q origin main
pushed="$(git -C "${scenario}" rev-parse HEAD)"
# push していないコミットと未コミットの変更は取り出されない。
put "${scenario}/packages/content/src/stage1.ts" "unpushed stage1"
git_q -C "${scenario}" commit -q -am unpushed
put "${scenario}/packages/content/src/stage1.ts" "uncommitted stage1"

public_status() { git -C "${public}" status --porcelain; }

# --- export_scenario_ref
src="${work}/src"
if sha="$(source "${lib}" && export_scenario_ref "${scenario}" origin/main "${src}" 2>/dev/null)" &&
  [ "${sha}" = "${pushed}" ] && [ "$(cat "${src}/packages/content/src/stage1.ts")" = "real stage1" ]; then
  ok "push 済みのコミットを取り出し、その SHA を返す"
else
  ng "push 済みのコミットを取り出し、その SHA を返す"
fi
if (source "${lib}" && export_scenario_ref "${scenario}" origin/no-such "${work}/none") >/dev/null 2>&1; then
  ng "無い ref なら止まる"
else
  ok "無い ref なら止まる"
fi
# origin で消したブランチは、手元に追跡参照が残っていても取り出さない。
git_q -C "${scenario}" push -q origin HEAD:refs/heads/gone
git_q -C "${scenario}" fetch -q origin
git_q -C "${origin}" branch -q -D gone
if (source "${lib}" && export_scenario_ref "${scenario}" origin/gone "${work}/gone") >/dev/null 2>&1; then
  ng "origin で消したブランチは止まる"
else
  ok "origin で消したブランチは止まる"
fi
for ref in HEAD main; do
  if out="$(source "${lib}" && export_scenario_ref "${scenario}" "${ref}" "${work}/unpushed" 2>&1)"; then
    ng "push していない ${ref} は止まる"
  elif grep -qF "push されていない" <<<"${out}" && [ ! -e "${work}/unpushed" ]; then
    ok "push していない ${ref} は止まる"
  else
    ng "push していない ${ref} は止まる（${out}）"
  fi
done

# --- scenario_id_of
if [ "$(source "${lib}" && scenario_id_of "${src}")" = "real-1" ]; then ok "scenarioId を取り出す"; else ng "scenarioId を取り出す"; fi
if (source "${lib}" && scenario_id_of "${public}") >/dev/null 2>&1; then
  ng "scenarioId が dummy なら止まる"
else
  ok "scenarioId が dummy なら止まる"
fi
id_dir="${work}/id"
expect_id() {
  put "${id_dir}/packages/content/src/scenario.ts" "$2"
  local got
  got="$(source "${lib}" && scenario_id_of "${id_dir}" 2>/dev/null)" || got="(止まる)"
  if [ "${got}" = "$3" ]; then ok "$1"; else ng "$1（${got}）"; fi
}
expect_id "1行のコメントと export なら取り出す" $'/** 識別子 */\n// 補足\n\nexport const scenarioId = "real-1";' real-1
expect_id "ブロックコメントの中の export は数えない" $'/*\nexport const scenarioId = "real-1";\n*/\nexport const scenarioId = "dummy" as const;' "(止まる)"
expect_id "*/ の後ろに続く export は数えない" $'/**\n * x\n */ export const scenarioId = "dummy" as const;\n// export const scenarioId = "real-1";' "(止まる)"
expect_id "as const などの形は受け付けない" 'export const scenarioId = "real-1" as const;' "(止まる)"
expect_id "export が2つなら止まる" $'export const scenarioId = "real-1";\nexport const scenarioId = "real-2";' "(止まる)"

# --- 拒否される取り出し。対象には何も書かれず、マーカーも残らない
# 正しい取り出しを写し、$2 の操作で壊したものを overlay してみる。
variant() {
  rm -rf "${work}/variant"
  cp -R "${src}" "${work}/variant"
  (cd "${work}/variant" && eval "$1")
}
expect_refused() {
  local name="$1" want="$2" out before
  before="$(public_status)"
  if out="$(source "${lib}" && apply_scenario_overlay "${public}" "${work}/variant" "${pushed}" 2>&1)"; then
    ng "${name}"
  elif ! grep -qF "${want}" <<<"${out}"; then
    ng "${name}（理由の表示が違う: ${out}）"
  elif [ "$(public_status)" != "${before}" ] || [ "$(cat "${public}/packages/content/src/stage1.ts")" != "public stage1" ] ||
    [ -e "${public}/.scenario-overlay" ]; then
    ng "${name}（対象が書き換わった）"
  else
    ok "${name}"
  fi
}

variant 'put packages/domain/src/judge.ts "evil"'
expect_refused "domain/src を含むと止まる" "overlay できないパス: packages/domain/src/judge.ts"
variant 'put apps/worker/src/index.ts "evil"'
expect_refused "apps を含むと止まる" "overlay できないパス: apps/worker/src/index.ts"
variant 'put docs-extra/notes.md "evil"'
expect_refused "docs/ に似た名前の未知のパスは止まる" "overlay できないパス: docs-extra/notes.md"
variant 'put tools/assets/x.wav "evil"'
expect_refused "直下以外の assets/ は読み飛ばさず止まる" "overlay できないパス: tools/assets/x.wav"
variant 'put packages/content/src/schemas.ts "evil"'
expect_refused "schemas.ts を含むと止まる" "schemas.ts は public 側のものを使い"
variant 'put packages/content/src/index.ts "evil"'
expect_refused "index.ts を含むと止まる" "schemas.ts は public 側のものを使い"
variant 'put packages/content/src/sub/x.ts "evil"'
expect_refused "content/src の下の階層を含むと止まる" "overlay できないパス: packages/content/src/sub/x.ts"
variant 'put packages/content/src/extra.ts "x"'
expect_refused "public 側に無い content のファイルは止まる" "public 側に無い content のファイル"
variant 'rm packages/content/src/stage1.ts'
expect_refused "content/src を1つでも置き換えなければ止まる" "ダミーのまま出てしまう"
variant 'rm -r packages/content/src'
expect_refused "content/src の上書きが0件なら止まる" "ダミーのまま出てしまう"
variant 'put packages/content/src/scenario.ts "export const scenarioId = \"dummy\";"'
expect_refused "dummy のシナリオは止まる" "dummy"
variant 'ln -s ../../../../README.md packages/content/test/scenario/link.ts'
expect_refused "シンボリックリンクを含むと止まる" "通常のファイル以外"

# 列挙に失敗したら（読めないディレクトリ）、一覧が欠けたまま進まない。
variant 'mkdir -p packages/content/test/scenario/locked && chmod 000 packages/content/test/scenario/locked'
expect_refused "シナリオを列挙できなければ止まる" "列挙できない"
chmod -R u+rwx "${work}/variant"

# 写している途中で失敗したら、写した分を戻してから止まる（読めないファイルで cp を失敗させる）。
variant 'chmod 000 packages/domain/test/scenario/fixtures/golden.json'
expect_refused "写す途中で失敗したら写した分を戻す" "シナリオのファイルを写せない"
chmod -R u+rw "${work}/variant"
# 入れ替え先の古いファイルを消せないときも、戻してから止まる（書き込めないディレクトリにする）。
variant ':'
chmod 555 "${public}/packages/domain/test/scenario"
expect_refused "入れ替え先を消せなければ戻して止まる" "packages/domain/test/scenario を消せない"
chmod 755 "${public}/packages/domain/test/scenario"

# --- 対象の状態による拒否
variant ':'
put "${public}/packages/domain/src/judge.ts" "dirty"
expect_refused "対象に追跡ファイルの変更があると止まる" "未コミットの変更"
git -C "${public}" checkout -q -- packages/domain/src/judge.ts
put "${public}/packages/domain/test/scenario/stray.test.ts" "stray"
expect_refused "overlay 先に未追跡のファイルがあると止まる" "未追跡のファイル"
rm "${public}/packages/domain/test/scenario/stray.test.ts"

# --- overlay と restore。overlay と関係ない未追跡ファイル（.deploy.env など）はあってよい
put "${public}/notes.txt" "local note"
if (source "${lib}" && apply_scenario_overlay "${public}" "${src}" "${pushed}") >/dev/null 2>&1; then
  ok "overlay できる"
else
  ng "overlay できる"
fi
c="${public}/packages/content"
d="${public}/packages/domain"
[ "$(cat "${c}/src/stage1.ts")" = "real stage1" ] && [ "$(cat "${c}/src/index.ts")" = "public index" ] &&
  [ "$(cat "${c}/src/schemas.ts")" = "public schemas" ] && ok "content/src を置き換え、index・schemas は残す" ||
  ng "content/src を置き換え、index・schemas は残す"
[ ! -e "${c}/test/scenario/old.test.ts" ] && [ -f "${c}/test/scenario/new.test.ts" ] &&
  [ ! -e "${d}/test/scenario/old.test.ts" ] && [ -f "${d}/test/scenario/fixtures/golden.json" ] &&
  ok "test/scenario はディレクトリごと入れ替える" || ng "test/scenario はディレクトリごと入れ替える"
[ ! -e "${public}/README.md" ] && [ ! -e "${public}/docs" ] && [ ! -e "${public}/assets" ] &&
  [ "$(cat "${d}/src/judge.ts")" = "public judge" ] &&
  ok "README・docs・assets は写さず、ほかのパスは触らない" || ng "README・docs・assets は写さず、ほかのパスは触らない"
marker="${public}/.scenario-overlay"
if grep -qx "commit=${pushed}" "${marker}" && grep -qx "id=real-1" "${marker}" &&
  [ "$(sed '1,/^files:$/d' "${marker}" | wc -l | tr -d ' ')" = "5" ]; then
  ok "マーカーに commit・id・入れ替えたファイルを書く"
else
  ng "マーカーに commit・id・入れ替えたファイルを書く"
fi
if out="$(source "${lib}" && apply_scenario_overlay "${public}" "${src}" "${pushed}" 2>&1)"; then
  ng "二重の overlay は止まる"
elif grep -qF "すでに overlay してある" <<<"${out}"; then
  ok "二重の overlay は止まる"
else
  ng "二重の overlay は止まる（${out}）"
fi

# --- pre-commit フック: マーカーのある作業ツリーではコミットさせない
if (cd "${public}" && "${hook}") >/dev/null 2>&1; then
  ng "pre-commit は overlay 中のコミットを拒否する"
else
  ok "pre-commit は overlay 中のコミットを拒否する"
fi

# 足したファイルを消せなければ、マーカーを残して止まる（restore をやり直せる）。
chmod 555 "${c}/test/scenario"
if (source "${lib}" && restore_scenario_overlay "${public}") >/dev/null 2>&1; then
  ng "restore で消せなければマーカーを残して止まる"
elif [ -f "${marker}" ]; then
  ok "restore で消せなければマーカーを残して止まる"
else
  ng "restore で消せなければマーカーを残して止まる（マーカーが消えた）"
fi
chmod 755 "${c}/test/scenario"

if (source "${lib}" && restore_scenario_overlay "${public}") >/dev/null 2>&1 &&
  [ "$(public_status)" = "?? notes.txt" ] && rm "${public}/notes.txt" && [ -z "$(public_status)" ] &&
  [ ! -e "${marker}" ] && [ ! -e "${c}/test/scenario/new.test.ts" ] && [ ! -e "${c}/test/scenario/foo..bar.ts" ] &&
  [ ! -e "${d}/test/scenario/fixtures" ] &&
  [ "$(cat "${c}/src/stage1.ts")" = "public stage1" ]; then
  ok "restore で元に戻り、git status が空になる"
else
  ng "restore で元に戻り、git status が空になる"
fi
if (source "${lib}" && restore_scenario_overlay "${public}") >/dev/null 2>&1; then
  ng "overlay していなければ restore は止まる"
else
  ok "overlay していなければ restore は止まる"
fi
if (cd "${public}" && "${hook}") >/dev/null 2>&1; then
  ok "pre-commit は overlay していなければ通す"
else
  ng "pre-commit は overlay していなければ通す"
fi

# --- 取り出したシナリオの一時ディレクトリの片付け
mkdir -p "${work}/tmp-parent/tmp"
put "${work}/tmp-parent/tmp/a.ts" "private"
chmod 555 "${work}/tmp-parent"
if (source "${lib}" && remove_scenario_tmp "${work}/tmp-parent/tmp") >/dev/null 2>&1; then
  ng "取り出したシナリオを消せなければ失敗する"
else
  ok "取り出したシナリオを消せなければ失敗する"
fi
chmod 755 "${work}/tmp-parent"
if (source "${lib}" && remove_scenario_tmp "${work}/tmp-parent/tmp") && [ ! -e "${work}/tmp-parent/tmp" ]; then
  ok "取り出したシナリオを消す"
else
  ng "取り出したシナリオを消す"
fi

if [ "${failures}" -gt 0 ]; then
  echo "${failures} 件失敗" >&2
  exit 1
fi
echo "すべて成功"
