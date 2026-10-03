#!/usr/bin/env bash
# 本物のシナリオ（private repo hell-ict-scenario）を、このスクリプトのある作業ツリーへ
# overlay する・戻す・状態を見る。手元で本物を動かすときは、専用の worktree
# （例 git worktree add ../hell-ict-real）で使う（docs/development-harness.md「デプロイの流れ」）。
#
#   bash scripts/scenario-overlay.sh apply <シナリオの repo> [--ref <ref>]   # 既定は origin/main
#   bash scripts/scenario-overlay.sh restore
#   bash scripts/scenario-overlay.sh status
#
# 取り出すのはシナリオの repo の push 済みのコミット（git archive）であり、作業ツリーではない。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/scenario-overlay.sh
source "${repo_root}/scripts/lib/scenario-overlay.sh"

usage() {
  echo "使い方: bash scripts/scenario-overlay.sh apply <シナリオの repo> [--ref <ref>] | restore | status" >&2
  exit 2
}

cmd_apply() {
  [ $# -ge 1 ] || usage
  local src="$1" ref="origin/main"
  shift
  if [ $# -gt 0 ]; then
    [ $# -eq 2 ] && [ "$1" = "--ref" ] || usage
    ref="$2"
  fi
  local sha
  # trap は関数を抜けた後に走るので、一時ディレクトリはグローバルに置く。
  scenario_tmp="$(mktemp -d)"
  trap 'remove_scenario_tmp "${scenario_tmp}" || exit 1' EXIT
  sha="$(export_scenario_ref "${src}" "${ref}" "${scenario_tmp}")"
  apply_scenario_overlay "${repo_root}" "${scenario_tmp}" "${sha}"
  echo "overlay した: scenario ${sha}（$(scenario_id_of "${repo_root}")）。戻すときは restore。"
}

cmd_status() {
  local marker="${repo_root}/${scenario_overlay_marker}"
  if [ ! -f "${marker}" ]; then
    echo "overlay していない。"
    return
  fi
  echo "overlay 中: $(sed -n 's/^commit=//p' "${marker}")（$(sed -n 's/^id=//p' "${marker}")）、ファイル $(sed '1,/^files:$/d' "${marker}" | grep -c .) 件"
}

[ $# -ge 1 ] || usage
command="$1"
shift
case "${command}" in
  apply) cmd_apply "$@" ;;
  restore)
    [ $# -eq 0 ] || usage
    restore_scenario_overlay "${repo_root}"
    echo "restore した。"
    ;;
  status)
    [ $# -eq 0 ] || usage
    cmd_status
    ;;
  *) usage ;;
esac
