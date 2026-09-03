/**
 * 서비스 계약. 테스트는 이 인터페이스와 factories.ts의 팩토리만 참조한다.
 * 구현(pr-4)은 NestJS DI로 이 계약을 충족한다.
 */
import { JobLockMetadata, JobsFile } from './types';

/**
 * [TST-002] 주입 가능한 시계.
 * 구현은 모든 시간 판정(타임스탬프 비교는 물론, 파일 mtime 나이 계산 포함)에
 * 반드시 이 Clock을 기준으로 사용해야 한다.
 */
export interface Clock {
  now(): Date;
}

/** [LOG-002] scope 집합 */
export type LogScope = 'http' | 'worker' | 'reaper' | 'storage';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/**
 * [LOG-001] ~ [LOG-005]
 * 구현은 호출마다 단일 append 연산으로 기록하며, 파일 핸들을 유지하지 않는다
 * (프로세스 간 append 안전성 + 테스트 정리 시 열린 핸들 제거).
 */
export interface AppLogger {
  log(level: LogLevel, scope: LogScope, message: string): void;
}

/** [LOCK-005] 임계 구역 내에서 전달되는 트랜잭션 핸들 */
export interface JobsTx {
  /** global lock 획득 후 디스크에서 reload된 최신 데이터 */
  data: JobsFile;
  /** 원자적 저장(임시 파일 + rename). 호출하지 않으면 변경은 버려진다. */
  save(): Promise<void>;
}

/**
 * jobs.json 저장소. [LOCK-005], [LOCK-006], [RUN-004]
 */
export interface JobsStore {
  /** [RUN-004] 부트스트랩 초기화 (디렉터리/genesis/키 보정) */
  init(): Promise<void>;
  /**
   * global lock 임계 구역 실행: 획득 → reload → fn → 해제.
   * fn 안에서 tx.save()를 호출해야 변경이 저장된다.
   * API ownerType에서 대기 초과 시 GlobalLockWaitTimeoutError를 던진다. [LOCK-008]
   */
  withGlobalLock<T>(fn: (tx: JobsTx) => Promise<T>): Promise<T>;
  /** [LOCK-006] 일관 snapshot 읽기 (global lock 경유) */
  snapshot(): Promise<JobsFile>;
}

/** per-job lock. [LOCK-001], [LOCK-003], [LOCK-004] */
export interface JobLockService {
  /** 원자적 생성 시도. 성공 시 true, EEXIST면 false. */
  tryAcquire(jobId: string, workerId: string): Promise<boolean>;
  /** [LOCK-004] 소유 검증 후 해제. 소유자가 아니면 삭제하지 않고 false 반환. */
  release(jobId: string, workerId: string): Promise<boolean>;
  exists(jobId: string): Promise<boolean>;
  read(jobId: string): Promise<JobLockMetadata | null>;
}

/** Worker consume. [WRK-003], [WRK-020] ~ [WRK-025] */
export interface ConsumeService {
  /** 한 tick 분량의 consume 실행. [WRK-003] 재진입 시 즉시 반환. */
  consumeOnce(): Promise<void>;
  readonly isConsuming: boolean;
}

/** Heartbeat. [WRK-001], [WRK-010] */
export interface HeartbeatService {
  /** 시작 시 workers 레지스트리 등록 */
  register(): Promise<void>;
  /** heartbeatAt 갱신 1회 */
  beatOnce(): Promise<void>;
  /** 정상 종료 시 등록 해제 */
  unregister(): Promise<void>;
}

/** Reaper. [RPR-001] ~ [RPR-013] */
export interface ReaperService {
  /** Reaper 생존 확인 및 필요 시 선출 시도 1회. [RPR-001], [RPR-002] */
  checkOnce(): Promise<void>;
  /** 자신이 Reaper인 경우 cleanup 1회. [RPR-010] ~ [RPR-013] */
  cleanupOnce(): Promise<void>;
  readonly isReaper: boolean;
}

/** Worker 프로세스 1개에 해당하는 런타임 묶음 */
export interface WorkerRuntime {
  readonly workerId: string;
  readonly consume: ConsumeService;
  readonly heartbeat: HeartbeatService;
  readonly reaper: ReaperService;
  /** [WRK-004] 정상 종료 절차 전체 수행 */
  shutdown(): Promise<void>;
}
