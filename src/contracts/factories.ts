/**
 * 조립 팩토리 계약. 테스트는 이 팩토리를 통해서만 시스템을 생성한다.
 *
 * TDD red 단계(pr-2): 전부 NotImplementedError를 던진다.
 * pr-3(스케폴드)에서 NestJS 모듈 구조가 잡히고, pr-4(구현)에서 전부 동작한다.
 */
import { INestApplication } from '@nestjs/common';
import { AppConfig } from './config';
import { NotImplementedError } from './errors';
import { AppLogger, Clock, JobLockService, JobsStore, WorkerRuntime } from './interfaces';
import { LockOwnerType } from './types';

export interface StoreFactoryOptions {
  config: AppConfig;
  /** 64-hex process id. 생략 시 내부 생성. */
  processId?: string;
  ownerType: LockOwnerType;
  clock?: Clock;
  logger?: AppLogger;
}

export interface ApiAppFactoryOptions {
  config: AppConfig;
  clock?: Clock;
}

export interface WorkerFactoryOptions {
  config: AppConfig;
  clock?: Clock;
  /** 64-hex worker id. 생략 시 내부 생성. */
  workerId?: string;
  /**
   * [WRK-023] 처리 로직 주입. 생략 시 config.jobProcessingMs 동안 대기.
   * 테스트는 즉시 resolve/reject 하는 함수를 주입해 실제 대기를 피한다. [TST-002]
   */
  processJob?: (jobId: string) => Promise<void>;
  logger?: AppLogger;
}

export interface LoggerFactoryOptions {
  config: AppConfig;
  clock?: Clock;
}

/** [RUN-004] 초기화를 포함한 jobs.json 저장소 생성 */
export function createJobsStore(_opts: StoreFactoryOptions): JobsStore {
  throw new NotImplementedError('createJobsStore');
}

/** per-job lock 서비스 생성 */
export function createJobLock(_opts: { config: AppConfig; clock?: Clock; logger?: AppLogger }): JobLockService {
  throw new NotImplementedError('createJobLock');
}

/** [LOG-001] logs.txt append 로거 생성 */
export function createFileLogger(_opts: LoggerFactoryOptions): AppLogger {
  throw new NotImplementedError('createFileLogger');
}

/**
 * Queue API 애플리케이션 생성 (listen 전 상태).
 * supertest는 app.getHttpServer()로 요청한다.
 */
export function createApiApp(_opts: ApiAppFactoryOptions): Promise<INestApplication> {
  throw new NotImplementedError('createApiApp');
}

/**
 * Worker 런타임 생성. 스케줄러 자동 시작 없이 각 서비스의 *Once 메서드를
 * 테스트가 직접 호출할 수 있어야 한다. [TST-002]
 * 생성 시 [WRK-001]의 등록(register)까지 수행한다.
 */
export function createWorkerRuntime(_opts: WorkerFactoryOptions): Promise<WorkerRuntime> {
  throw new NotImplementedError('createWorkerRuntime');
}
