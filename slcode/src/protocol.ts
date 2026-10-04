// slcode 프로토콜 — 유일한 계약 표면. 프런트(웹 모드·카드 모드)·CLI·우체국이 전부 이 타입만 본다.
// 프레이밍은 superlite 와이어 꼴 (사용자 결정 2026-09-26): JSON 한 줄이 프레임이고
//   요청   {id, method, params}
//   응답   {id, result} | {id, error: {code?, message}}
//   이벤트 {event, params}
// 구조 (사용자 결정 2026-09-27, ticket agent-core-split): 세션 하나 = `slcode` 프로세스 하나가 자기 안에서 쥔다.
//   세션 소켓 sessions/<cwd 슬러그>/<id>/sock (Methods 의 session.*) — 웹 서버는 같은 메서드를 WebSocket 으로 낸다.
//   우체국 post.sock 은 머신에 하나 — 세션 등록(연결 유지 = 살아 있음)·우편 보관·시그널만. 본문은 세션이 mail.fetch 로 가져간다 (폴링 없음).
//   버전 공존: 옛 세션 프로세스와 새 세션 프로세스가 같이 뜬다. 우체국과의 계약(PostMethods·시그널)은 최소로 고정한다.
// 이벤트 어휘는 벤더 중립 15종. 각 이벤트는 선택 필드 raw 에 벤더 원문(SDK 메시지)을 같은 봉투로 싣는다 (raw:true 일 때만).

export const PROTOCOL_VERSION = 2;

/** 파일 위치 — $SLCODE_DIR, 없으면 ~/.local/state/slcode */
export const FILES = {
  postSock: 'post.sock',
  postLock: 'post.lock',
  postPid: 'post.pid',
  postLog: 'post.log',
  token: 'slcode.token',
  sessionsDir: 'sessions',
  mailDir: 'mail',
  sessionSock: 'sock',
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
};

/** 턴에 딸린 파일 — 웹 프런트의 붙여넣기·끌어놓기. data 는 base64. 이미지·PDF 는 벤더 블록으로, 텍스트류는 본문에 인라인 */
export type Attachment = { name: string; mediaType: string; data: string };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

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

/** 이벤트 16종 — 벤더 중립. Codex 어댑터도 같은 kind 를 낸다. parent 는 서브에이전트 안에서 난 이벤트의 부모 tool_use id (없으면 본문) */
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
      /** 벤더 쪽 이 턴의 사용자 메시지 uuid(파일 되돌리기 기준)와 마지막 항목 uuid(대화 되돌리기의 유지 지점) */
      userUuid?: string | null; uuid?: string | null }
  /** 되돌리기 — seq(turn.start) 부터의 턴을 버렸다. 화면은 그 seq 이후를 지운다. 로그는 그대로 쌓인다 */
  | { kind: 'turn.rewound'; seq: number; conversation: boolean; files: boolean; filesChanged: string[] | null }
  | { kind: 'context.compacted'; trigger: string; preTokens: number | null }
  | { kind: 'hook'; event: string; phase: 'started' | 'response'; ok: boolean | null }
  | { kind: 'error'; message: string }
  | { kind: 'session.exit'; reason: string };

export type CoreEventKind = CoreEventBody['kind'];

export type CoreEvent = CoreEventBody & { raw?: unknown };

/** 로그에 남고 attach 로 재생되는 단위 — seq 는 세션 안에서 단조 증가 (core 재기동 뒤에도 이어진다) */
export type LoggedEvent = { seq: number; at: number; ev: CoreEvent };

// ---- 요청·응답 (세션 소켓 · 웹 WebSocket)

/** 플랜 리밋 창 하나 — pct 는 쓴 비율(0-100), resetsAt 은 ISO 8601 */
export type LimitWindow = { pct: number | null; resetsAt: string | null };

export type Methods = {
  /** 첫 요청. UDS 는 소켓 권한(0600)이 곧 인증이라 토큰을 보지 않는다. 웹 서버는 루프백 밖 호스트일 때 이 메서드를 자기 토큰으로 검사한다 */
  'core.auth': { params: { token: string }; result: { ok: true; pid: number; protocol: number; session: string } };
  /** 이 프로세스가 쥔 세션과 웹 주소 */
  /** url 은 접속 가능한 웹 주소(토큰 포함, 0.0.0.0 은 IPv4 로 바꾼 것) — superlite 카드가 iframe 에 넣는다. --no-web 이면 null (2026-10-04) */
  'server.info': { params: Record<string, never>; result: { session: string; cwd: string; host: string | null; port: number | null; url: string | null; version: string } };
  /** 이 연결에 세션의 이벤트 스트림을 켠다. since 뒤의 로그를 history 로, 대기 승인을 pending 으로 */
  'session.attach': { params: { id: string; since?: number }; result: { info: SessionInfo; history: LoggedEvent[]; pending: ApprovalRequest[] } };
  'session.detach': { params: { id: string }; result: { ok: true } };
  /** idle·running 가리지 않고 큐에 넣는다 — 한 호출. origin 은 발신자 표식 (우편으로 들어온 턴은 'mail') */
  'session.send': { params: { id: string; text: string; origin?: string; attachments?: Attachment[] }; result: { ok: true; state: SessionState } };
  /** 벤더가 고를 수 있는 모델 목록과 지금 모델·effort */
  'session.models': { params: { id: string }; result: { current: string | null; effort: string | null; models: { value: string; resolvedModel?: string; displayName: string; description: string; efforts?: string[] }[] } };
  /** 다음 턴부터 쓸 모델 — meta 에 남아 --resume 뒤에도 유지 */
  'session.setModel': { params: { id: string; model: string }; result: { ok: true } };
  /** 다음 턴부터 쓸 effort (low·medium·high·xhigh·max, 모델마다 efforts 로 가능한 값) — 세션 한정 설정층(SDK applyFlagSettings)이라 설정 파일엔 안 남고 meta 에 남아 --resume 뒤에도 유지 */
  'session.setEffort': { params: { id: string; effort: string }; result: { ok: true } };
  'session.interrupt': { params: { id: string }; result: { ok: true } };
  /** 권한 모드 전환 — 즉시 적용, meta 에 남아 --resume 뒤에도 유지. 현재 값은 SessionInfo.permissionMode (session.changed 로 갱신) */
  'session.setMode': { params: { id: string; mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' }; result: { ok: true } };
  /** 벤더 슬래시 명령 목록 — 입력창 `/` 자동완성. session.ready 전에도 답한다 */
  'session.commands': { params: { id: string }; result: { name: string; description: string; argumentHint: string }[] };
  /** 사이드바 상단(claude 상태줄과 같은 정보) — cwd 의 git repo 이름·브랜치, 벤더 플랜 리밋 창(5시간·7일, 0-100 %), 컨텍스트 창 사용량. 플랜이 없거나 벤더가 답을 못 주면 그 항목은 null. 폴링 없이 attach·turn.end 때 한 번씩 (사용자 2026-09-29) */
  'session.status': { params: { id: string }; result: { repo: string | null; branch: string | null; limits: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } | null; context: { tokens: number; max: number; pct: number } | null } };
  /** 턴 되돌리기 (claude 의 Esc-Esc). seq 는 버릴 첫 턴의 turn.start seq. conversation 은 벤더 세션을 그 앞 지점에서 다시 열고, files 는 벤더 체크포인트로 파일을 되돌린다. idle 일 때만 */
  'session.rewind': { params: { id: string; seq: number; conversation: boolean; files: boolean }; result: { ok: true; filesChanged: string[] | null } };
  /** remember 는 벤더 제안 규칙을 세션 한정으로 기억 (영구 설정 파일에 쓰지 않는다). AskUserQuestion 은 updatedInput.answers */
  'session.approve': { params: { id: string; requestId: string; decision: ApprovalDecision; remember?: boolean; updatedInput?: Record<string, unknown>; message?: string }; result: { ok: boolean } };
  /** 대기 승인 cancel 뒤 벤더 프로세스 종료 — 프로세스도 내려간다 (Ctrl-C 와 같다). 로그는 남는다 */
  'session.close': { params: { id: string }; result: { ok: true } };
  'session.rename': { params: { id: string; title: string | null }; result: { ok: true } };
  // ---- 메시징 (ticket superlite-agent-messaging, 사용자 확정 2026-10-02: 스탠드얼론, superlite 등록부 매핑 없음). 세션 안의 `slcode check/ask/reply` 가 자기 세션 소켓으로 부른다
  /** 밀린 우편을 지금 꺼낸다 (우체국에서 가져온 뒤 inbox 전부 ack) — 진행 중 턴 안에서 읽는 용도. 꺼낸 우편은 턴으로 다시 오지 않는다. text 는 mail.ts formatMail 꼴 */
  'session.check': { params: { id: string }; result: { count: number; text: string } };
  /** kind=ask 우편을 보내고 kind=reply re=<그 id> 가 올 때까지 이 요청을 연다 — 기본 무기한, timeoutMs 로만 제한(ERR.timeout). 답장은 턴이 아니라 이 응답으로 온다 */
  'session.ask': { params: { id: string; to: string; text: string; timeoutMs?: number }; result: { mailId: string; reply: Mail; text: string } };
  /** 받은 우편 id 로 그 보낸 이에게 kind=reply. 모르는 id(이 세션이 받은 적 없음)면 bad_request */
  'session.reply': { params: { id: string; re: string; text: string }; result: { id: string; to: string; delivered: boolean } };
};

export type MethodName = keyof Methods;

/** 세션 소켓·웹의 이벤트 — 붙은 세션의 이벤트와 세션 상태 */
export type Broadcasts = {
  'session.event': { id: string } & LoggedEvent;
  'session.changed': SessionInfo;
  'session.closed': { id: string; reason: string };
};

export type EventName = keyof Broadcasts;

// ---- 우체국 (post.sock) — 세션 프로세스·CLI 가 붙는다. 이 계약은 버전이 달라도 깨지지 않게 최소로 고정한다

/** 우체국에 등록된 살아 있는 세션 한 장 */
export type PostEntry = { id: string; cwd: string; pid: number; sock: string; version: string; title: string | null; since: number };

/** 봉투 — body 는 문자열 또는 JSON. kind 로 메시지·게시판·알림을 구분 (사용자 결정 2026-09-27) */
export type Mail = { id: string; from: string; to: string; ts: number; kind: string; body: unknown; /** 답장이 가리키는 원 우편 id (kind=reply) */ re?: string };

export type PostMethods = {
  /** 세션 프로세스가 붙자마자. 이 연결이 살아 있는 동안 등록 — 끊기면 목록에서 빠진다 */
  'post.register': { params: Omit<PostEntry, 'since'>; result: { ok: true; unread: number } };
  'post.list': { params: Record<string, never>; result: PostEntry[] };
  'post.info': { params: Record<string, never>; result: { pid: number; startedAt: number; dir: string; protocol: number; sessions: number } };
  'post.shutdown': { params: Record<string, never>; result: { ok: true } };
  /** 디스크에 쓰고, 받는 세션이 살아 있으면 시그널만 보낸다. 없으면 보관 */
  'mail.send': { params: { from: string; to: string; kind?: string; body: unknown; re?: string }; result: { id: string; delivered: boolean } };
  /** 안 읽은 우편 전부 (ts 순). schema 는 세션이 아는 봉투 버전 — 지금은 1 */
  'mail.fetch': { params: { to: string; schema?: number }; result: Mail[] };
  'mail.ack': { params: { to: string; ids: string[] }; result: { ok: true } };
};

/** 우체국 시그널 — 내용 없이 고정. 세션은 이걸 받으면 mail.fetch 한다 */
export type PostBroadcasts = {
  mail: { to: string };
  'post.shutdown': { reason: string };
};

export type RequestFrame = { id: number | string; method: string; params?: unknown };
export type ResponseFrame = { id: number | string; result?: unknown; error?: { code?: string; message: string } };
export type EventFrame = { event: string; params: unknown };
export type Frame = RequestFrame | ResponseFrame | EventFrame;

export const ERR = {
  unauthorized: 'unauthorized',
  noSession: 'no_session',
  notLive: 'not_live',
  badRequest: 'bad_request',
} as const;

export class CoreError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function isRequest(f: Frame): f is RequestFrame { return 'method' in f && typeof (f as RequestFrame).method === 'string'; }
export function isEvent(f: Frame): f is EventFrame { return 'event' in f && typeof (f as EventFrame).event === 'string'; }
