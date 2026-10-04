#!/usr/bin/env bash
# slcode 바이너리 zip 빌드 (ticket slcode-binary-release). Linux 한 머신에서 두 플랫폼을 만든다.
#
#   scripts/release.sh                 linux-x64·win-x64 zip 을 release/ 에 만든다
#   scripts/release.sh win-x64         한 플랫폼만
#   scripts/release.sh --upload        release/ 의 zip 을 GitHub release v<버전> 에 올린다 (gh 로그인·origin 필요)
#
# zip 안 (최상위): manifest.json {version, platform, node}, bin/slcode(sh)·bin/slcode.cmd, runtime/node(.exe),
# dist/, web/, node_modules/ (prod 의존성 — Agent SDK 는 그 플랫폼 패키지 하나만), package.json.
# 플러그인(slcode-plugin-selfinstall)은 자산 이름 slcode-<ver>-<platform>.zip 과 bin/ 진입만 안다 — 바꾸면 그쪽도 바꾼다.
set -euo pipefail

NODE_VERSION=${NODE_VERSION:-24.21.0} # 현재 LTS (Krypton). 공식 배포에서 실행 파일만 꺼내고 SHASUMS256 을 대조한다
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/release
VER=$(node -p "require('$ROOT/package.json').version")

if [ "${1:-}" = "--upload" ]; then
  tag=v$VER
  zips=("$OUT/slcode-$VER-linux-x64.zip" "$OUT/slcode-$VER-win-x64.zip")
  for z in "${zips[@]}"; do [ -f "$z" ] || { echo "없음: $z — 먼저 scripts/release.sh" >&2; exit 1; }; done
  # 태그는 지금 HEAD 에 건다. 이미 있으면 자산만 덮어쓴다
  gh release view "$tag" >/dev/null 2>&1 || gh release create "$tag" --target "$(git -C "$ROOT" rev-parse HEAD)" --title "slcode $tag" --notes "slcode $tag 바이너리 (linux-x64, win-x64)"
  gh release upload "$tag" "${zips[@]}" --clobber
  exit 0
fi

platforms=("$@"); [ ${#platforms[@]} -gt 0 ] || platforms=(linux-x64 win-x64)

mkdir -p "$OUT/cache"
(cd "$ROOT" && pnpm install --frozen-lockfile && pnpm build)

# 공식 배포의 SHASUMS256.txt 로 대조한 파일만 쓴다
fetch_node() { # $1 = 배포 파일 이름
  local f=$1 base=https://nodejs.org/dist/v$NODE_VERSION
  cd "$OUT/cache"
  [ -f "SHASUMS256-v$NODE_VERSION.txt" ] || curl -fsSL -o "SHASUMS256-v$NODE_VERSION.txt" "$base/SHASUMS256.txt"
  [ -f "$f" ] || curl -fL -o "$f" "$base/$f"
  grep " $f\$" "SHASUMS256-v$NODE_VERSION.txt" | sha256sum -c --quiet - || { rm -f "$f"; echo "SHASUMS 불일치: $f" >&2; exit 1; }
  cd - >/dev/null
}

for plat in "${platforms[@]}"; do
  case $plat in
    linux-x64) os=linux; libc=glibc; nodepkg=node-v$NODE_VERSION-linux-x64 ;;
    win-x64) os=win32; libc=; nodepkg=node-v$NODE_VERSION-win-x64 ;;
    *) echo "모르는 플랫폼: $plat (linux-x64 | win-x64)" >&2; exit 1 ;;
  esac
  echo "== $plat"
  (cd "$OUT" && rm -rf "stage-$plat")
  st=$OUT/stage-$plat
  mkdir -p "$st/bin" "$st/runtime"
  cp -r "$ROOT/dist" "$ROOT/web" "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$st/"

  # 대상 플랫폼 의존성 — lockfile 그대로, hoisted(심링크 없는 평평한 node_modules — zip·Windows 에서 안전)
  cat > "$st/pnpm-workspace.yaml" <<EOF
supportedArchitectures:
  os: [$os]
  cpu: [x64]
  libc: [$libc]
EOF
  (cd "$st" && pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --ignore-scripts)
  (cd "$st" && rm -rf node_modules/.bin node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json pnpm-workspace.yaml pnpm-lock.yaml)

  if [ $os = win32 ]; then
    fetch_node "$nodepkg.zip"
    unzip -q -j -o "$OUT/cache/$nodepkg.zip" "$nodepkg/node.exe" "$nodepkg/LICENSE" -d "$st/runtime"
  else
    fetch_node "$nodepkg.tar.xz"
    tar -xJf "$OUT/cache/$nodepkg.tar.xz" -C "$st/runtime" --strip-components=2 "$nodepkg/bin/node"
    tar -xJf "$OUT/cache/$nodepkg.tar.xz" -C "$st/runtime" --strip-components=1 "$nodepkg/LICENSE"
  fi

  cat > "$st/bin/slcode" <<'EOF'
#!/bin/sh
# slcode 런처 — 동봉 node 로 dist/cli.js 를 띄운다. 심링크로 불려도 실제 위치를 따른다
d=$(dirname "$(readlink -f "$0")")
exec "$d/../runtime/node" "$d/../dist/cli.js" "$@"
EOF
  chmod +x "$st/bin/slcode"
  printf '@"%%~dp0..\\runtime\\node.exe" "%%~dp0..\\dist\\cli.js" %%*\r\n' > "$st/bin/slcode.cmd"

  printf '{ "version": "%s", "platform": "%s", "node": "%s" }\n' "$VER" "$plat" "$NODE_VERSION" > "$st/manifest.json"

  zip=$OUT/slcode-$VER-$plat.zip
  rm -f "$zip"
  (cd "$st" && zip -qr -X "$zip" .)
  echo "$zip $(du -h "$zip" | cut -f1)"
done
