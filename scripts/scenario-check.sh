#!/usr/bin/env bash
# 本物のシナリオを overlay した状態で、型検査と content・domain・worker のテストが通るかを
# 確かめる。シナリオの repo を更新したときや、public 側を変えたときに手元で実行する。
#
#   bash scripts/scenario-check.sh <シナリオの repo> [--ref <ref>]   # 既定は origin/main
#
# この作業ツリーの HEAD（コミット済みの内容）を一時 worktree へ取り出して、そこへ overlay する。
# 今の作業ツリーは書き換えず、一時 worktree は成功しても失敗しても片付ける。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"
# shellcheck source=scripts/lib/deploy-checks.sh
source "${repo_root}/scripts/lib/deploy-checks.sh"
# shellcheck source=scripts/lib/scenario-overlay.sh
source "${repo_root}/scripts/lib/scenario-overlay.sh"

usage() {
  echo "使い方: bash scripts/scenario-check.sh <シナリオの repo> [--ref <ref>]" >&2
  exit 2
}
[ $# -ge 1 ] || usage
src="$1"
ref="origin/main"
shift
if [ $# -gt 0 ]; then
  [ $# -eq 2 ] && [ "$1" = "--ref" ] || usage
  ref="$2"
fi

check_dir="$(mktemp -d)"
scenario_tmp="$(mktemp -d)"
# 取り出したシナリオを先に消す（worktree の片付けが失敗しても private の内容を残さない）。
trap 'tmp_ok=0; remove_scenario_tmp "${scenario_tmp}" || tmp_ok=1
  cd "${repo_root}" && remove_deploy_worktree "${check_dir}"; [ "${tmp_ok}" = 0 ] || exit 1' EXIT
add_deploy_worktree "${check_dir}" HEAD
scenario_commit="$(export_scenario_ref "${src}" "${ref}" "${scenario_tmp}")"
apply_scenario_overlay "${check_dir}" "${scenario_tmp}" "${scenario_commit}"
echo "scenario: ${scenario_commit}（$(scenario_id_of "${check_dir}")）を $(git rev-parse --short HEAD) に overlay した"

cd "${check_dir}"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:content
pnpm test:domain
pnpm test:worker
echo "scenario-check ok"
