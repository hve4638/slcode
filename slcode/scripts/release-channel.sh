#!/usr/bin/env bash
# 태그 v<버전> → 릴리스 채널 (ticket slcode-prerelease-channels). release.yml 이 $GITHUB_OUTPUT 에 붙여 쓴다.
#
#   scripts/release-channel.sh v0.6.0-beta.1   # channel=beta / prerelease=true / fast=false
#
# 채널은 stable > beta > unstable > experimental (안정한 순서). 꼬리는 -<채널>.<번호> 만 받는다 — 그 밖의 태그는 exit 1.
# fast=true(unstable·experimental)면 release.yml 이 테스트를 건너뛰고 linux-x64 zip 만 만든다.
# 채널을 고르는 쪽은 superlite·marketplace 다. 플러그인(main.js)은 채널을 모르고 plugin.json binary.version 을 따른다.
set -euo pipefail

tag=${1:?태그를 준다 (v<버전>)}
re='^v[0-9]+\.[0-9]+\.[0-9]+(-(beta|unstable|experimental)\.[0-9]+)?$'
if [[ ! $tag =~ $re ]]; then
  echo "태그 $tag 는 v<x.y.z> 또는 v<x.y.z>-<beta|unstable|experimental>.<번호> 가 아니다" >&2
  exit 1
fi
channel=${BASH_REMATCH[2]:-stable}
prerelease=false; [ "$channel" = stable ] || prerelease=true
fast=false; case $channel in unstable|experimental) fast=true ;; esac
printf 'channel=%s\nprerelease=%s\nfast=%s\n' "$channel" "$prerelease" "$fast"
