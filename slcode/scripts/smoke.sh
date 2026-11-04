#!/usr/bin/env bash
# 연기 검사 — 그 플랫폼 머신에서 Linux zip 하나를 푼 뒤 빈 환경(env -i)에서 동봉 node 로 뜨는지 본다. 세션은 격리 --dir 에 둔다.
#
#   scripts/smoke.sh slcode-<버전>-<platform>.zip
set -euo pipefail

d=$(mktemp -d)
unzip -q "$1" -d "$d/app"
slc() { env -i "$d/app/bin/slcode" "$@"; }
slc --help
# 세션은 첫 턴 전까지 Claude 를 띄우지 않으므로 동봉 바이너리는 따로 실행해 본다
env -i "$d/app"/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude --version
[ ! -e "$d/app/node_modules/esbuild" ] || { echo "::error::zip 에 esbuild 가 들어 있다"; exit 1; }
[ -f "$d/app/node_modules/slcode-plugin/dist/hookMain.js" ] && [ ! -L "$d/app/node_modules/slcode-plugin" ] || { echo "::error::zip 의 slcode-plugin 이 없거나 링크다"; exit 1; }
mkdir "$d/state" "$d/work"
slc new "$d/work" --no-web --dir "$d/state" > "$d/new.log" 2>&1 &
pid=$!
id=
for _ in $(seq 60); do
  id=$(slc list --dir "$d/state" | grep -o '"id": "[^"]*"' | cut -d'"' -f4 || true)
  [ -n "$id" ] && break
  sleep 0.5
done
if [ -z "$id" ]; then cat "$d/new.log"; kill "$pid"; echo "::error::세션이 뜨지 않았다"; exit 1; fi
slc close "$id" --dir "$d/state"
wait "$pid"
cat "$d/new.log"
