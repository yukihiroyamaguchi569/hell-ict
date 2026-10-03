#!/usr/bin/env bash
# Decide whether the audit lane (pnpm verify:full) can be skipped for a PR push.
#
# Skip only when the push added nothing but a clean merge of the base branch:
#   1. HEAD is a merge commit whose first parent is the previously pushed head (BEFORE_SHA),
#      so no other commit arrived with this push,
#   2. the PR targets main and its second parent is already on origin/main (it brings in main),
#   3. re-running the merge with `git merge-tree` has no conflict and yields exactly HEAD's
#      tree (no hand-made edits such as conflict resolution).
# Anything else, including any git error, means "run the audit lane".
#
# Inputs (env): HEAD_SHA, BEFORE_SHA, BASE_REF. Requires full history of HEAD and origin/main.
# Outputs: skip=true|false to $GITHUB_OUTPUT and the reason to $GITHUB_STEP_SUMMARY when set.
set -uo pipefail

decide() {
  local skip="$1" reason="$2"
  echo "skip=${skip}: ${reason}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "skip=${skip}" >>"$GITHUB_OUTPUT"; fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    if [ "$skip" = true ]; then
      echo "監査レーンをスキップ: ${reason}" >>"$GITHUB_STEP_SUMMARY"
    else
      echo "監査レーンを実行: ${reason}" >>"$GITHUB_STEP_SUMMARY"
    fi
  fi
  exit 0
}

head_sha="${HEAD_SHA:?HEAD_SHA is required}"
before_sha="${BEFORE_SHA:-}"
base_ref="${BASE_REF:?BASE_REF is required}"

if [ "$base_ref" != main ]; then
  decide false "PRの向き先が main ではない（${base_ref}）"
fi
read -r -a parents <<<"$(git rev-list --parents -n 1 "$head_sha" 2>/dev/null)"
if [ "${#parents[@]}" -ne 3 ]; then
  decide false "HEAD はマージコミットではない"
fi
first="${parents[1]}"
second="${parents[2]}"

if [ "$first" != "$before_sha" ]; then
  decide false "マージ以外のコミットも一緒にpushされている（1番目の親 ${first} が直前のhead ${before_sha:-なし} と違う）"
fi
if ! git merge-base --is-ancestor "$second" origin/main 2>/dev/null; then
  decide false "2番目の親 ${second} が origin/main に含まれていない（main の取り込みではない）"
fi
if ! merged_tree="$(git merge-tree --write-tree "$first" "$second" 2>/dev/null)"; then
  decide false "取り込みに衝突がある（手で解いたマージは検査する）"
fi
if [ "$merged_tree" != "$(git rev-parse "${head_sha}^{tree}")" ]; then
  decide false "マージ結果に自動マージ以外の変更がある"
fi
decide true "main を衝突なく取り込んだだけのpush（${second}）"
