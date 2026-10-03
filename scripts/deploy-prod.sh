#!/usr/bin/env bash
# 本番Worker（hell-ict）へ手元からデプロイする。`pnpm deploy:prod` で呼ぶ。
#
# GitHub Actionsからは出さない。本番Workerを書き換えられるCloudflareのトークンを
# GitHub Secrets（とワークフロー内の第三者Action）に置かないためである（Issue #366）。
# 認証は手元の `wrangler login` だけに置き、Actionsはテスト（verify.yml）にだけ使う。
# 参加者の進行中はデプロイしない。デプロイしたら全端末をリロードする
# （docs/development-harness.md「デプロイの流れ」）。
#
# 出すのは origin/main のコミットだけである。一時ディレクトリへ worktree として取り出して
# そこで組み立てるので、今いるブランチや未コミット・未追跡のファイルは配信物に混ざらない
# （どのブランチにいても実行できる）。CIを通っていない変更を含むときは止まる
# （判定は scripts/lib/deploy-checks.sh）。
# 一時worktreeには、本物のシナリオ（.deploy.env の HELL_ICT_SCENARIO_DIR にある private repo の
# HELL_ICT_SCENARIO_REF。既定 origin/main）を overlay してから組み立てる
# （scripts/lib/scenario-overlay.sh）。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"
# shellcheck source=scripts/lib/deploy-checks.sh
source "${repo_root}/scripts/lib/deploy-checks.sh"
# shellcheck source=scripts/lib/scenario-overlay.sh
source "${repo_root}/scripts/lib/scenario-overlay.sh"

load_deploy_env "${repo_root}"
# public 側の content はダミーなので、本物のシナリオ（private repo）を overlay してから出す。
# 取り出すのはシナリオの repo の push 済みのコミット（既定 origin/main）。
require_scenario_dir
scenario_ref="${HELL_ICT_SCENARIO_REF:-origin/main}"
command -v gh >/dev/null || fail "gh が無いので main の CI 結果を確かめられない。gh を入れてから実行する。"
gh auth status >/dev/null 2>&1 || fail "gh が未認証なので main の CI 結果を確かめられない。gh auth login してから実行する。"

git fetch origin main
check_deploy_scripts origin/main
target="$(git rev-parse origin/main)"
check_ci "${target}"

deploy_dir="$(mktemp -d)"
scenario_tmp="$(mktemp -d)"
# 成功しても失敗しても一時worktreeと取り出したシナリオを片付ける。overlay した中身は
# 一時worktreeの中にだけあり、手元の作業ツリーには書かない。取り出したシナリオを先に消す
# （worktree の片付けが失敗しても private の内容を残さない）。
trap 'tmp_ok=0; remove_scenario_tmp "${scenario_tmp}" || tmp_ok=1
  cd "${repo_root}" && remove_deploy_worktree "${deploy_dir}"; [ "${tmp_ok}" = 0 ] || exit 1' EXIT
add_deploy_worktree "${deploy_dir}" "${target}"
scenario_commit="$(export_scenario_ref "${HELL_ICT_SCENARIO_DIR}" "${scenario_ref}" "${scenario_tmp}")"
apply_scenario_overlay "${deploy_dir}" "${scenario_tmp}" "${scenario_commit}"
scenario_id="$(scenario_id_of "${deploy_dir}")"
echo "scenario: ${scenario_commit}（${scenario_id}、${scenario_ref}）"
cd "${deploy_dir}"

pnpm install --frozen-lockfile
# overlay したシナリオで型と判定が壊れていないかを、出す前に確かめる。
pnpm typecheck
pnpm test:content
pnpm test:domain
pnpm test:worker
# 配信するVueアプリ・画像・ダッシュボードを apps/worker/public/ へ生成する。
# wrangler.jsoncのassets.directoryがこのディレクトリを指している。
pnpm build:testplay
(cd apps/worker && pnpm exec wrangler deploy)

# 出したのと同じ版の smoke で確かめる。載ったシナリオが overlay したものかも見る。
HELL_ICT_EXPECTED_SCENARIO="${scenario_id}" bash scripts/smoke-prod.sh
