#!/usr/bin/env bash
# Claude Agent SDK 를 올린 뒤 실제 Claude 로 slcode 를 확인한다 (ticket slcode-agent-sdk-update). 가짜 API 테스트(pnpm test)로 못 보는 것만 본다.
# 사용자 로그인(~/.claude/.credentials.json)의 사본을 격리 HOME 에 넣어 돌리고, 끝나면 사본을 지운다. 사용자 ~/.claude 에는 쓰지 않는다.
#
#   scripts/sdk-check.sh [--old <이전 판 slcode 폴더>] [--models "sonnet fable"]
#
#   먼저 pnpm build. --old 는 이전 SDK 로 빌드한 slcode 폴더(dist/cli.js·node_modules 가 있는 곳, 예: git archive 로 푼 main) —
#   주면 그 판으로 만든 세션을 이 판으로 이어받고, 그 판의 claude CLI 로 만든 기록을 import 한다.
#   --models 의 모델마다 한 턴씩 돌려 실제로 답하는지 본다. 나머지는 haiku (모두 합쳐 약 15턴, --models 는 모델을 바꿔 캐시가 없어 비싸다).
#   KEEP=1 이면 작업 폴더(로그·세션 기록)를 남긴다. 로그인 사본은 늘 지운다.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST=$ROOT/dist
OLD=; MODELS=
while [ $# -gt 0 ]; do
  case $1 in
    --old) OLD=$(cd "$2" && pwd); shift 2 ;;
    --models) MODELS=$2; shift 2 ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -f "$DIST/cli.js" ] || { echo "dist/cli.js 가 없다 — 먼저 pnpm build" >&2; exit 2; }
[ -f "$HOME/.claude/.credentials.json" ] || { echo "~/.claude/.credentials.json 이 없다 (Claude 로그인 필요)" >&2; exit 2; }
# 사본이 토큰을 갱신하면 원본의 refresh token 이 낡는다 — 갱신할 일이 없게 만료가 1시간 넘게 남았을 때만 돈다 (2026-11-12)
left=$(node -e "const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).claudeAiOauth;console.log(o?Math.floor((o.expiresAt-Date.now())/60000):9999)" "$HOME/.claude/.credentials.json")
[ "$left" -gt 60 ] || { echo "로그인 토큰 만료까지 ${left}분 — claude 를 한 번 써서 갱신한 뒤 다시 (사본이 갱신하면 원본 로그인이 낡는다)" >&2; exit 2; }

R=$(mktemp -d /tmp/slcode-sdk-check-XXXX)
W=$R/work
mkdir -p "$R/home/.claude" "$R/state" "$W"
cp "$HOME/.claude/.credentials.json" "$R/home/.claude/" && chmod 600 "$R/home/.claude/.credentials.json"
echo '{"hasCompletedOnboarding":true}' | tee "$R/home/.claude.json" > "$R/home/.claude/.claude.json"
(cd "$W" && git init -q && echo hello > README.md)

# 부모 Claude Code 의 env(CLAUDE_EFFORT 등)가 섞이지 않게 env -i
E=(env -i "PATH=$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" "HOME=$R/home" "CLAUDE_CONFIG_DIR=$R/home/.claude" "SLCODE_DIR=$R/state" LANG=C.UTF-8)
slc() { "${E[@]}" node "$DIST/cli.js" "$@"; }
oslc() { "${E[@]}" node "$OLD/dist/cli.js" "$@"; }
PIDS=()
bg() { local log=$1; shift; (cd "$W" && "$@" > "$R/$log.log" 2>&1) & PIDS+=($!); }

cleanup() {
  for s in $(slc list 2>/dev/null | node -e 'try{for(const s of JSON.parse(require("fs").readFileSync(0)))console.log(s.id)}catch{}'); do slc close "$s" >/dev/null 2>&1 || true; done
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -f "$R/home/.claude/.credentials.json"
  if [ "${KEEP:-}" = 1 ]; then echo "작업 폴더: $R (로그인 사본은 지웠다)"; else rm -rf "$R"; fi
}
trap cleanup EXIT

FAILS=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+ — $3}"; FAILS=$((FAILS + 1)); fi; }
js() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))"; }
idof() { slc list --all | js "(d.find((s)=>s.title==='$1')||{}).id||''"; }
sockof() { find "$R/state" -path "*/$1/sock" 2>/dev/null | head -1; }
evfile() { find "$R/state" -path "*/$1/events.jsonl" | head -1; }
rpc() { # rpc <id> <method> [<json>]
  "${E[@]}" node --input-type=module -e "const {connectSession}=await import('$DIST/client.js');const c=await connectSession(process.argv[1]);try{console.log(JSON.stringify(await c.request(process.argv[2],{id:process.argv[3],...JSON.parse(process.argv[4])})))}catch(e){console.log(JSON.stringify({error:e.message}))}process.exit()" "$(sockof "$1")" "$2" "$1" "${3:-{\}}"
}
until_() { local n=$1; shift; for _ in $(seq "$n"); do if "$@"; then return 0; fi; sleep 1; done; return 1; }
up() { [ -n "$(sockof "$1")" ]; }
idle() { [ "$(slc status "$1" --json | js d.state)" = idle ]; }
haspending() { [ "$(slc pending "$1" --json | js d.length)" -gt 0 ]; }
mark() { wc -l < "$(evfile "$1")"; } # 이 뒤의 이벤트만 본다
since() { tail -n +$(($2 + 1)) "$(evfile "$1")"; }
turn() { # turn <id> <text> — 넣고 idle 까지
  local m; m=$(mark "$1"); slc prompt "$1" "$2" >/dev/null; until_ 3 false || true; until_ 240 idle "$1"; echo "$m"
}
last() { slc last "$1" | tail -n +2; }
has() { grep -q -- "$1"; }

set +e # 여기부터는 한 항목이 실패해도 끝까지 본다
echo "== slcode $(slc --version) · SDK $(node -p "require('$ROOT/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version") · 작업 폴더 $R"

# 이전 판 세션 (이어받기용)
if [ -n "$OLD" ]; then
  bg old oslc new "$W" --no-web --model haiku --title old -- "Reply with exactly: OLD-OK"
  OID=
  for _ in $(seq 120); do OID=$(idof old); [ -n "$OID" ] && idle "$OID" 2>/dev/null && [ "$(slc status "$OID" --json | js d.turns)" = 1 ] && break; sleep 1; done
  oslc close "$OID" >/dev/null
  OCLI=$(find "$OLD/node_modules" -path '*claude-agent-sdk-linux-*/claude' -type f | head -1)
  (cd "$W" && "${E[@]}" "$OCLI" -p "Reply with exactly: IMPORT-SRC" --model haiku --output-format json > "$R/native.json")
fi

# 새 세션 — 승인 요청 모드
bg new slc new "$W" --no-web --model haiku --mode default --title check
until_ 60 sh -c "[ -n \"\$(find '$R/state' -name sock)\" ]"; ID=$(idof check); until_ 30 up "$ID"

r=$(rpc "$ID" session.models)
echo "      모델 목록: $(echo "$r" | js "d.models.map((m)=>m.displayName).join(', ')")"
check "첫 턴 전 모델·effort (getSettings)" $([ "$(echo "$r" | js "!!(d.current&&d.effort)")" = true ]; echo $?) "$(echo "$r" | js '[d.current,d.effort]')"
r=$(rpc "$ID" session.status)
check "플랜 리밋 (usage_EXPERIMENTAL)" $([ "$(echo "$r" | js "!!(d.limits&&d.limits.fiveHour)")" = true ]; echo $?) "$r"

m=$(mark "$ID"); slc prompt "$ID" "Run this exact shell command with the Bash tool: touch approved.txt . Then reply DONE." >/dev/null
until_ 120 haspending "$ID"; req=$(slc pending "$ID" --json | js 'd[0].requestId'); slc respond "$ID" "$req" allow >/dev/null; until_ 120 idle "$ID"
check "도구 승인 (Bash)" $([ -f "$W/approved.txt" ]; echo $?)

m=$(mark "$ID"); slc prompt "$ID" "Use the AskUserQuestion tool to ask me which color I prefer, with options red and blue. Then reply with: COLOR=<my answer>." >/dev/null
until_ 120 haspending "$ID"; req=$(slc pending "$ID" --json | js 'd[0].requestId'); slc respond "$ID" "$req" --answer 2 >/dev/null; until_ 120 idle "$ID"
check "질문 (AskUserQuestion)" $(last "$ID" | grep -qi "COLOR=Blue"; echo $?)

rpc "$ID" session.setMode '{"mode":"bypassPermissions"}' >/dev/null
m=$(mark "$ID"); slc prompt "$ID" "Run with the Bash tool: sleep 8; echo SLEPT . Then run with the Bash tool: echo SECOND . Then reply with both outputs." >/dev/null
until_ 60 sh -c "tail -n +$((m + 1)) '$(evfile "$ID")' | grep -q '\"tool.start\"'"; slc mail "$ID" "Also add the word MAIL-OK at the end of your final reply." --from checker >/dev/null; until_ 3 false || true; until_ 180 idle "$ID"
ends=$(since "$ID" "$m" | grep -c '"kind":"turn.end"' || true)
check "턴 중 메일이 같은 턴에 (SDK 큐 입력)" $([ "$ends" = 1 ] && last "$ID" | has MAIL-OK; echo $?) "turn.end $ends 번"

m=$(turn "$ID" "Use the Agent tool with subagent_type general-purpose and run_in_background false (wait for it) to read README.md in this folder and report its content. Then reply: SUB=<content>.")
check "서브에이전트 (task 이벤트·parent)" $(since "$ID" "$m" | has '"agentType":"general-purpose"' && since "$ID" "$m" | has '"parent":"toolu_' && last "$ID" | has "SUB=hello"; echo $?)

m=$(turn "$ID" "Use the mcp__slcode__Subagent tool with description 'team check', model 'haiku', and prompt 'Reply with exactly: TEAM-OK'. Then reply with what it returned.")
check "Subagent 도구 팀원" $(last "$ID" | has TEAM-OK; echo $?)

# 훅 — js 훅 플러그인을 설치하고 resume (플러그인은 새로 뜨는 세션부터 실린다)
P=$R/plugin; mkdir -p "$P/main/hooks"
echo '{"name":"guard","version":"1.0.0","parts":{"main":{}}}' > "$P/slcode-plugin.json"
echo '{"hooks":[{"type":"script","file":"hooks/guard.ts"}]}' > "$P/main/hooks/hooks.json"
cat > "$P/main/hooks/guard.ts" <<'EOF'
import { slcode } from 'slcode/api';
slcode.on('PreToolUse', { matcher: 'Bash' }, (hook: any) => {
  if (hook.tool.input.command.includes('BLOCKME')) return hook.block('blocked by guard hook: GUARD-BLOCKED');
});
slcode.on('UserPromptSubmit', (hook: any) => { hook.context('The secret word is HOOK-CTX-42.'); });
slcode.run();
EOF
slc plugin add "$P" >/dev/null
slc close "$ID" >/dev/null; until_ 20 sh -c "! [ -e '$(sockof "$ID")' ]" || true
bg resume slc resume "$ID" --no-web; until_ 40 up "$ID"
m=$(turn "$ID" "Three things: (1) What color did I pick earlier in this conversation? (2) What is the secret word you were told? (3) Run with the Bash tool: echo BLOCKME and tell me what happened. Answer in one line.")
a=$(last "$ID")
check "resume 뒤 대화 기억" $(echo "$a" | grep -qi blue; echo $?)
check "훅 UserPromptSubmit 컨텍스트" $(echo "$a" | has HOOK-CTX-42; echo $?)
check "훅 PreToolUse 차단" $(since "$ID" "$m" | has '"event":"PreToolUse"' && echo "$a" | has GUARD-BLOCKED; echo $?)

rpc "$ID" session.setEffort '{"effort":"low"}' >/dev/null
for model in $MODELS; do
  rpc "$ID" session.setModel "{\"model\":\"$model\"}" >/dev/null
  m=$(turn "$ID" "Which model are you? Reply in one short line.")
  got=$(since "$ID" "$m" | grep '"kind":"session.ready"' | tail -1 | js d.ev.model)
  check "모델 $model 로 한 턴" $(since "$ID" "$m" | grep -q '"kind":"turn.end","ok":true'; echo $?) "$got"
  echo "      $got: $(last "$ID" | sed -n 2p)"
done
rpc "$ID" session.setModel '{"model":"haiku"}' >/dev/null
r=$(rpc "$ID" session.models)
check "모델·effort 바꾸기 (meta·models)" $([ "$(echo "$r" | js '[d.current,d.effort].join()')" = haiku,low ]; echo $?) "$(echo "$r" | js '[d.current,d.effort]')"

bg fork slc fork "$ID" --title forked --no-web; for _ in $(seq 30); do FID=$(idof forked); [ -n "$FID" ] && up "$FID" && break; sleep 1; done
m=$(turn "$FID" "What color did I pick earlier? One word.")
check "복제 (fork)" $(last "$FID" | grep -qi blue; echo $?)
slc close "$FID" >/dev/null

if [ -n "$OLD" ]; then
  bg oldresume slc resume "$OID" --no-web; until_ 40 up "$OID"
  m=$(turn "$OID" "What exact text did you reply with in your previous answer? One line.")
  check "이전 판 세션 이어받기" $(last "$OID" | has OLD-OK; echo $?)
  slc close "$OID" >/dev/null
  V=$(js d.session_id < "$R/native.json")
  bg import slc import "$V" --title imported --no-web; for _ in $(seq 30); do IID=$(idof imported); [ -n "$IID" ] && up "$IID" && break; sleep 1; done
  check "이전 판 CLI 기록 import" $(has "IMPORT-SRC" < "$(evfile "$IID")" || has "1 earlier turns" < "$R/import.log"; echo $?)
fi

echo "== 실패 $FAILS"
[ "$FAILS" = 0 ]
