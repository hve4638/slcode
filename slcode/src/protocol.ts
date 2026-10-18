// slcode 프로토콜 — 유일한 계약 표면. 프런트(웹 모드·카드 모드)·CLI 가 전부 이 타입만 본다.
// 프레이밍은 superlite 와이어 꼴 (사용자 결정 2026-09-26): JSON 한 줄이 프레임이고
//   요청   {id, method, params}
//   응답   {id, result} | {id, error: {code?, message}}
//   이벤트 {event, params}
// 구조 (사용자 결정 2026-09-27, ticket agent-core-split): 세션 하나 = core 프로세스 하나가 자기 안에서 쥔다.
//   세션 소켓 sessions/<cwd 슬러그>/<id>/sock (Methods 의 session.*) — serve 가 웹·stdio 연결마다 이 소켓에 하나씩 붙어 같은 메서드를 중계한다
//   (ticket slcode-core-serve-split, 2026-10-15). 세션의 수명은 소유자(core.own 을 보낸 연결 하나)가 정한다.
//   세션 사이 메시지는 켜진 받는 세션의 소켓(session.deliver)으로 직접, 꺼진 세션에는 보내지 않는다 (mail.ts, ticket slcode-p2p-messaging 2026-10-19 — 우체국 없음).
// 이벤트 어휘는 벤더 중립 15종. 각 이벤트는 선택 필드 raw 에 벤더 원문(SDK 메시지)을 같은 봉투로 싣는다 (raw:true 일 때만).

export const PROTOCOL_VERSION = 3;

/** 파일 위치 — $SLCODE_DIR, 없으면 ~/.local/state/slcode */
export const FILES = {
  coreLog: 'core.log',
  token: 'slcode.token',
  sessionsDir: 'sessions',
  sessionSock: 'sock',
  /** 화면 설정 — 입구(SettingsKind)마다 하나 (settings.ts) */
  settingsWeb: 'settings-web.json',
  settingsSuperlite: 'settings-superlite.json',
  /** inspect 의 내부 플래그가 이 SDK 버전에서 듣지 않는다는 기록 (inspect.ts blockInspect) */
  inspectBlocked: 'inspect-blocked.json',
  /** inspect 전체 정리 — 마지막 정리 시각과 정리하는 core 의 잠금 (inspectDb.ts maybeSweep) */
  inspectSweep: 'inspect-sweep.json',
  inspectSweepLock: 'inspect-sweep.lock',
} as const;

export type Vendor = 'claude' | 'codex';

export type SessionState = 'starting' | 'idle' | 'running' | 'requires_action' | 'exited';

/** 세션 한 장 (attach 응답 info·session.changed·CLI list 항목) */
export type SessionInfo = {
  id: string;
  vendor: Vendor;
  cwd: string;
  title: string | null;
  /** 벤더 쪽 세션 id — Claude 는 ~/.claude/projects 의 세션. 벤더 CLI `--resume` 과 상호 호환 */
  vendorSessionId: string | null;
  state: SessionState;
  /** 세션 프로세스가 떠 있는가 (우체국 등록 기준). false 면 저장만 된 세션 — `slcode resume <id>` 로 되살린다 */
  live: boolean;
  /** 마지막 이벤트 seq (attach since 의 기준) */
  seq: number;
  createdAt: number;
  /** 마지막 턴이 끝난 시각 — --continue 의 최근 기준 (createdAt 이 아니다: --resume 으로 되살린 옛 세션이 최근일 수 있다) */
  updatedAt?: number;
  permissionMode: string | null;
  raw: boolean;
  /** Claude 벤더의 API 호출 원본 기록 (session.setInspect) — 한 번도 켠 적 없으면 없다. 새 세션은 입구 설정의 inspect 를 따른다 */
  inspect?: boolean;
};

/** inspect 기록의 호출 하나 요약 (inspect/inspect.db 의 calls 한 행). at 은 요청이 들어온 시각, ms 는 응답이 끝날 때까지. 전체 상한으로 지웠으면 dropped */
export type InspectCall = {
  n: number; at: number; ms: number; method: string; path: string; model: string | null; status: number | null;
  reqBytes: number; resBytes: number; error?: string; dropped?: boolean;
};
/** 호출 하나의 원본 — 인증 헤더는 가렸다. resBody 는 압축을 푼 텍스트 (SSE 는 도착한 그대로).
 *  compacted 면 원본은 지웠다 — reqBody 는 저장한 조각으로 다시 조립한 JSON, SSE 응답은 메시지 하나의 JSON */
export type InspectRecord = InspectCall & {
  reqHeaders: Record<string, string | string[]>; reqBody: string; resHeaders: Record<string, string | string[]>; resBody: string; compacted?: true;
};

/** 턴에 딸린 파일 — 웹 프런트의 붙여넣기·끌어놓기. data 는 base64. 이미지·PDF 는 벤더 블록으로, 텍스트류는 본문에 인라인 */
export type Attachment = { name: string; mediaType: string; data: string };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** 기록 전체의 합계 — 페이지로 받는 웹이 앞 기록 없이 사이드바·비용을 그린다 (ticket slcode-history-paging). 되돌린 턴도 센다.
 *  costUsd 는 비용 합계(turn.end 에 비용이 하나도 없으면 null), lastCostUsd 는 마지막 turn.end 의 costUsd — SDK 비용은 프로세스 누계라
 *  다음 turn.end 가 이보다 작으면 벤더가 새로 떴고 합계에 이어 붙인다. ready 는 마지막 session.ready 본문 */
export type HistorySummary = { turns: number; usage: Usage; costUsd: number | null; lastCostUsd: number | null; hooks: number; lastHook: string | null; ready: Extract<CoreEventBody, { kind: 'session.ready' }> | null };

export type ApprovalDecision = 'allow' | 'deny';
export type ResolvedDecision = ApprovalDecision | 'cancelled';

/** 승인 요청 한 건 (approval.requested 이벤트 본문 = attach 응답 pending 항목) */
export type ApprovalRequest = {
  requestId: string;
  toolUseId: string | null;
  name: string;
  input: unknown;
  /** 벤더가 제안한 영구 규칙 — core 는 세션 한정으로만 되돌린다 (session.approve remember) */
  suggestions: unknown[];
};

/** 서브에이전트(작업) 한 단계 — task.started → progress(주기)… → ended. toolUseId 는 띄운 Agent 도구 호출 (그 카드 안에 그린다) */
export type TaskEvent = {
  kind: 'task'; phase: 'started' | 'progress' | 'ended'; taskId: string; toolUseId: string | null; description: string; agentType: string | null; background: boolean;
  /** progress: 벤더의 한 줄 진행 요약 / ended: 결과 요약 */
  summary: string | null; lastTool: string | null; status: 'completed' | 'failed' | 'stopped' | null;
  usage: { tokens: number; toolUses: number; durationMs: number } | null;
};

/** 이벤트 18종 — 벤더 중립. Codex 어댑터도 같은 kind 를 낸다. parent 는 서브에이전트 안에서 난 이벤트의 부모 tool_use id (없으면 본문) */
export type CoreEventBody =
  | { kind: 'session.ready'; vendor: Vendor; model: string; cwd: string; vendorSessionId: string; permissionMode: string;
      tools: string[]; skills: string[]; plugins: { name: string; path: string }[]; mcp: { name: string; status: string }[];
      slashCommands: string[]; agents: string[]; version: string | null }
  | { kind: 'session.state'; state: SessionState }
  | { kind: 'turn.start'; text: string; origin: string | null; attachments?: { name: string; mediaType: string; size: number }[] }
  | { kind: 'text.delta'; text: string; parent?: string }
  | { kind: 'thinking.delta'; text: string; parent?: string }
  | { kind: 'tool.start'; toolUseId: string; name: string; input: unknown; parent?: string }
  | { kind: 'tool.end'; toolUseId: string; ok: boolean; summary: string; parent?: string }
  | TaskEvent
  | ({ kind: 'approval.requested' } & ApprovalRequest)
  | { kind: 'approval.resolved'; requestId: string; decision: ResolvedDecision }
  | { kind: 'turn.end'; ok: boolean; error: string | null; interrupted: boolean; costUsd: number | null; durationMs: number | null; usage: Usage | null;
      /** 실패의 벤더 중립 분류 — 'auth' 는 그 머신에 로그인이 없거나 풀린 것 (웹이 로그인 안내를 붙인다). 그 밖의 실패·옛 세션은 null 또는 없음 */
      errorKind?: 'auth' | null;
      /** 벤더 쪽 이 턴의 사용자 메시지 uuid(파일 되돌리기 기준)와 마지막 항목 uuid(대화 되돌리기의 유지 지점). Codex 의 uuid 는 turn id (다시 import 할 때 이어 붙일 기준) */
      userUuid?: string | null; uuid?: string | null }
  /** 되돌리기 — seq(turn.start) 부터의 턴을 버렸다. 화면은 그 seq 이후를 지운다. 로그는 그대로 쌓인다 */
  | { kind: 'turn.rewound'; seq: number; conversation: boolean; files: boolean; filesChanged: string[] | null }
  | { kind: 'context.compacted'; trigger: string; preTokens: number | null }
  | { kind: 'hook'; event: string; phase: 'started' | 'response'; ok: boolean | null }
  | { kind: 'error'; message: string }
  /** auto 모드에서 승인 요청을 사람 대신 모델이 판단한 결과 (지금은 Codex auto_review). action 은 대상의 사람이 읽는 한 줄, risk 는 low|medium|high|critical */
  | { kind: 'review'; toolUseId: string | null; decision: 'approved' | 'denied' | 'timedOut' | 'aborted'; risk: string | null; action: string; rationale: string | null }
  /** `slcode import` 가 벤더 기록에서 옮겨 쓴 이벤트들(모양은 실시간 것과 같다) 뒤에 남긴다. 다시 import 해서 늘어난 턴을 붙이면 또 남긴다.
   *  vendorSessionId 는 읽어 온 세션(처음 import 면 원본이고 fork true), uuid 는 그때 벤더 쪽 마지막 지점(Claude 메시지 uuid, Codex turn id).
   *  옛 import(2026-10-15 이전)는 seq 1 의 이것 하나뿐이고 앞 대화는 벤더 기록에만 있다 */
  | { kind: 'session.imported'; vendor: Vendor; vendorSessionId: string; uuid: string | null; fork?: boolean }
  | { kind: 'session.exit'; reason: string };

export type CoreEventKind = CoreEventBody['kind'];

export type CoreEvent = CoreEventBody & { raw?: unknown };

/** 로그에 남고 attach 로 재생되는 단위 — seq 는 세션 안에서 단조 증가 (core 재기동 뒤에도 이어진다) */
export type LoggedEvent = { seq: number; at: number; ev: CoreEvent };

// ---- 요청·응답 (세션 소켓 · 웹 WebSocket)

/** 화면 설정 — 상태 폴더에 입구마다 한 벌 (ticket slcode-web-settings, 사용자 확정 2026-10-16). 같은 입구의 화면끼리 같이 쓴다.
 *  theme 은 id 이고 목록은 웹(web/settings.js)이 정한다 — 모르는 id 는 웹이 'system' 으로 읽는다.
 *  context: warn 이면 ctx % 를 yellow 미만 초록, red 미만 노랑, 그 이상 빨강. 끄면 색 없이. 0 ≤ yellow ≤ red ≤ 100.
 *  inspect: 이 입구에서 여는 새 Claude 세션이 inspect 로 시작한다 (ticket slcode-inspect-default-on, 기본 끔) — 떠 있는 세션은 사이드바 토글로 */
export type Settings = { theme: string; context: { warn: boolean; yellow: number; red: number }; inspect: boolean };
/** 설정 묶음 — 화면이 들어온 입구로 serve 가 정한다. web 은 slcode 가 연 웹(브라우저), superlite 는 superlite 안의 slcode 탭
 *  (서비스 웹 SUPERLITE_SERVICE_WEB·stdio). 두 벌은 완전히 따로다 — 한쪽에서 바꿔도 다른 쪽은 그대로 (사용자 결정 2026-10-16) */
export type SettingsKind = 'web' | 'superlite';
export type SettingsPatch = Partial<Omit<Settings, 'context'>> & { context?: Partial<Settings['context']> };

/** MCP 서버 하나의 지금 상태 — status 는 connected·failed·needs-auth·pending·disabled, error 는 failed 의 사유 (ticket slcode-mcp-failed-path) */
export type McpStatus = { name: string; status: string; error?: string };

/** 플랜 리밋 창 하나 — pct 는 쓴 비율(0-100), resetsAt 은 ISO 8601 */
export type LimitWindow = { pct: number | null; resetsAt: string | null };

export type Methods = {
  /** 첫 요청. UDS 는 소켓 권한(0600)이 곧 인증이라 토큰을 보지 않는다. 루프백 밖 호스트의 웹은 serve 가 remote 를 붙여 넘기고 core 가 토큰을 검사한다.
   *  그 전까지 serve 는 다른 요청을 막고 core 의 프레임을 넘기지 않는다 */
  'core.auth': { params: { token?: string; remote?: boolean }; result: { ok: true; pid: number; protocol: number; session: string } };
  /** 이 연결이 세션 소유자가 된다 (protocol 3). 살아 있는 소유자가 따로 있으면 owned, takeover 면 빼앗고 옛 소유자에게 core.owner 를 보낸다.
   *  소유자가 session.close 없이 끊기면 core 는 SLCODE_OWNER_GRACE_SECS(기본 10초) 동안 새 소유자를 기다리고, 없으면 닫는다 (기동 직후도 같다) */
  'core.own': { params: { pid?: number; takeover?: boolean }; result: { ok: true } };
  /** serve 가 자기 TCP 웹 주소를 알린다 (protocol 3). 이 연결이 끊기면 지운다. url 은 core 가 토큰을 붙여 만든다 */
  'serve.register': { params: { host: string; port: number; version: string }; result: { url: string } };
  /** 이 core 가 쥔 세션과 웹 주소. host·port·url 은 처음 등록된 웹 serve 의 것, 없으면 null */
  /** url 은 접속 가능한 웹 주소(토큰 포함, 0.0.0.0 은 IPv4 로 바꾼 것) — superlite 카드가 iframe 에 넣는다. --no-web 이면 null (2026-10-04).
   *  owner 는 소유자 연결이 알린 pid, serves 는 등록된 웹 serve 들 (protocol 3) */
  'server.info': { params: Record<string, never>; result: { session: string; cwd: string; host: string | null; port: number | null; url: string | null; version: string; build?: number; owner?: number | null; serves?: { host: string; port: number; url: string; version: string }[] } };
  /** 이 연결에 세션의 이벤트 스트림을 켠다. since 뒤의 로그를 history 로, 대기 승인을 pending 으로 */
  /** draft 는 웹 입력창 초안 (session.setDraft 로 맡긴 것, 없으면 '') — 다시 붙은 웹이 비어 있는 입력창을 채운다 */
  /** limit 이 있으면 history 는 끝 한 페이지(되돌린 턴을 빼고 화면 항목 limit 개 안팎, 열린 도구·승인·작업이 없는 turn.start 에서 자른 것)이고 more·summary 가 붙는다 — since 는 보지 않는다.
   *  옛 core 는 limit 을 모르고 전체를 보낸다 (summary 없음) (ticket slcode-history-paging, 2026-10-17) */
  'session.attach': { params: { id: string; since?: number; limit?: number }; result: { info: SessionInfo; history: LoggedEvent[]; pending: ApprovalRequest[]; draft: string; more?: boolean; summary?: HistorySummary } };
  /** seq before 앞의 한 페이지 (attach limit 과 같은 규칙). more 는 그 앞이 더 있는가 */
  'session.history': { params: { id: string; before: number; limit: number }; result: { history: LoggedEvent[]; more: boolean } };
  'session.detach': { params: { id: string }; result: { ok: true } };
  /** idle·running 가리지 않고 큐에 넣는다 — 한 호출. origin 은 발신자 표식 (메시지로 들어온 턴은 'mail') */
  'session.send': { params: { id: string; text: string; origin?: string; attachments?: Attachment[] }; result: { ok: true; state: SessionState } };
  /** 벤더가 고를 수 있는 모델 목록과 지금 모델·effort */
  'session.models': { params: { id: string }; result: { current: string | null; effort: string | null; models: { value: string; resolvedModel?: string; displayName: string; description: string; efforts?: string[] }[] } };
  /** 다음 턴부터 쓸 모델 — meta 에 남아 --resume 뒤에도 유지 */
  'session.setModel': { params: { id: string; model: string }; result: { ok: true } };
  /** 다음 턴부터 쓸 effort (low·medium·high·xhigh·max, 모델마다 efforts 로 가능한 값) — 세션 한정 설정층(SDK applyFlagSettings)이라 설정 파일엔 안 남고 meta 에 남아 --resume 뒤에도 유지 */
  'session.setEffort': { params: { id: string; effort: string }; result: { ok: true } };
  'session.interrupt': { params: { id: string }; result: { ok: true } };
  /** 권한 모드 전환 — 즉시 적용, meta 에 남아 --resume 뒤에도 유지. 현재 값은 SessionInfo.permissionMode (session.changed 로 갱신) */
  'session.setMode': { params: { id: string; mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto' }; result: { ok: true } };
  /** 벤더 슬래시 명령 목록 — 입력창 `/` 자동완성. session.ready 전에도 답한다 */
  'session.commands': { params: { id: string }; result: { name: string; description: string; argumentHint: string }[] };
  /** 사이드바 상단(claude 상태줄과 같은 정보) — cwd 의 git repo 이름·브랜치, 벤더 플랜 리밋 창(5시간·7일, 0-100 %), 컨텍스트 창 사용량. 플랜이 없거나 벤더가 답을 못 주면 그 항목은 null. 폴링 없이 attach·turn.end 때 한 번씩 (사용자 2026-09-29) */
  'session.status': { params: { id: string }; result: { repo: string | null; branch: string | null; limits: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } | null; context: { tokens: number; max: number; pct: number } | null } };
  /** MCP 서버 상태 — 벤더가 지금 아는 값. session.ready 의 mcp 는 기동 때 것이고 실패 사유가 없다. 벤더가 안 떠 있거나 Codex 면 [] */
  'session.mcp': { params: { id: string }; result: McpStatus[] };
  /** MCP 서버 하나를 다시 연결한 뒤의 상태 목록 — 다시 실패해도 오류가 아니라 목록의 error 로 온다 */
  'session.mcpReconnect': { params: { id: string; name: string }; result: McpStatus[] };
  /** 턴 되돌리기 (claude 의 Esc-Esc). seq 는 버릴 첫 턴의 turn.start seq. conversation 은 벤더 세션을 그 앞 지점에서 다시 열고, files 는 벤더 체크포인트로 파일을 되돌린다. idle 일 때만 */
  'session.rewind': { params: { id: string; seq: number; conversation: boolean; files: boolean }; result: { ok: true; filesChanged: string[] | null } };
  /** remember 는 벤더 제안 규칙을 세션 한정으로 기억 (영구 설정 파일에 쓰지 않는다). AskUserQuestion 은 updatedInput.answers */
  'session.approve': { params: { id: string; requestId: string; decision: ApprovalDecision; remember?: boolean; updatedInput?: Record<string, unknown>; message?: string }; result: { ok: boolean } };
  /** 대기 승인 cancel 뒤 벤더 프로세스 종료 — 프로세스도 내려간다 (Ctrl-C 와 같다). 로그는 남는다 */
  'session.close': { params: { id: string }; result: { ok: true } };
  'session.rename': { params: { id: string; title: string | null }; result: { ok: true } };
  /** 웹 입력창 초안을 맡긴다 — 프로세스 메모리에 하나(마지막 쓴 것), 디스크·방송 없음. 카드 iframe 이 다시 로드돼도 쓰던 글이 남게
   *  (ticket slcode-card-periodic-reload, 사용자 결정 2026-10-10) */
  'session.setDraft': { params: { id: string; text: string }; result: { ok: true } };
  // ---- inspect (ticket slcode-inspect-proxy, 사용자 결정 2026-10-17) — Claude 벤더만
  /** 벤더의 API 호출 원본 기록을 켜고 끈다 — idle 일 때만, 벤더 프로세스를 같은 대화로 다시 띄운다. meta 에 남아 resume 뒤에도 유지.
   *  내부 플래그가 듣지 않는다고 기록된 SDK 버전(FILES.inspectBlocked)이면 켜기는 bad_request */
  'session.setInspect': { params: { id: string; on: boolean }; result: { ok: true } };
  /** seq end 의 turn.end 에 귀속되는 호출 요약 (앞 turn.end 뒤부터 이 turn.end 까지 시작한 것) */
  'session.inspectTurn': { params: { id: string; end: number }; result: { calls: InspectCall[] } };
  /** 호출 하나의 원본 — 상한으로 지웠으면 bad_request */
  'session.inspectCall': { params: { id: string; n: number }; result: InspectRecord };
  // ---- 메시징 (ticket superlite-agent-messaging 2026-10-02 → slcode-p2p-messaging 2026-10-19). 세션 안의 `slcode check/ask/reply` 가 자기 세션 소켓으로 부른다
  /** 이 세션 앞으로 한 통 — 다음 idle 에 턴으로 (메모리, 보관함 없음). 같은 id 를 다시 보내도 한 통. id·ts 는 mail.sendMail 이 정한다 */
  'session.deliver': { params: { id: string; mail: Omit<Mail, 'id' | 'ts'> & { id?: string; ts?: number } }; result: { mailId: string } };
  /** 밀린 메시지를 지금 꺼낸다 — 진행 중 턴 안에서 읽는 용도. 꺼낸 메시지는 턴으로 다시 오지 않는다. text 는 mail.ts formatMail 꼴 */
  'session.check': { params: { id: string }; result: { count: number; text: string } };
  /** kind=ask 메시지를 켜진 세션에 보내고 (아니면 no_session) kind=reply re=<그 id> 가 올 때까지 이 요청을 연다 — 기본 무기한, timeoutMs 로만 제한(ERR.timeout). 답장은 턴이 아니라 이 응답으로 온다 */
  'session.ask': { params: { id: string; to: string; text: string; timeoutMs?: number }; result: { mailId: string; reply: Mail; text: string } };
  /** 받은 메시지 id 로 그 보낸 이에게 kind=reply. 모르는 id(이 세션이 받은 적 없음)면 bad_request, 보낸 이가 켜진 세션이 아니면 no_session */
  'session.reply': { params: { id: string; re: string; text: string }; result: { id: string; to: string } };
};

export type MethodName = keyof Methods;

/** 화면 설정 (ticket slcode-web-settings) — serve 가 화면 연결(웹·stdio)에서 직접 답한다. core 로 넘기지 않아 세션 소켓에 바로 붙은 연결엔 없다.
 *  어느 묶음인지는 연결이 들어온 입구(SettingsKind)가 정한다 — 요청에 싣지 않는다 */
export type ServeMethods = {
  'settings.get': { params: Record<string, never>; result: Settings };
  /** 지금 설정에 겹쳐 쓴다 (context 는 항목별로). 결과는 겹친 뒤의 전체 — 같은 입구의 화면 모두에 settings.changed 도 간다 */
  'settings.set': { params: { settings: SettingsPatch }; result: Settings };
  /** 화면이 붙은 serve 의 버전·빌드(VERSION·BUILD)와 pid. update 는 update.run 이 찾은 새 버전(없으면 null) — 화면을 다시 열어도 restart required 가 남는다.
   *  화면은 연결할 때마다 묻고 자기 페이지의 data-version·data-build 와 다르면 다시 로드한다 (serve 가 바뀌었다).
   *  inspectBlocked 는 inspect 의 내부 플래그가 듣지 않는다고 기록된 SDK 버전 (없으면 null) — 설정 창이 새 세션 inspect 를 막고 사유를 보인다 */
  'serve.info': { params: Record<string, never>; result: { version: string; build: number; pid: number; update: UpdateCheck | null; inspectBlocked?: string | null } };
  /** [업데이트] — 웹(TCP) 입구만. 설치 폴더의 package.json version·dist/cli.js mtime 을 이 serve 가 뜰 때의 것과 견준다.
   *  카드는 serve 가 아니라 플러그인이 확인한다 (원격 deploy 경로는 내용 해시라 serve 가 자기 폴더를 봐서는 모른다) */
  'update.run': { params: Record<string, never>; result: UpdateCheck };
  /** [restart required] — 웹 모드 진입 프로세스가 같은 포트로 새 serve 를 띄우고 이 serve 를 내린다. 새 serve 가 준비된 뒤 답한다(못 뜨면 그 사유로 오류) */
  'serve.restart': { params: Record<string, never>; result: { ok: true } };
};

/** 새 버전 확인 결과 — restart-required 면 새 것의 version·build, failed 면 reason */
export type UpdateCheck = { status: 'latest' | 'restart-required' | 'failed'; version?: string; build?: number; reason?: string };

/** 세션 소켓·웹의 이벤트 — 붙은 세션의 이벤트와 세션 상태 */
export type Broadcasts = {
  'session.event': { id: string } & LoggedEvent;
  'session.changed': SessionInfo;
  'session.closed': { id: string; reason: string };
  /** 소유권을 빼앗긴 연결에만 — 새 소유자의 pid (protocol 3) */
  'core.owner': { pid: number | null };
  /** 설정 파일이 바뀌었다 (어느 serve 가 썼든, 손으로 고쳤든) — 각 serve 가 파일을 감시해 그 입구로 들어온 자기 화면 연결에만 보낸다 */
  'settings.changed': Settings;
};

export type EventName = keyof Broadcasts;

/** 봉투 — body 는 문자열 또는 JSON. kind 는 message·ask·reply. via 는 실제로 넘긴 쪽 (보내는 CLI 가 자동으로: from 과 다른 세션 id 또는 outside) */
export type Mail = { id: string; from: string; to: string; ts: number; kind: string; body: unknown; /** 답장이 가리키는 원 메시지 id (kind=reply) */ re?: string; via?: string };

export type RequestFrame = { id: number | string; method: string; params?: unknown };
export type ResponseFrame = { id: number | string; result?: unknown; error?: { code?: string; message: string } };
export type EventFrame = { event: string; params: unknown };
export type Frame = RequestFrame | ResponseFrame | EventFrame;

export const ERR = {
  unauthorized: 'unauthorized',
  noSession: 'no_session',
  notLive: 'not_live',
  badRequest: 'bad_request',
  owned: 'owned',
} as const;

export class CoreError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function isRequest(f: Frame): f is RequestFrame { return 'method' in f && typeof (f as RequestFrame).method === 'string'; }
export function isEvent(f: Frame): f is EventFrame { return 'event' in f && typeof (f as EventFrame).event === 'string'; }
