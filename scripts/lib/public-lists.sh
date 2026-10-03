#!/usr/bin/env bash
# 公開用スナップショットの除外リスト（scripts/public-exclude.txt）とネタバレ語のリストを読む関数
# （Issue #368）。scripts/public-snapshot.sh・scripts/check-public-scenario.sh・scripts/hooks/pre-commit が
# source する。書式は各リストの冒頭のコメントを正とする。

# ネタバレ語のリストの場所を出す。$1 はリポジトリのトップ。次の順に探す。
#   1. $1/docs/public-banned-words.txt（docs/ を持つ private 側の作業ツリー）
#   2. 環境変数 HELL_ICT_BANNED_WORDS。無ければ $1/.deploy.env に書いた同じ変数
#      （public repo では、hell-ict-scenario の docs/public-banned-words.txt の場所を書く）
# どちらも無ければ何も出さずに 0 を返す（呼び出し側が語の検査を飛ばすか決める。CI は語を持たない）。
# 変数が指すファイルが無ければ 1（書き間違いで検査が黙って飛ぶのを防ぐ）。
public_banned_words_file() {
  local in_docs="$1/docs/public-banned-words.txt" file
  if [ -f "${in_docs}" ]; then
    echo "${in_docs}"
    return 0
  fi
  file="${HELL_ICT_BANNED_WORDS:-}"
  if [ -z "${file}" ]; then
    file="$(public_banned_words_from_deploy_env "$1")" || return 1
  fi
  [ -n "${file}" ] || return 0
  [ -f "${file}" ] || {
    echo "エラー: HELL_ICT_BANNED_WORDS が指すネタバレ語のリストが無い: ${file}" >&2
    return 1
  }
  echo "${file}"
}

# $1/.deploy.env（コミットしない）から HELL_ICT_BANNED_WORDS だけを読んで出す。deploy-prod.sh の
# load_deploy_env と同じく source で読むが、サブシェルに閉じ、ほかの変数は呼び出し側へ持ち込まない
# （load_deploy_env は HELL_ICT_PROD_URL が無いと止まるので使わない）。読めなければ 1 を返す
# （語のリストが「無い」扱いになって検査が黙って飛ぶのを防ぐ）。
public_banned_words_from_deploy_env() {
  [ -f "$1/.deploy.env" ] || return 0
  (
    set +u
    # shellcheck source=/dev/null
    source "$1/.deploy.env" >/dev/null 2>&1 || exit 1
    printf '%s' "${HELL_ICT_BANNED_WORDS:-}"
  ) || {
    echo "エラー: $1/.deploy.env を読めない。" >&2
    return 1
  }
}

# コメント・空行を除き、行末の空白を落とす。
public_strip_list() { sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$1"; }

# 語のリスト $1 を、grep -F -f に渡せる1行1語へ整える（行頭の空白も落とす）。
public_banned_words() { public_strip_list "$1" | sed 's/^[[:space:]]*//'; }

# 標準入力のパスのうち、除外規則 $1（public_strip_list を通したファイル）で外れるものを出す。
# $2 が unused なら、どのパスにも当たらなかった規則を出す。
# 規則は上から順に当て、最後に当たった行が勝つ（! は再包含）。
public_apply_rules() {
  awk -v rules="$1" -v mode="${2:-excluded}" '
    BEGIN {
      while ((getline line < rules) > 0) {
        n++
        neg[n] = substr(line, 1, 1) == "!"
        pat[n] = neg[n] ? substr(line, 2) : line
        dir[n] = substr(pat[n], length(pat[n])) == "/"
      }
    }
    {
      out = 0
      for (i = 1; i <= n; i++) {
        hit = dir[i] ? index($0, pat[i]) == 1 : $0 == pat[i]
        if (hit) { out = !neg[i]; used[i] = 1 }
      }
      if (out && mode == "excluded") print
    }
    END { if (mode == "unused") for (i = 1; i <= n; i++) if (!used[i]) print (neg[i] ? "!" : "") pat[i] }
  '
}
