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

const CONSUME_INTERVAL_NAME = 'jobs-consume';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface JobTask {
  run(job: Job): Promise<void>;
}

export const JOB_TASK = Symbol('JOB_TASK');

/**
 * 과제는 실제 비즈니스 작업을 정의하지 않는다. 정해진 시간 동안 처리한 것으로
 * 간주하며, 테스트는 이 토큰을 교체해 실제 대기 없이 검증한다.
 */
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
  private isProcessing = false;

  private isShuttingDown = false;

  private runningTick: Promise<void> | null = null;

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
      this.logger.log(
        'INFO',
        'scheduler',
        'SCHEDULER_ENABLED=false — 스케줄러를 시작하지 않습니다.',
      );
      return;
    }

    const interval = setInterval(() => {
      void this.tickOnce().catch(() => undefined);
    }, this.config.consumeIntervalMs);
    this.scheduler.addInterval(CONSUME_INTERVAL_NAME, interval);
    this.intervalRegistered = true;

    this.logger.log(
      'INFO',
      'scheduler',
      `스케줄러 시작: 주기 ${this.config.consumeIntervalMs}ms, 처리 시간 ${this.config.jobProcessingMs}ms`,
    );

    // 동작 확인을 위해 첫 주기를 기다리지 않는다.
    void this.tickOnce().catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** 한 tick에 Job 하나 — 과제가 허용한 처리 단위 가정이다. */
  async tickOnce(): Promise<void> {
    if (this.isShuttingDown) return;
    if (this.isProcessing) return;

    this.isProcessing = true;

    /**
     * tick은 어떤 이유로도 호출자에게 reject를 전파하지 않는다. 자동 호출부는
     * catch handler를 둘 수 없는 fire-and-forget 경로여서, reject가 새어나가면
     * 처리되지 않은 rejection이 되어 프로세스가 죽는다 — 일시적 저장 실패 하나가
     * 스케줄러 전체를 멈추고 오류 로그도 남기지 않는다.
     */
    const tick = this.runTick().catch((error: unknown) => {
      this.logger.log('ERROR', 'scheduler', `tick 실패: ${describeError(error)}`);
    });
    this.runningTick = tick;

    try {
      await tick;
    } finally {
      this.isProcessing = false;
      this.runningTick = null;
    }
  }

  /**
   * tick은 항상 done 커밋 또는 create 롤백으로 끝나므로, drain이 완료되면
   * 이 프로세스가 남긴 pending은 없다. 시간 내 못 끝내거나 강제 종료되면
   * 다음 기동의 기동 복구가 처리한다.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.intervalRegistered) {
      try {
        this.scheduler.deleteInterval(CONSUME_INTERVAL_NAME);
      } catch {
        // 이미 제거됨
      }
      this.intervalRegistered = false;
    }

    const tick = this.runningTick;
    if (!tick) {
      this.logger.log('INFO', 'scheduler', '스케줄러 종료 — 진행 중인 tick 없음');
      await this.logger.flush();
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      tick.then(
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
        : `종료 drain 시간 초과(${this.config.shutdownDrainMs}ms) — 다음 기동에서 복구합니다.`,
    );

    // Nest는 shutdown hook 직후 프로세스를 재종료하므로, 예약된 append가
    // 끝나기를 여기서 기다려야 종료 로그가 유실되지 않는다.
    await this.logger.flush();
  }

  private async runTick(): Promise<void> {
    // 선점 커밋도 디스크 쓰기이므로 처리 단계와 같은 오류 경계 안에 둔다.
    let job: Job | null;
    try {
      job = await this.jobs.claimNext();
    } catch (error) {
      this.logger.log('ERROR', 'scheduler', `선점 실패: ${describeError(error)}`);
      return;
    }

    if (!job) {
      this.logger.log('INFO', 'scheduler', 'tick: 처리할 create 상태 Job이 없습니다.');
      return;
    }

    this.logger.log('INFO', 'scheduler', `선점: job=${job.id} create → pending`);

    try {
      // 처리 시간 동안 mutex를 잡고 있으면 그 사이 모든 API 요청이 대기하므로,
      // 선점만 커밋해 두고 여기서는 mutex를 벗어나 처리한다.
      await this.task.run(job);

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
