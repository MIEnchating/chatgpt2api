#!/usr/bin/env bash

set -euo pipefail

notes_file="RELEASE_NOTES.md"
expected_tag="${1:-}"
max_bytes=100000

fail() {
  printf 'Release notes validation failed: %s\n' "$1" >&2
  exit 1
}

if [ ! -f "$notes_file" ]; then
  fail "$notes_file is required"
fi

file_size="$(wc -c < "$notes_file")"
if [ "$file_size" -eq 0 ]; then
  fail "$notes_file must not be empty"
fi
if [ "$file_size" -gt "$max_bytes" ]; then
  fail "$notes_file must not exceed $max_bytes bytes"
fi

mapfile -t headings < <(grep -nE '^#{1,6}[[:space:]]+' "$notes_file" || true)
if [ "${#headings[@]}" -ne 6 ]; then
  fail "$notes_file must contain exactly one version heading and five allowed section headings"
fi

version_line="${headings[0]%%:*}"
version_heading="${headings[0]#*:}"
if [ "$version_line" != "1" ]; then
  fail "the version heading must be the first line"
fi

if [ -n "$expected_tag" ]; then
  if [[ ! "$expected_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    fail "expected tag must be a stable semantic version"
  fi
  if [ "$version_heading" != "# $expected_tag" ]; then
    fail "version heading must be # $expected_tag"
  fi
elif [[ ! "$version_heading" =~ ^#[[:space:]]v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "version heading must use # vX.Y.Z"
fi

expected_sections=(
  "## 版本概览"
  "## 新增功能"
  "## 功能改进"
  "## 问题修复"
  "## 移除与调整"
)

for index in "${!expected_sections[@]}"; do
  actual_heading="${headings[index + 1]#*:}"
  if [ "$actual_heading" != "${expected_sections[index]}" ]; then
    fail "section $((index + 1)) must be ${expected_sections[index]}"
  fi
done

awk '
  /^## / {
    if (section > 0 && content == 0) {
      exit 1
    }
    section++
    content = 0
    next
  }
  section > 0 && $0 !~ /^[[:space:]]*$/ {
    content = 1
  }
  END {
    if (section != 5 || content == 0) {
      exit 1
    }
  }
' "$notes_file" || fail "every allowed section must contain content"

printf 'Release notes are valid: %s\n' "$notes_file"
