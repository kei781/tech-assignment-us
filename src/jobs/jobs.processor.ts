/**
 * 백그라운드 처리 스케줄러. SPEC §5 [SCH-001] ~ [SCH-005], [CON-007]
 *
 * tick은 항상 done 커밋 또는 create 롤백으로 끝난다. 따라서 정상 종료가
 * drain을 마치면 이 프로세스가 남긴 pending은 없고, 강제 종료된 경우는
 * 다음 기동의 [CON-006]이 복구한다.
 */
import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { APP_CONFIG, AppConfig } from '../common/config';
import { APP_LOGGER, AppLogger } from '../common/logger';
import { JobsService } from './jobs.service';
import { Job } from './jobs.types';

const INTERVAL_NAME = 'jobs-consume';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 실제 처리 로직. SPEC [SCH-004]
 *
 * 과제는 비즈니스 작업을 정의하지 않는다. 기본 구현은 `JOB_PROCESSING_MS` 동안
 * 처리한 것으로 간주하며, 테스트는 이 토큰을 교체해 실제 대기 없이 검증한다([TST-002]).
 */
export interface JobTask {
  run(job: Job): Promise<void>;
}

export const JOB_TASK = Symbol('JOB_TASK');

@Injectable()
export class DelayJobTask implements JobTask {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async run(_job: Job): Promise<void> {
    const ms = this.config.jobProcessingMs;
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

@Injectable()
export class JobsProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  /** [SCH-002] 이전 tick이 끝나지 않았으면 이번 tick은 건너뛴다. */
  private isProcessing = false;

  /** [CON-007] ① 새 tick 차단 */
  private stopped = false;

  /** [CON-007] ② drain 대상 — 진행 중인 tick */
  private inFlight: Promise<void> | null = null;

  private intervalRegistered = false;

  constructor(
    private readonly jobs: JobsService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(JOB_TASK) private readonly task: JobTask,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.schedulerEnabled) {
      this.logger.log('INFO', 'scheduler', 'SCHEDULER_ENABLED=false — 스케줄러를 시작하지 않습니다.');
      return;
    }

    const interval = setInterval(() => {
      void this.tickOnce().catch(() => undefined);
    }, this.config.consumeIntervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.intervalRegistered = true;

    this.logger.log(
      'INFO',
      'scheduler',
      `스케줄러 시작: 주기 ${this.config.consumeIntervalMs}ms, 처리 시간 ${this.config.jobProcessingMs}ms`,
    );

    // [SCH-001] 기동 직후 1회 즉시 실행 — 확인을 위해 첫 주기를 기다리지 않는다.
    void this.tickOnce();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * tick 1회. 테스트는 이 메서드를 직접 호출해 실제 주기를 기다리지 않는다([TST-002]).
   * 한 tick은 Job 1개를 처리한다([SCH-002]).
   */
  async tickOnce(): Promise<void> {
    if (this.stopped) return;
    // [SCH-002] guard
    if (this.isProcessing) return;

    this.isProcessing = true;

    /**
     * tick은 **어떤 이유로도 호출자에게 reject를 전파하지 않는다.**
     * 자동 호출부(interval callback, 기동 즉시 tick)는 catch handler를 둘 수 없는
     * fire-and-forget 경로이므로, reject가 새어나가면 처리되지 않은 rejection이 되어
     * Node 기본 동작에서 프로세스가 죽는다 — 일시적 저장 실패 하나가 스케줄러 전체를
     * 멈추고 오류 로그도 남기지 않는다.
     */
    const run = this.runTick().catch((error: unknown) => {
      this.logger.log('ERROR', 'scheduler', `tick 실패: ${describeError(error)}`);
    });
    this.inFlight = run;

    try {
      await run;
    } finally {
      // [SCH-005] 성공·실패·예외 어느 경로에서도 반드시 해제한다.
      this.isProcessing = false;
      this.inFlight = null;
    }
  }

  /** [CON-007] 정상 종료: 새 tick을 막고 진행 중인 tick을 최대 SHUTDOWN_DRAIN_MS까지 기다린다. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.intervalRegistered) {
      try {
        this.scheduler.deleteInterval(INTERVAL_NAME);
      } catch {
        // 이미 제거됨
      }
      this.intervalRegistered = false;
    }

    const pending = this.inFlight;
    if (!pending) {
      this.logger.log('INFO', 'scheduler', '스케줄러 종료 — 진행 중인 tick 없음');
      // Nest는 shutdown hook 직후 프로세스를 재종료하므로, 예약된 append가
      // 끝나기를 여기서 기다려야 종료 로그가 유실되지 않는다.
      await this.logger.flush();
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.config.shutdownDrainMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    this.logger.log(
      drained ? 'INFO' : 'WARN',
      'scheduler',
      drained
        ? '종료 drain 완료 — 남은 pending 없음'
        : `종료 drain 시간 초과(${this.config.shutdownDrainMs}ms) — 다음 기동의 [CON-006]이 복구합니다.`,
    );

    await this.logger.flush();
  }

  private async runTick(): Promise<void> {
    // [SCH-003] 선점. 선점 커밋도 디스크 쓰기이므로 실패할 수 있다 —
    // 처리 단계와 마찬가지로 오류 경계 안에 둔다.
    let job: Job | null;
    try {
      job = await this.jobs.claimNext();
    } catch (error) {
      this.logger.log('ERROR', 'scheduler', `선점 실패: ${describeError(error)}`);
      return;
    }

    if (!job) {
      // [LOG-004] 대상 없음
      this.logger.log('INFO', 'scheduler', 'tick: 처리할 create 상태 Job이 없습니다.');
      return;
    }

    this.logger.log('INFO', 'scheduler', `선점: job=${job.id} create → pending`);

    try {
      await this.task.run(job);

      // [SCH-004] 완료 — 여전히 pending인지 확인한 뒤에만 done으로 커밋한다.
      const done = await this.jobs.markDone(job.id);
      if (done) {
        this.logger.log('INFO', 'scheduler', `완료: job=${job.id} pending → done`);
      } else {
        this.logger.log(
          'WARN',
          'scheduler',
          `완료 생략: job=${job.id}이(가) 더 이상 pending이 아니어서 done으로 덮어쓰지 않았습니다.`,
        );
      }
    } catch (error) {
      // [SCH-005] 예외 → 롤백. 프로세스를 중단시키지 않는다.
      const reason = describeError(error);
      const rolledBack = await this.jobs.rollbackToCreate(job.id).catch(() => false);
      this.logger.log(
        'ERROR',
        'scheduler',
        `실패: job=${job.id} (${reason}) → ${rolledBack ? 'create 롤백' : '롤백 대상 아님'}`,
      );
    }
  }
}
