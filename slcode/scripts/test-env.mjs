// 테스트 프로세스와 그 자식(core)의 env — 테스트가 띄운 세션이 사용자 ~/.claude/sessions 에 오르지 않게 Claude Code 등록을 끈다 (claudePeer.ts).
// 등록을 보는 테스트는 SLCODE_CLAUDE_PEER 를 직접 정한다.
process.env.SLCODE_CLAUDE_PEER ??= '0';
