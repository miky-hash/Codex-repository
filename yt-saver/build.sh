#!/usr/bin/env bash
# app.py · static/index.html · start.sh 를 setup.template.sh 의 '#@embed <파일>' 자리에 넣어
# 폰에 한 파일로 옮길 수 있는 ytapp_setup.sh 를 만든다.
#   bash build.sh          → ytapp_setup.sh 다시 만들기
#   bash build.sh --check  → ytapp_setup.sh 가 원본 파일들과 맞는지 확인만 (다르면 실패)
set -euo pipefail
cd "$(dirname "$0")"

out=$(mktemp)
trap 'rm -f "$out"' EXIT

term=""
while IFS= read -r line || [ -n "$line" ]; do
  if [[ $line =~ \<\<\'([A-Z]+)\'$ ]]; then
    term=${BASH_REMATCH[1]}
  fi
  if [[ $line =~ ^#@embed\ (.+)$ ]]; then
    src=${BASH_REMATCH[1]}
    [ -f "$src" ] || { echo "없는 파일: $src" >&2; exit 1; }
    # 파일 안에 heredoc 끝 표시와 똑같은 줄이 있으면 설치 스크립트가 중간에 끊긴다.
    if [ -n "$term" ] && grep -qx "$term" "$src"; then
      echo "$src 안에 '$term' 만 있는 줄이 있어요. 끝 표시를 바꾸세요." >&2; exit 1
    fi
    [ -z "$(tail -c1 "$src")" ] || { echo "$src 끝에 줄바꿈이 없어요." >&2; exit 1; }
    cat "$src" >> "$out"
  else
    printf '%s\n' "$line" >> "$out"
  fi
done < setup.template.sh

if [ "${1:-}" = "--check" ]; then
  if cmp -s "$out" ytapp_setup.sh; then
    echo "ytapp_setup.sh 최신 상태"
  else
    echo "ytapp_setup.sh 가 원본 파일과 달라요. bash build.sh 를 실행하세요." >&2; exit 1
  fi
else
  cp "$out" ytapp_setup.sh
  chmod +x ytapp_setup.sh
  echo "ytapp_setup.sh 만들었어요."
fi
