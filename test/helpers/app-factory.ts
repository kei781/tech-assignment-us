/**
 * 테스트용 애플리케이션 조립. [TST-002]
 *
 * 프로덕션과 같은 AppModule을 쓰고 설정·시계·처리 로직만 교체한다.
 * 부트스트랩 경로를 테스트가 따로 재현하지 않으므로, 실제 실행과 어긋날 여지가 없다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { CLOCK, Clock } from '../../src/common/clock';
import { APP_CONFIG, AppConfig } from '../../src/common/config';
import { APP_LOGGER, AppLogger } from '../../src/common/logging/app-logger';
import { JOB_TASK, JobTask } from '../../src/jobs/job-task';
import { JobsProcessor } from '../../src/jobs/jobs.processor';
import { JobsService } from '../../src/jobs/jobs.service';
import { JobsStore } from '../../src/jobs/jobs.store';
import { Job } from '../../src/jobs/jobs.types';

export interface TestApp {
  app: INestApplication;
  store: JobsStore;
  service: JobsService;
  processor: JobsProcessor;
  logger: AppLogger;
}

export interface CreateTestAppOptions {
  config: AppConfig;
  clock?: Clock;
  /** [SCH-004] 처리 로직 교체 — 지연·예외·수동 제어를 테스트가 결정한다. */
  task?: JobTask;
  /** true면 app.init()을 호출하지 않는다 (기동 실패를 검증할 때 사용) */
  skipInit?: boolean;
}

const noopTask: JobTask = { async run(): Promise<void> {} };

export async function createTestApp(options: CreateTestAppOptions): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(options.config)
    .overrideProvider(JOB_TASK)
    .useValue(options.task ?? noopTask)
    .overrideProvider(CLOCK)
    .useValue(options.clock ?? { now: () => new Date() })
    .compile();

  const app = moduleRef.createNestApplication();

  if (!options.skipInit) {
    await app.init();
  }

  return {
    app,
    store: app.get(JobsStore),
    service: app.get(JobsService),
    processor: app.get(JobsProcessor),
    logger: app.get<AppLogger>(APP_LOGGER),
  };
}

/** 호출 횟수를 세고, 원할 때 완료시킬 수 있는 JobTask */
export class ControllableTask implements JobTask {
  readonly started: Job[] = [];
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private failure: Error | null = null;

  /** run()이 이 게이트가 열릴 때까지 대기하게 만든다 */
  block(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  unblock(): void {
    this.release?.();
    this.gate = null;
    this.release = null;
  }

  /** run()이 예외를 던지게 만든다 ([SCH-005]) */
  failWith(error: Error): void {
    this.failure = error;
  }

  /** 실패 설정을 해제한다 */
  clearFailure(): void {
    this.failure = null;
  }

  async run(job: Job): Promise<void> {
    this.started.push(job);
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
  }
}
