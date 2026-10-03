#!/usr/bin/env bash
# scripts/deploy-prod.sh が使う、デプロイ前の判定と一時worktreeの出し入れ。
# テスト（scripts/deploy-prod.test.sh）から source して試せるよう、ここではデプロイしない。
# gh への問い合わせは fetch_ci_runs に閉じ込め、テストではこれを差し替える。

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

# 本番のURLなど、リポジトリに置かない値を $1/.deploy.env（コミットしない）から読み込む。
# set -a で読むので、一時worktreeで動く smoke-prod.sh にも環境変数として渡る。
# install・build より前に呼び、HELL_ICT_PROD_URL が無ければその場で止める。
load_deploy_env() {
  local env_file="$1/.deploy.env"
  if [ -f "${env_file}" ]; then
    set -a
    # shellcheck source=/dev/null
    source "${env_file}"
    set +a
  fi
  [ -n "${HELL_ICT_PROD_URL:-}" ] ||
    fail "HELL_ICT_PROD_URL が無い。リポジトリ直下の .deploy.env に HELL_ICT_PROD_URL=https://... を書いてから実行する（docs/development-harness.md「デプロイの流れ」）。"
}

# 本物のシナリオ（private repo hell-ict-scenario）の置き場所を .deploy.env の
# HELL_ICT_SCENARIO_DIR から確かめる。public 側の content はダミーなので、これが無いまま
# 出すとダミーのシナリオが本番に載る。load_deploy_env の後、install より前に呼ぶ。
require_scenario_dir() {
  [ -n "${HELL_ICT_SCENARIO_DIR:-}" ] ||
    fail "HELL_ICT_SCENARIO_DIR が無い。リポジトリ直下の .deploy.env に HELL_ICT_SCENARIO_DIR=<hell-ict-scenario の clone> を書いてから実行する（docs/development-harness.md「デプロイの流れ」）。"
  [ -d "${HELL_ICT_SCENARIO_DIR}" ] && git -C "${HELL_ICT_SCENARIO_DIR}" rev-parse --git-dir >/dev/null 2>&1 ||
    fail "HELL_ICT_SCENARIO_DIR（${HELL_ICT_SCENARIO_DIR}）が git リポジトリではない。hell-ict-scenario を clone した場所を書く。"
}

# GET /api/health の応答 $1 が本番として正しいか。入口ガードが本番の設定で立ち上がり
# （eventNo が true、teamMax が数値）、載っているシナリオがダミーでなく、期待値 $2 が
# あればそれと一致すること。smoke-prod.sh が使う。
health_body_ok() {
  jq -e --arg expected "${2:-}" '
    .status == "ok" and .guards.eventNo == true and (.guards.teamMax | type) == "number"
    and (.scenario | type) == "string" and .scenario != "dummy"
    and ($expected == "" or .scenario == $expected)' <<<"$1" >/dev/null 2>&1
}

# CI（verify.yml）を省略してよいファイルか。docs/ 配下のすべてと、リポジトリ直下の *.md。
# verify.yml の push の paths と同じ規則であり、この規則を変えたら verify.yml も変える。
ci_skippable_path() {
  case "$1" in
    docs/*) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

# 実行中のデプロイの仕組み（このファイル・deploy-prod.sh・overlay・smoke。作業ツリーの版）が、
# 出す版 $1 と同じかを確かめる。古いブランチから実行すると、古いガードで判定したまま本番へ出せてしまうため。
check_deploy_scripts() {
  git diff --quiet "$1" -- scripts/deploy-prod.sh scripts/lib/deploy-checks.sh \
    scripts/lib/scenario-overlay.sh scripts/smoke-prod.sh ||
    fail "デプロイの仕組みが origin/main と違う。git switch main && git pull してから実行する。"
}

# 検証済みのコミットを探して遡る上限（first-parent でのコミット数）。
ci_search_limit=50

fetch_ci_runs() {
  gh run list --workflow verify.yml --branch main --commit "$1" --json status,conclusion,event,databaseId
}

# そのコミットに対する main の検証（push と手動実行）を新しい順に返す。PRの実行は
# main のコミットそのものを検証していないので数えない。同じコミットの手動の再実行は、
# 中身が同じなので flaky の再試行として認める。
main_ci_runs() {
  local raw
  raw="$(fetch_ci_runs "$1")" || fail "gh run list が失敗した。main の CI 結果を確かめられない。"
  jq -c '[.[] | select(.event == "push" or .event == "workflow_dispatch")] | sort_by(-.databaseId)' <<<"${raw}"
}

# target を出してよいかを確かめる。target から first-parent で遡り、verify.yml の実行が
# ある直近のコミット（検証済みのコミット）を探す。そこから target までの変更が
# CIを省略してよいファイルだけなら通す——docs だけの push では verify.yml が走らないため。
check_ci() {
  local target="$1" sha="$1" verified="" n found conclusion
  for ((n = 0; n < ci_search_limit; n++)); do
    found="$(main_ci_runs "${sha}")"
    if [ "$(jq 'length' <<<"${found}")" != "0" ]; then
      if [ "${sha}" = "${target}" ] && [ "$(jq '[.[] | select(.status != "completed")] | length' <<<"${found}")" != "0" ]; then
        fail "${target} の verify.yml がまだ終わっていない。緑になってから実行する。"
      fi
      conclusion="$(jq -r '[.[] | select(.status == "completed")][0].conclusion // "未完了"' <<<"${found}")"
      [ "${conclusion}" = "success" ] || fail "${sha} の verify.yml が成功していない（${conclusion}）。"
      verified="${sha}"
      break
    fi
    sha="$(git rev-parse --verify --quiet "${sha}^1")" || break
  done
  [ -n "${verified}" ] ||
    fail "${target} から ${ci_search_limit} コミット遡っても verify.yml の実行が無い。gh workflow run verify.yml --ref main で検証してから実行する。"

  # --no-renames: コードを docs/ へ移しただけの変更も、移動元（コード）として数える。
  local path unverified=""
  while IFS= read -r path; do
    [ -z "${path}" ] || ci_skippable_path "${path}" || unverified="${unverified}  ${path}"$'\n'
  done <<<"$(git diff --no-renames --name-only "${verified}" "${target}")"
  if [ -n "${unverified}" ]; then
    printf '%s' "${unverified}" >&2
    fail "検証済みの ${verified} から ${target} までに、CIを通っていない変更（上の一覧）がある。gh workflow run verify.yml --ref main で検証してから実行する。"
  fi
  echo "CI ok: ${target}（検証済み: ${verified}）"
}

# デプロイする版を一時ディレクトリ（空）へ取り出す。片付けは remove_deploy_worktree。
add_deploy_worktree() {
  git worktree add --detach "$1" "$2"
}

# 一時worktreeには overlay した private のシナリオが入るので、消せなければ場所を出して失敗する。
remove_deploy_worktree() {
  git worktree remove --force "$1" 2>/dev/null || true
  rm -rf "$1" 2>/dev/null || true
  git worktree prune
  [ ! -e "$1" ] || {
    echo "ERROR: 一時worktree（$1）を消せない。手で消す。" >&2
    return 1
  }
}
