#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$repo_root/.githooks/pre-commit"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

setup_repo() {
  local name="$1"
  mkdir "$test_root/$name"
  cd "$test_root/$name"
  git init -q
  git config user.name 'Hook Test'
  git config user.email 'hook-test@example.invalid'
  printf 'package sample\n\nvar value = 1\n' > main.go
  git add main.go
  git -c core.hooksPath=/dev/null commit -qm 'Initial fixture'
}

assert_unchanged() {
  local path="$1"
  local staged_hash="$2"
  local working_hash="$3"
  [[ "$(git rev-parse ":$path")" == "$staged_hash" ]] || fail "staged content changed: $path"
  [[ "$(git hash-object -- "$path")" == "$working_hash" ]] || fail "unstaged content changed: $path"
}

setup_repo fully-staged
printf 'package sample\nvar value=2\n' > main.go
git add main.go
bash "$hook"
printf 'package sample\n\nvar value = 2\n' > "$test_root/expected.go"
cmp -s main.go "$test_root/expected.go" || fail 'fully staged file was not formatted'
git diff --quiet -- main.go || fail 'formatted content was not staged'
printf 'PASS: fully staged files are formatted and staged\n'

for path in main.go 'file with spaces.go'; do
  setup_repo "partially-staged-${path// /-}"
  if [[ "$path" != main.go ]]; then
    git mv main.go "$path"
    git -c core.hooksPath=/dev/null commit -qm 'Rename fixture'
  fi
  printf 'package sample\n\nvar value = 2\n' > "$path"
  git add -- "$path"
  printf 'package sample\nvar value=3\n' > "$path"
  staged_hash="$(git rev-parse ":$path")"
  working_hash="$(git hash-object -- "$path")"
  bash "$hook"
  assert_unchanged "$path" "$staged_hash" "$working_hash"
  printf 'PASS: formatted partial staging is preserved: %s\n' "$path"
done

setup_repo unformatted-partial
printf 'package sample\nvar value=2\n' > main.go
git add main.go
printf 'package sample\n\nvar value = 3\n' > main.go
staged_hash="$(git rev-parse :main.go)"
working_hash="$(git hash-object main.go)"
if bash "$hook" > "$test_root/hook-error.log" 2>&1; then
  fail 'unformatted partial staging was accepted'
fi
assert_unchanged main.go "$staged_hash" "$working_hash"
rg -q 'partially staged Go file needs gofmt: main.go' "$test_root/hook-error.log" || fail 'missing actionable formatting error'
printf 'PASS: unformatted partial staging fails without changing content\n'

setup_repo invalid-partial
printf 'package sample\n\nfunc broken(\n' > main.go
git add main.go
printf 'package sample\n\nvar value = 3\n' > main.go
staged_hash="$(git rev-parse :main.go)"
working_hash="$(git hash-object main.go)"
if bash "$hook" > "$test_root/hook-error.log" 2>&1; then
  fail 'invalid partially staged Go syntax was accepted'
fi
assert_unchanged main.go "$staged_hash" "$working_hash"
printf 'PASS: invalid staged syntax fails without changing content\n'
