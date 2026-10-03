#!/usr/bin/env bash
# scripts/lib/deploy-checks.sh のテスト。`pnpm test:scripts`（verify:checks）から走る。
# gh は fetch_ci_runs を差し替えてスタブし、一時gitリポジトリの上で判定を試す。
# デプロイ（build・wrangler deploy）そのものはここでは試さない。
set -euo pipefail

lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-checks.sh"
failures=0
ok() { echo "ok - $1"; }
ng() {
  echo "not ok - $1" >&2
  failures=$((failures + 1))
}

# --- CIを省略してよいファイルの判定（verify.yml の push の paths と同じ規則）
expect_skippable() {
  if (source "${lib}" && ci_skippable_path "$1"); then ok "省略してよい: $1"; else ng "省略してよい: $1"; fi
}
expect_required() {
  if (source "${lib}" && ci_skippable_path "$1"); then ng "CIが要る: $1"; else ok "CIが要る: $1"; fi
}
expect_skippable "docs/development-harness.md"
expect_skippable "docs/ui/00_共通シェルと通奏低音.md"
expect_skippable "docs/review/a/b.png"
expect_skippable "README.md"
expect_skippable "AGENTS.md"
expect_skippable "docs/materials/stage1.md"
expect_required "apps/web/src/main.ts"
expect_required "apps/web/notes.md"
expect_required "scripts/deploy-prod.sh"
expect_required "package.json"
expect_required "docsx/a.md"

# --- 一時リポジトリ。履歴は c0（検証済み）→ c1 docs → c2 README → c3 教材 → c4 コード
#     → c5 コードをdocsへ移動 → c6 コード
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
repo="${work}/repo"
stub_dir="${work}/runs"
mkdir -p "${stub_dir}"
git init -q -b main "${repo}"
cd "${repo}"

# 手元のグローバルなgitフック（mainへのコミット禁止など）に左右されないよう、フックを切る。
git_commit() {
  git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null commit -q -m "$1"
}
commit_file() {
  mkdir -p "$(dirname "$1")"
  echo "${RANDOM}" >>"$1"
  git add "$1"
  git_commit "$1"
  git rev-parse HEAD
}
stub_runs() { echo "$2" >"${stub_dir}/$1.json"; }
run() { echo "{\"status\":\"$1\",\"conclusion\":\"$2\",\"event\":\"$3\",\"databaseId\":$4}"; }

c0="$(commit_file apps/a.ts)"
c1="$(commit_file docs/note.md)"
c2="$(commit_file README.md)"
c3="$(commit_file docs/materials/stage1.md)"
c4="$(commit_file apps/b.ts)"
git mv apps/b.ts docs/b.ts
git_commit "move"
c5="$(git rev-parse HEAD)"
c6="$(commit_file apps/c.ts)"
stub_runs "${c0}" "[$(run completed success push 1)]"

# check_ci をサブシェルで呼ぶ。gh の代わりに runs/<sha>.json を返す。
check() {
  (
    source "${lib}"
    fetch_ci_runs() { cat "${stub_dir}/$1.json" 2>/dev/null || echo "[]"; }
    if [ -n "${2-}" ]; then ci_search_limit="$2"; fi
    check_ci "$1"
  ) >/dev/null 2>&1
}
expect_pass() { if check "$2" "${3-}"; then ok "$1"; else ng "$1"; fi; }
expect_stop() { if check "$2" "${3-}"; then ng "$1"; else ok "$1"; fi; }

expect_pass "検証済みのコミットそのものは通す" "${c0}"
expect_pass "検証済みからdocsだけの変更は通す" "${c1}"
expect_pass "検証済みからdocsとルートの*.mdだけの変更は通す" "${c2}"
expect_pass "検証済みから docs/materials の変更も通す（docs/ は丸ごと省略してよい）" "${c3}"
expect_stop "コードを含む変更は止める" "${c4}"
expect_stop "遡りの上限までに検証済みが無ければ止める" "${c2}" 2

stub_runs "${c4}" "[$(run completed success push 2)]"
expect_stop "コードをdocsへ移しただけの変更も止める（移動元を見る）" "${c5}"

stub_runs "${c6}" "[$(run in_progress "" push 3)]"
expect_stop "対象の実行が終わっていなければ止める" "${c6}"
stub_runs "${c6}" "[$(run completed failure push 3)]"
expect_stop "対象の実行が失敗なら止める" "${c6}"
stub_runs "${c6}" "[$(run completed failure push 3),$(run completed success workflow_dispatch 4)]"
expect_pass "同じコミットの手動の再実行が成功なら通す" "${c6}"
stub_runs "${c6}" "[$(run completed success push 3),$(run completed failure workflow_dispatch 4)]"
expect_stop "最新の実行が失敗なら止める" "${c6}"
stub_runs "${c6}" "[$(run completed success pull_request 5)]"
expect_stop "PRの実行は main の検証として数えない" "${c6}"

rm -f "${stub_dir}"/*.json
expect_stop "どこにも実行が無ければ止める" "${c2}"

# --- デプロイ用の一時worktreeを作って片付ける
if (
  source "${lib}"
  dir="$(mktemp -d)"
  add_deploy_worktree "${dir}" "${c0}" >/dev/null 2>&1
  [ -f "${dir}/apps/a.ts" ] && [ ! -e "${dir}/apps/c.ts" ] || exit 1
  remove_deploy_worktree "${dir}"
  [ ! -e "${dir}" ] && [ "$(git worktree list | wc -l | tr -d ' ')" = "1" ]
); then ok "一時worktreeを作って跡形なく片付ける"; else ng "一時worktreeを作って跡形なく片付ける"; fi
mkdir -p "${work}/wt-parent"
if (
  source "${lib}"
  add_deploy_worktree "${work}/wt-parent/wt" "${c0}" >/dev/null 2>&1
  chmod 555 "${work}/wt-parent"
  out="$(remove_deploy_worktree "${work}/wt-parent/wt" 2>&1)" && exit 1
  grep -qF "一時worktree（${work}/wt-parent/wt）を消せない" <<<"${out}"
); then ok "一時worktreeを消せなければ場所を出して失敗する"; else ng "一時worktreeを消せなければ場所を出して失敗する"; fi
chmod 755 "${work}/wt-parent"
(source "${lib}" && remove_deploy_worktree "${work}/wt-parent/wt")

# --- 実行中のデプロイの仕組みが、出す版（ここでは HEAD）と同じか
commit_file scripts/deploy-prod.sh >/dev/null
commit_file scripts/lib/deploy-checks.sh >/dev/null
check_scripts() { (source "${lib}" && check_deploy_scripts HEAD) 2>&1; }
if check_scripts >/dev/null; then ok "デプロイの仕組みが一致すれば続ける"; else ng "デプロイの仕組みが一致すれば続ける"; fi
echo "local" >>scripts/lib/deploy-checks.sh
if out="$(check_scripts)"; then
  ng "デプロイの仕組みが違えば止める"
elif grep -qF "デプロイの仕組みが origin/main と違う" <<<"${out}"; then
  ok "デプロイの仕組みが違えば止める"
else
  ng "デプロイの仕組みが違えば止める（理由の表示が無い）"
fi
git checkout -q -- scripts/lib/deploy-checks.sh
commit_file scripts/lib/scenario-overlay.sh >/dev/null
commit_file scripts/smoke-prod.sh >/dev/null
for script in scripts/lib/scenario-overlay.sh scripts/smoke-prod.sh; do
  echo "local" >>"${script}"
  if check_scripts >/dev/null; then ng "${script} が違えば止める"; else ok "${script} が違えば止める"; fi
  git checkout -q -- "${script}"
done

# --- 本物のシナリオの置き場所（HELL_ICT_SCENARIO_DIR）
expect_scenario_dir() {
  local name="$1" want="$2" dir="$3" out
  if out="$(source "${lib}" && HELL_ICT_SCENARIO_DIR="${dir}" require_scenario_dir 2>&1)"; then
    if [ -z "${want}" ]; then ok "${name}"; else ng "${name}"; fi
  elif [ -n "${want}" ] && grep -qF "${want}" <<<"${out}"; then
    ok "${name}"
  else
    ng "${name}（${out}）"
  fi
}
expect_scenario_dir "HELL_ICT_SCENARIO_DIR が未設定なら止める" "HELL_ICT_SCENARIO_DIR が無い" ""
expect_scenario_dir "HELL_ICT_SCENARIO_DIR が存在しなければ止める" "git リポジトリではない" "${work}/no-such"
mkdir -p "${work}/not-git"
expect_scenario_dir "HELL_ICT_SCENARIO_DIR が git でなければ止める" "git リポジトリではない" "${work}/not-git"
expect_scenario_dir "HELL_ICT_SCENARIO_DIR が git リポジトリなら通す" "" "${repo}"

# --- /api/health の応答の判定（smoke-prod.sh が使う）
health() { echo "{\"status\":\"ok\",\"guards\":{\"eventNo\":true,\"teamMax\":6}$1}"; }
expect_health() {
  if (source "${lib}" && health_body_ok "$3" "${4-}"); then
    if [ "$2" = pass ]; then ok "$1"; else ng "$1"; fi
  elif [ "$2" = stop ]; then
    ok "$1"
  else
    ng "$1"
  fi
}
expect_health "health: 本物のシナリオなら通す" pass "$(health ',"scenario":"real-1"')"
expect_health "health: 期待値と一致すれば通す" pass "$(health ',"scenario":"real-1"')" real-1
expect_health "health: scenario が無ければ止める" stop "$(health '')"
expect_health "health: scenario が文字列でなければ止める" stop "$(health ',"scenario":1')"
expect_health "health: scenario が dummy なら止める" stop "$(health ',"scenario":"dummy"')"
expect_health "health: 期待値と違えば止める" stop "$(health ',"scenario":"real-1"')" real-2
expect_health "health: eventNo が false なら止める" stop '{"status":"ok","guards":{"eventNo":false,"teamMax":6},"scenario":"real-1"}'
expect_health "health: teamMax が数値でなければ止める" stop '{"status":"ok","guards":{"eventNo":true,"teamMax":"invalid"},"scenario":"real-1"}'
expect_health "health: JSON でなければ止める" stop "<html></html>"

# --- 本番URL（HELL_ICT_PROD_URL）を .deploy.env から読む
#     deploy-prod.sh を一時ディレクトリへ写して走らせる。pnpm・gh・wrangler はスタブで、
#     呼ばれたら calls.log に残す。gh は未認証として失敗させ、それ以上は進ませない。
deploy_root="${work}/deploy-root"
stub_bin="${work}/bin"
calls="${work}/calls.log"
mkdir -p "${deploy_root}/scripts/lib" "${stub_bin}"
cp "$(dirname "${lib}")/../deploy-prod.sh" "${deploy_root}/scripts/"
cp "${lib}" "$(dirname "${lib}")/scenario-overlay.sh" "${deploy_root}/scripts/lib/"
for cmd in pnpm gh wrangler; do
  printf '#!/usr/bin/env bash\necho "%s $*" >>"%s"\nexit 1\n' "${cmd}" "${calls}" >"${stub_bin}/${cmd}"
  chmod +x "${stub_bin}/${cmd}"
done
run_deploy() {
  : >"${calls}"
  env -u HELL_ICT_PROD_URL -u HELL_ICT_SCENARIO_DIR -u HELL_ICT_SCENARIO_REF PATH="${stub_bin}:${PATH}" bash "${deploy_root}/scripts/deploy-prod.sh" 2>&1
}

if out="$(run_deploy)"; then
  ng "HELL_ICT_PROD_URL が無ければ install・build より前に止まる"
elif grep -qF "HELL_ICT_PROD_URL が無い" <<<"${out}" && [ ! -s "${calls}" ]; then
  ok "HELL_ICT_PROD_URL が無ければ install・build より前に止まる"
else
  ng "HELL_ICT_PROD_URL が無ければ install・build より前に止まる（${out}）"
fi

echo "HELL_ICT_PROD_URL=https://example.invalid" >"${deploy_root}/.deploy.env"
if out="$(run_deploy)"; then
  ng "HELL_ICT_SCENARIO_DIR が無ければ install・build より前に止まる"
elif grep -qF "HELL_ICT_SCENARIO_DIR が無い" <<<"${out}" && [ ! -s "${calls}" ]; then
  ok "HELL_ICT_SCENARIO_DIR が無ければ install・build より前に止まる"
else
  ng "HELL_ICT_SCENARIO_DIR が無ければ install・build より前に止まる（${out}）"
fi

echo "HELL_ICT_SCENARIO_DIR=${repo}" >>"${deploy_root}/.deploy.env"
if out="$(run_deploy)"; then
  ng ".deploy.env があれば変数の確認を通る"
elif ! grep -qF "HELL_ICT_PROD_URL が無い" <<<"${out}" && grep -qF "gh が未認証" <<<"${out}" &&
  ! grep -q '^pnpm' "${calls}"; then
  ok ".deploy.env があれば変数の確認を通る"
else
  ng ".deploy.env があれば変数の確認を通る（${out}）"
fi

if [ "$(
  unset HELL_ICT_PROD_URL
  source "${lib}"
  load_deploy_env "${deploy_root}" && bash -c 'printf %s "${HELL_ICT_PROD_URL}"'
)" = "https://example.invalid" ]; then
  ok ".deploy.env の値を子プロセス（smoke）へ渡す"
else
  ng ".deploy.env の値を子プロセス（smoke）へ渡す"
fi

# --- デプロイの経路（overlay → install・検査 → build → wrangler deploy → smoke の順）
#     本物の git で public 役（origin つき）と scenario 役（origin つき）を作り、deploy-prod.sh を
#     そのまま走らせる。gh・pnpm・curl はスタブで、pnpm の呼び出しを順に calls に残す。
flow="${work}/flow"
flow_bin="${flow}/bin"
flow_calls="${flow}/calls.log"
mkdir -p "${flow_bin}"
flow_git() { git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
flow_put() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}
# origin つきの repo を作り、$3 の操作でファイルを置いて main を push する。
flow_repo() {
  git init -q --bare -b main "$1.git"
  git init -q -b main "$1"
  (cd "$1" && eval "$2")
  flow_git -C "$1" add -A
  flow_git -C "$1" commit -q -m init
  flow_git -C "$1" remote add origin "$1.git"
  flow_git -C "$1" push -q origin main
  flow_git -C "$1" fetch -q origin
}
scripts_src="$(dirname "${lib}")/.."
flow_repo "${flow}/public" "
  mkdir -p scripts/lib apps/worker
  cp '${scripts_src}/deploy-prod.sh' '${scripts_src}/smoke-prod.sh' scripts/
  cp '${scripts_src}/lib/deploy-checks.sh' '${scripts_src}/lib/scenario-overlay.sh' scripts/lib/
  printf '.scenario-overlay\n.deploy.env\n' >.gitignore
  touch apps/worker/.gitkeep
  flow_put packages/content/src/index.ts index
  flow_put packages/content/src/schemas.ts schemas
  flow_put packages/content/src/scenario.ts 'export const scenarioId = \"dummy\";'
  flow_put packages/content/src/stage1.ts 'dummy stage1'
"
printf 'HELL_ICT_PROD_URL=https://prod.invalid\nHELL_ICT_SCENARIO_DIR=%s\n' "${flow}/scenario" >"${flow}/public/.deploy.env"

cat >"${flow_bin}/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = auth ] && exit 0
echo '[{"status":"completed","conclusion":"success","event":"push","databaseId":1}]'
EOF
printf '#!/usr/bin/env bash\necho "pnpm $* @ $(cat packages/content/src/stage1.ts 2>/dev/null || cat ../../packages/content/src/stage1.ts)" >>"%s"\n' "${flow_calls}" >"${flow_bin}/pnpm"
# smoke の確かめに答える。health は real-1 のシナリオ、/ は Vue アプリの器、音は 200。
cat >"${flow_bin}/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *-w*) printf 200 ;;
  */api/health) echo '{"status":"ok","guards":{"eventNo":true,"teamMax":6},"scenario":"real-1"}' ;;
  */app/*) ;;
  *) echo '<div id="root"></div><script src="/app/a.js"></script>' ;;
esac
EOF
chmod +x "${flow_bin}"/*

run_flow() {
  rm -rf "${flow}/scenario" "${flow}/scenario.git"
  flow_repo "${flow}/scenario" "$1"
  : >"${flow_calls}"
  (cd "${flow}/public" && env -u HELL_ICT_PROD_URL -u HELL_ICT_SCENARIO_DIR -u HELL_ICT_SCENARIO_REF \
    PATH="${flow_bin}:${PATH}" bash scripts/deploy-prod.sh 2>&1)
}
real_scenario="
  flow_put packages/content/src/scenario.ts 'export const scenarioId = \"real-1\";'
  flow_put packages/content/src/stage1.ts 'real stage1'
"
flow_clean() {
  [ -z "$(git -C "${flow}/public" status --porcelain)" ] &&
    [ "$(git -C "${flow}/public" worktree list | wc -l | tr -d ' ')" = "1" ]
}

expected_calls="pnpm install --frozen-lockfile @ real stage1
pnpm typecheck @ real stage1
pnpm test:content @ real stage1
pnpm test:domain @ real stage1
pnpm test:worker @ real stage1
pnpm build:testplay @ real stage1
pnpm exec wrangler deploy @ real stage1"
if out="$(run_flow "${real_scenario}")" && [ "$(cat "${flow_calls}")" = "${expected_calls}" ] &&
  grep -qF "（real-1、origin/main）" <<<"${out}" && grep -qF "health ok" <<<"${out}" && flow_clean; then
  ok "デプロイ: overlay した中身で検査・build・deploy・smoke を順に流し、跡を残さない"
else
  ng "デプロイ: overlay した中身で検査・build・deploy・smoke を順に流し、跡を残さない（${out:-}）"
fi

expect_flow_stop() {
  local name="$1" want="$3" out
  if out="$(run_flow "$2")"; then
    ng "${name}"
  elif ! grep -qF "${want}" <<<"${out}"; then
    ng "${name}（理由の表示が違う: ${out}）"
  elif [ -s "${flow_calls}" ] || ! flow_clean; then
    ng "${name}（install・deploy へ進んだか、跡が残った）"
  else
    ok "${name}"
  fi
}
expect_flow_stop "デプロイ: ダミーのシナリオなら install より前に止まる" \
  "flow_put packages/content/src/scenario.ts 'export const scenarioId = \"dummy\";'; flow_put packages/content/src/stage1.ts x" \
  "scenarioId が dummy"
expect_flow_stop "デプロイ: 許可外のパスを含むシナリオなら install より前に止まる" \
  "${real_scenario} flow_put packages/domain/src/judge.ts evil" "overlay できないパス"
expect_flow_stop "デプロイ: content を置き換え漏らすシナリオなら install より前に止まる" \
  "flow_put packages/content/src/scenario.ts 'export const scenarioId = \"real-1\";'" "ダミーのまま出てしまう"

if [ "${failures}" -gt 0 ]; then
  echo "${failures} 件失敗" >&2
  exit 1
fi
echo "すべて成功"
