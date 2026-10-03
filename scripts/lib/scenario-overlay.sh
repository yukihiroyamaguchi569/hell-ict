#!/usr/bin/env bash
# 本物のシナリオ（private repo hell-ict-scenario）を、この repo の作業ツリーへ上書き（overlay）
# して戻す関数。deploy-prod.sh・scenario-overlay.sh・scenario-check.sh が source して使い、
# テスト（scripts/scenario-overlay.test.sh）からも source して試す。
#
# 上書きしてよいのは次だけで、それ以外のパスを含むシナリオは受け付けない。
#   packages/content/src/*.ts（index.ts・schemas.ts を除く。public 側の同名ファイルをすべて置き換える）
#   packages/content/test/scenario/**、packages/domain/test/scenario/**（ディレクトリごと入れ替える）
# README.md・.gitignore・docs/**・assets/**（private repo の運用ファイル・設計文書・素材）は読み飛ばす。
# 失敗はその場で exit する（呼び出し側の EXIT trap が片付ける）。

scenario_overlay_marker=".scenario-overlay"
# 入れ替えるディレクトリ。public 側にある分は restore で git から戻す。
scenario_overlay_dirs=(packages/content/test/scenario packages/domain/test/scenario)
scenario_content_src="packages/content/src"

scenario_fail() {
  echo "ERROR: $1" >&2
  exit 1
}

# overlay の対象外として読み飛ばすファイル（private repo の運用ファイルと、設計文書・素材）。
scenario_ignored_path() {
  case "$1" in
    README.md | .gitignore | docs/* | assets/*) return 0 ;;
    *) return 1 ;;
  esac
}

# public 側の content/src のうち、シナリオが置き換えるべきファイル（index.ts・schemas.ts 以外）。
scenario_public_content_files() {
  local file
  for file in "$1/${scenario_content_src}"/*.ts; do
    [ -f "${file}" ] || continue
    case "${file##*/}" in
      index.ts | schemas.ts) ;;
      *) echo "${scenario_content_src}/${file##*/}" ;;
    esac
  done
}

# 取り出したシナリオ $2 のファイルを検査し、上書きするファイルを $2 からの相対パスで出す。
# 対象 $1 は public 側の作業ツリー。content/src は public 側にある名前だけを受け付け、
# public 側の content/src（index・schemas 以外）を1つでも置き換えなければ止まる
# （置き換え漏れはダミーのまま本番へ出す事故になる）。
scenario_source_files() {
  local target="$1" src path name listing
  src="$(cd "$2" 2>/dev/null && pwd)" || scenario_fail "シナリオのディレクトリが無い: $2"
  # 列挙の失敗（読めないディレクトリなど）で一覧が欠けたまま進まないよう、終了コードを見る。
  listing="$(find "${src}" ! -type d)" || scenario_fail "シナリオのファイルを列挙できない。"
  local files=()
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    # シンボリックリンクなど通常のファイル以外と、改行を含む名前（一覧が割れて別の名前に見える）を拒否する。
    [ -f "${path}" ] && [ ! -L "${path}" ] ||
      scenario_fail "シナリオに通常のファイル以外（シンボリックリンク、改行を含む名前など）がある。"
    path="${path#"${src}"/}"
    scenario_ignored_path "${path}" && continue
    case "${path}" in
      "${scenario_content_src}"/index.ts | "${scenario_content_src}"/schemas.ts)
        scenario_fail "シナリオに ${path} がある。index.ts・schemas.ts は public 側のものを使い、上書きしない。"
        ;;
      "${scenario_content_src}"/*/*) scenario_fail "overlay できないパス: ${path}" ;;
      "${scenario_content_src}"/*.ts)
        [ -f "${target}/${path}" ] || scenario_fail "public 側に無い content のファイル: ${path}"
        ;;
      packages/content/test/scenario/* | packages/domain/test/scenario/*) ;;
      *) scenario_fail "overlay できないパス: ${path}" ;;
    esac
    files+=("${path}")
  done < <(LC_ALL=C sort <<<"${listing}")

  local missing=""
  while IFS= read -r name; do
    [ -f "${src}/${name}" ] || missing="${missing} ${name}"
  done < <(scenario_public_content_files "${target}")
  [ -z "${missing}" ] || scenario_fail "シナリオが置き換えない content のファイルがある（ダミーのまま出てしまう）:${missing}"
  [ "${#files[@]}" -gt 0 ] || scenario_fail "シナリオに overlay するファイルが無い。"
  printf '%s\n' "${files[@]}"
}

# $1 の packages/content/src/scenario.ts から scenarioId を取り出す。ダミーなら止まる。
scenario_id_of() {
  local file="$1/${scenario_content_src}/scenario.ts" code ids
  [ -f "${file}" ] || scenario_fail "scenario.ts が無い: ${file}"
  # 空行と、行全体がコメントの行（// … か、1行で閉じる /* … */）を除いた残りが export の1行だけで
  # あることを求める。複数行のブロックコメントは、開きの行がコードとして数えられるので止まる。
  code="$(grep -vE '^[[:space:]]*(//.*|/\*([^*]|\*+[^*/])*\*+/[[:space:]]*)?$' "${file}" || true)"
  ids="$(sed -nE 's/^export const scenarioId = "([A-Za-z0-9_-]+)";$/\1/p' <<<"${code}")"
  [ -n "${ids}" ] && [ "$(wc -l <<<"${code}" | tr -d ' ')" = "1" ] ||
    scenario_fail "scenario.ts は export const scenarioId = \"<id>\"; の1行（とコメント）だけにする。"
  [ "${ids}" != "dummy" ] || scenario_fail "scenarioId が dummy（ダミーシナリオ）である。本物のシナリオを使う。"
  echo "${ids}"
}

# $1 が git 作業ツリーのトップであることを確かめる。
scenario_require_toplevel() {
  local top
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || scenario_fail "git の作業ツリーではない: $1"
  [ "$(cd "$1" && pwd -P)" = "$(cd "${top}" && pwd -P)" ] ||
    scenario_fail "作業ツリーのトップを指定する: $1（トップは ${top}）"
}

# overlay の途中で失敗したとき、途中まで写した private の内容を戻してから止まる。
scenario_overlay_abort() {
  (restore_scenario_overlay "$1") ||
    echo "ERROR: 途中まで写したシナリオを戻せない。bash scripts/scenario-overlay.sh restore を確かめる。" >&2
  scenario_fail "$2"
}

# 取り出したシナリオ $2 を対象 $1 へ上書きする。$3 はシナリオのコミット（マーカーへ書く）。
# 対象に追跡ファイルの変更・overlay 先の未追跡ファイル・既存のマーカーがあれば拒否する
# （restore で元へ戻せることを保証するため）。
apply_scenario_overlay() {
  local target="$1" src="$2" commit="${3:-unknown}"
  scenario_require_toplevel "${target}"
  [ ! -e "${target}/${scenario_overlay_marker}" ] ||
    scenario_fail "すでに overlay してある（${target}/${scenario_overlay_marker}）。先に restore する。"
  [ -z "$(git -C "${target}" status --porcelain --untracked-files=no)" ] ||
    scenario_fail "対象に未コミットの変更がある。コミットするか戻してから overlay する。"
  [ -z "$(git -C "${target}" status --porcelain --untracked-files=all -- "${scenario_content_src}" "${scenario_overlay_dirs[@]}")" ] ||
    scenario_fail "overlay 先に未追跡のファイルがある。片付けてから overlay する。"

  local files id
  # 関数の中では set -e が効かない呼ばれ方もあるので、失敗は明示して止める。
  files="$(scenario_source_files "${target}" "${src}")" || exit 1
  id="$(scenario_id_of "${src}")" || exit 1

  # マーカーを先に書く。途中で失敗しても restore で戻せるようにするため。
  {
    echo "commit=${commit}"
    echo "id=${id}"
    echo "files:"
    printf '%s\n' "${files}"
  } >"${target}/${scenario_overlay_marker}" || scenario_fail "マーカーを書けない。"

  local dir path
  for dir in "${scenario_overlay_dirs[@]}"; do
    rm -rf "${target:?}/${dir}" || scenario_overlay_abort "${target}" "public 側の ${dir} を消せない。"
  done
  while IFS= read -r path; do
    { mkdir -p "$(dirname "${target}/${path}")" && cp "${src}/${path}" "${target}/${path}"; } ||
      scenario_overlay_abort "${target}" "シナリオのファイルを写せない: ${path}"
  done <<<"${files}"
}

# overlay を取り消す。public 側の追跡ファイルを git から戻し、シナリオが足したファイルと
# マーカーを消す。戻したあと git status が空でなければ止まる。
restore_scenario_overlay() {
  local target="$1" marker path
  scenario_require_toplevel "${target}"
  marker="${target}/${scenario_overlay_marker}"
  [ -f "${marker}" ] || scenario_fail "overlay していない（${marker} が無い）。"

  local tracked=()
  for path in "${scenario_content_src}" "${scenario_overlay_dirs[@]}"; do
    [ -z "$(git -C "${target}" ls-files -- "${path}")" ] || tracked+=("${path}")
  done
  [ "${#tracked[@]}" -eq 0 ] || git -C "${target}" checkout HEAD -- "${tracked[@]}" ||
    scenario_fail "public 側のファイルを git から戻せない。"
  while IFS= read -r path; do
    # パス要素としての .. だけを飛ばす（foo..bar.ts のような名前は消す）。
    case "/${path}/" in
      // | */../*) continue ;;
    esac
    git -C "${target}" cat-file -e "HEAD:${path}" 2>/dev/null || rm -f "${target:?}/${path}" ||
      scenario_fail "シナリオが足したファイルを消せない: ${path}"
  done < <(sed '1,/^files:$/d' "${marker}")
  for path in "${scenario_overlay_dirs[@]}"; do
    [ ! -d "${target}/${path}" ] || find "${target}/${path}" -depth -type d -empty -delete ||
      scenario_fail "空になったディレクトリを消せない: ${path}"
  done
  # 元に戻ったと確かめてからマーカーを消す。戻らなければマーカーを残し、restore をやり直せるようにする。
  # apply と同じ範囲（追跡ファイル全体と、overlay 先の未追跡ファイル）を見る。overlay と関係ない
  # 未追跡ファイル（.deploy.env など）は apply でも許しているので、ここでも数えない。
  local tracked_status untracked_status
  tracked_status="$(git -C "${target}" status --porcelain --untracked-files=no)" &&
    untracked_status="$(git -C "${target}" status --porcelain --untracked-files=all -- \
      "${scenario_content_src}" "${scenario_overlay_dirs[@]}")" || scenario_fail "git status を読めない。"
  [ -z "${tracked_status}${untracked_status}" ] || scenario_fail "restore したが作業ツリーが元に戻っていない（git status を確かめる）。"
  rm -f "${marker}" || scenario_fail "マーカーを消せない: ${marker}"
}

# export_scenario_ref で取り出した一時ディレクトリ $1 を消す。消せなければ場所を出して失敗する
# （private の内容が残るので、黙って続けない）。
remove_scenario_tmp() {
  rm -rf "$1" 2>/dev/null
  [ ! -e "$1" ] || {
    echo "ERROR: 取り出したシナリオ（$1）を消せない。手で消す。" >&2
    return 1
  }
}

# シナリオの repo $1 を fetch し、push 済みのコミット $2 を $3 へ取り出す（作業ツリーは使わない）。
# 取り出したコミットの SHA を出す。
export_scenario_ref() {
  local src="$1" ref="$2" dest="$3" sha
  # --prune: origin で消えたブランチの追跡参照を残さず、下の push 済みの判定に使わせない。
  git -C "${src}" fetch --quiet --prune origin || scenario_fail "シナリオの repo を fetch できない: ${src}"
  sha="$(git -C "${src}" rev-parse --verify --quiet "${ref}^{commit}")" ||
    scenario_fail "シナリオの repo に ${ref} が無い。"
  # ローカルにしか無いコミット（未 push の HEAD など）は出さない。
  [ -n "$(git -C "${src}" for-each-ref --contains "${sha}" refs/remotes/origin)" ] ||
    scenario_fail "${ref} は origin へ push されていない。push してから実行する。"
  mkdir -p "${dest}" || scenario_fail "取り出し先を作れない: ${dest}"
  # コマンド置換の中では set -e・pipefail に頼れないので、パイプの両側の終了コードを見る。
  git -C "${src}" archive --format=tar "${sha}" | tar -x -f - -C "${dest}"
  local statuses="${PIPESTATUS[*]}"
  [ "${statuses}" = "0 0" ] || scenario_fail "シナリオを取り出せない（${ref}）。"
  echo "${sha}"
}
