/**
 * 스케줄러 테스트. SPEC §5 [SCH-001] ~ [SCH-005], [CON-007], [LOG-004]
 *
 * [TST-002] 실제 주기나 처리 시간을 기다리지 않는다.
 * tick은 tickOnce()로 직접 호출하고, 처리 로직은 ControllableTask로 교체한다.
 */
import { INestApplication } from '@nestjs/common';
import { promises as fsPromises } from 'node:fs';
import request from 'supertest';
import { AppConfig } from '../src/common/config';
import { AppLogger } from '../src/common/logger';
import { JobsProcessor } from '../src/jobs/jobs.processor';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsStore } from '../src/jobs/jobs.store';
import { ControllableTask, createTestApp } from './helpers/app-factory';
import {
  makeJob,
  ManualClock,
  mkStorageDir,
  readJobsFile,
  readLogLines,
  rmDir,
  seedJobs,
  testConfig,
  waitFor,
} from './helpers/test-utils';

describe('JobsProcessor', () => {
  let app: INestApplication;
  let processor: JobsProcessor;
  let service: JobsService;
  let store: JobsStore;
  let logger: AppLogger;
  let task: ControllableTask;
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;

  const boot = async (overrides: Partial<AppConfig> = {}): Promise<void> => {
    config = { ...config, ...overrides };
    ({ app, processor, service, store, logger } = await createTestApp({ config, clock, task }));
  };

  const statusOf = (id: string): string | undefined =>
    store.read((file) => file.jobs.find((job) => job.id === id)?.status);

  beforeEach(async () => {
    dir = await mkStorageDir();
    config = testConfig(dir);
    clock = new ManualClock();
    task = new ControllableTask();
  });

  afterEach(async () => {
    task.unblock();
    await app?.close();
    await rmDir(dir);
  });

  describe('[SCH-001] 기동 즉시 1회 실행', () => {
    it('스케줄러가 켜져 있으면 첫 주기를 기다리지 않고 tick을 1회 실행한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);

      // 주기를 아주 길게 두어 "즉시 1회"만 관측한다.
      await boot({ schedulerEnabled: true, consumeIntervalMs: 600_000 });

      await waitFor(() => statusOf(job.id) === 'done');
      expect(task.started.map((j) => j.id)).toEqual([job.id]);
    });

    it('SCHEDULER_ENABLED=false면 tick이 자동 실행되지 않는다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);

      await boot({ schedulerEnabled: false });

      expect(task.started).toHaveLength(0);
      expect(statusOf(job.id)).toBe('create');
    });
  });

  describe('[SCH-002] 재진입 guard', () => {
    it('이전 tick이 끝나지 않았으면 이번 tick은 건너뛴다', async () => {
      await seedJobs(dir, [
        makeJob({ status: 'create', createdAt: '2026-09-01T00:00:00.000Z' }),
        makeJob({ status: 'create', createdAt: '2026-09-01T00:00:01.000Z' }),
      ]);
      await boot();

      task.block();
      const first = processor.tickOnce();
      await waitFor(() => task.started.length === 1);

      // 진행 중인데 다시 호출 — 즉시 반환하고 아무것도 선점하지 않는다.
      await processor.tickOnce();
      expect(task.started).toHaveLength(1);

      task.unblock();
      await first;
    });

    it('한 tick은 Job 1개만 처리한다', async () => {
      const a = makeJob({ status: 'create', createdAt: '2026-09-01T00:00:00.000Z' });
      const b = makeJob({ status: 'create', createdAt: '2026-09-01T00:00:01.000Z' });
      await seedJobs(dir, [a, b]);
      await boot();

      await processor.tickOnce();

      expect(statusOf(a.id)).toBe('done');
      expect(statusOf(b.id)).toBe('create');
    });
  });

  describe('[SCH-003] 선점', () => {
    it('createdAt ASC, 동률 시 id ASC 순서로 선점한다', async () => {
      const late = makeJob({
        id: '00000000-0000-4000-8000-000000000003',
        createdAt: '2026-09-02T00:00:00.000Z',
      });
      const earlyHighId = makeJob({
        id: '00000000-0000-4000-8000-000000000002',
        createdAt: '2026-09-01T00:00:00.000Z',
      });
      const earlyLowId = makeJob({
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: '2026-09-01T00:00:00.000Z',
      });
      await seedJobs(dir, [late, earlyHighId, earlyLowId]);
      await boot();

      await processor.tickOnce();
      await processor.tickOnce();
      await processor.tickOnce();

      expect(task.started.map((j) => j.id)).toEqual([earlyLowId.id, earlyHighId.id, late.id]);
    });

    it('create가 아닌 Job은 선점하지 않는다', async () => {
      const done = makeJob({ status: 'done' });
      await seedJobs(dir, [done]);
      await boot();

      await processor.tickOnce();

      expect(task.started).toHaveLength(0);
      expect(statusOf(done.id)).toBe('done');
    });

    it('선점은 pending으로 커밋되며 처리 중에도 디스크에서 관측된다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      task.block();
      const tick = processor.tickOnce();
      await waitFor(() => task.started.length === 1);

      const file = await readJobsFile(dir);
      expect(file.jobs[0].status).toBe('pending');
      expect(file.jobs[0].updatedAt).toBe(clock.iso());

      task.unblock();
      await tick;
    });

    it('대상이 없으면 tick을 종료한다', async () => {
      await boot();
      await expect(processor.tickOnce()).resolves.toBeUndefined();
      expect(task.started).toHaveLength(0);
    });
  });

  describe('[SCH-004] 완료', () => {
    it('처리 후 done으로 커밋한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      await processor.tickOnce();

      expect(statusOf(job.id)).toBe('done');
      expect((await readJobsFile(dir)).jobs[0].status).toBe('done');
    });

    it('처리 중에 상태가 바뀌었으면 done으로 덮어쓰지 않는다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      task.block();
      const tick = processor.tickOnce();
      await waitFor(() => task.started.length === 1);

      // 다른 주체가 pending을 되돌린 상황을 모사한다.
      await store.mutate((draft) => {
        draft.jobs[0].status = 'create';
      });

      task.unblock();
      await tick;

      expect(statusOf(job.id)).toBe('create');
    });
  });

  describe('[SCH-005] 처리 실패', () => {
    it('예외가 발생하면 create로 롤백한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      task.failWith(new Error('처리 실패'));
      await expect(processor.tickOnce()).resolves.toBeUndefined();

      expect(statusOf(job.id)).toBe('create');
      expect((await readJobsFile(dir)).jobs[0].status).toBe('create');
    });

    it('예외 후에도 guard가 해제되어 다음 tick이 정상 동작한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      task.failWith(new Error('일시적 실패'));
      await processor.tickOnce();

      task.clearFailure();
      await processor.tickOnce();

      expect(statusOf(job.id)).toBe('done');
      expect(task.started).toHaveLength(2);
    });
  });

  describe('[SCH-005] 선점 단계 실패도 오류 경계 안에 있다', () => {
    /**
     * 자동 호출부는 `void this.tickOnce()`이므로 catch handler가 없다.
     * tick이 reject하면 처리되지 않은 rejection이 되어 Node 기본 동작에서
     * 프로세스가 죽는다 — 일시적 저장 실패 하나가 스케줄러 전체를 멈춘다.
     */
    it('claimNext가 실패해도 tickOnce는 reject하지 않고 로깅한다', async () => {
      await seedJobs(dir, [makeJob({ status: 'create' })]);
      await boot();

      jest.spyOn(service, 'claimNext').mockRejectedValueOnce(new Error('저장 실패'));

      await expect(processor.tickOnce()).resolves.toBeUndefined();

      await logger.flush();
      const lines = (await readLogLines(config.logFilePath)).filter((l) => l.includes('[scheduler]'));
      expect(lines.some((l) => l.includes('ERROR') || l.includes('저장 실패'))).toBe(true);
    });

    it('선점 실패 후에도 guard가 해제되어 다음 tick이 정상 동작한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      jest.spyOn(service, 'claimNext').mockRejectedValueOnce(new Error('일시적 저장 실패'));
      await processor.tickOnce();

      jest.restoreAllMocks();
      await processor.tickOnce();

      expect(statusOf(job.id)).toBe('done');
    });

    it('markDone이 실패해도 tickOnce는 reject하지 않는다', async () => {
      await seedJobs(dir, [makeJob({ status: 'create' })]);
      await boot();

      jest.spyOn(service, 'markDone').mockRejectedValueOnce(new Error('완료 저장 실패'));

      await expect(processor.tickOnce()).resolves.toBeUndefined();
    });

    /**
     * F1의 실제 증상은 "tick이 reject한다"가 아니라 "처리되지 않은 rejection이 되어
     * 프로세스가 죽는다"이므로, 그 신호를 직접 관측한다.
     */
    it('기동 즉시 tick의 저장 실패가 처리되지 않은 rejection을 만들지 않는다', async () => {
      await seedJobs(dir, [makeJob({ status: 'create' })]);

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        // 즉시 tick([SCH-001])이 도는 구성에서 선점 커밋이 실패하도록 저장을 막는다.
        const renameSpy = jest
          .spyOn(fsPromises, 'rename')
          .mockRejectedValue(new Error('디스크 오류'));

        await boot({ schedulerEnabled: true, consumeIntervalMs: 600_000 });

        // 즉시 tick이 완료될 시간을 준다 (실패 로그가 남는 것으로 확인).
        await logger.flush();
        await waitFor(async () => {
          await logger.flush();
          const lines = await readLogLines(config.logFilePath);
          return lines.some((l) => l.includes('선점 실패') || l.includes('tick 실패'));
        });

        renameSpy.mockRestore();

        // 프로세스가 살아 있고 다음 tick도 정상 동작한다.
        await expect(processor.tickOnce()).resolves.toBeUndefined();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(unhandled).toEqual([]);
    });
  });

  describe('[CON-007] 정상 종료', () => {
    it('진행 중인 tick이 끝날 때까지 기다린 뒤 종료한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot({ shutdownDrainMs: 5_000 });

      task.block();
      const tick = processor.tickOnce();
      await waitFor(() => task.started.length === 1);

      const stopping = processor.stop();
      task.unblock();
      await stopping;
      await tick;

      // drain이 완료되면 이 프로세스가 남긴 pending은 없다.
      expect(statusOf(job.id)).toBe('done');
      await logger.flush();
      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('종료 drain 완료'))).toBe(true);
    });

    it('drain이 시간 내 끝나지 않으면 경고를 남기고 종료한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot({ shutdownDrainMs: 50 });

      task.block();
      const tick = processor.tickOnce();
      await waitFor(() => task.started.length === 1);

      await processor.stop();

      await logger.flush();
      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('종료 drain 시간 초과'))).toBe(true);
      // 남은 pending은 다음 기동의 [CON-006]이 복구한다.
      expect(statusOf(job.id)).toBe('pending');

      task.unblock();
      await tick;
    });

    it('종료 후에는 새 tick이 실행되지 않는다', async () => {
      await seedJobs(dir, [makeJob({ status: 'create' })]);
      await boot();

      await processor.stop();
      await processor.tickOnce();

      expect(task.started).toHaveLength(0);
    });

    /**
     * FileLogger.log()는 append를 비동기로 예약하고 즉시 반환한다.
     * Nest의 signal handler는 shutdown hook 직후 프로세스를 재종료하므로,
     * flush하지 않으면 종료 로그와 직전에 대기 중이던 로그가 함께 유실된다.
     */
    it('종료 시 대기 중인 로그를 flush한다 (테스트가 flush를 호출하지 않아도 기록된다)', async () => {
      await seedJobs(dir, [makeJob({ status: 'create' })]);
      await boot();

      await processor.tickOnce();
      await processor.stop();

      // 의도적으로 logger.flush()를 호출하지 않는다.
      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('[scheduler]') && l.includes('선점'))).toBe(true);
      expect(lines.some((l) => l.includes('[scheduler]') && l.includes('종료'))).toBe(true);
    });

    it('app.close()가 대기 중인 HTTP 로그까지 flush한다', async () => {
      await boot();

      await request(app.getHttpServer()).get('/jobs').expect(200);
      await app.close();

      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('[http]') && l.includes('GET /jobs 200'))).toBe(true);
    });

    it('app.close()가 진행 중인 tick을 drain한다 (shutdown hook 경로)', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot({ shutdownDrainMs: 5_000 });

      task.block();
      const tick = processor.tickOnce();
      await waitFor(() => task.started.length === 1);

      // Nest의 SIGINT/SIGTERM 핸들러가 호출하는 것과 같은 경로다.
      const closing = app.close();
      task.unblock();
      await closing;
      await tick;

      // drain이 끝났으므로 pending이 남지 않는다.
      expect((await readJobsFile(dir)).jobs[0].status).toBe('done');
    });
  });

  describe('[LOG-004] 스케줄러 로깅', () => {
    it('선점과 완료를 Job ID와 함께 기록한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      await processor.tickOnce();
      await logger.flush();

      const lines = (await readLogLines(config.logFilePath)).filter((l) => l.includes('[scheduler]'));
      expect(lines.some((l) => l.includes('선점') && l.includes(job.id))).toBe(true);
      expect(lines.some((l) => l.includes('완료') && l.includes(job.id))).toBe(true);
    });

    it('실패와 롤백을 기록한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      task.failWith(new Error('처리 실패'));
      await processor.tickOnce();
      await logger.flush();

      const lines = (await readLogLines(config.logFilePath)).filter((l) => l.includes('[scheduler]'));
      expect(lines.some((l) => l.includes('실패') && l.includes(job.id) && l.includes('롤백'))).toBe(
        true,
      );
    });

    it('처리 대상이 없을 때도 기록한다', async () => {
      await boot();
      await processor.tickOnce();
      await logger.flush();

      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('[scheduler]') && l.includes('없습니다'))).toBe(true);
    });
  });

  describe('service 단위 전이', () => {
    it('[SCH-004] pending이 아닌 Job은 done으로 만들 수 없다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      await expect(service.markDone(job.id)).resolves.toBe(false);
      expect(statusOf(job.id)).toBe('create');
    });

    it('[SCH-005] pending이 아닌 Job은 롤백 대상이 아니다', async () => {
      const job = makeJob({ status: 'done' });
      await seedJobs(dir, [job]);
      await boot();

      await expect(service.rollbackToCreate(job.id)).resolves.toBe(false);
      expect(statusOf(job.id)).toBe('done');
    });

    it('존재하지 않는 Job에 대한 전이는 false를 반환한다', async () => {
      await boot();
      await expect(service.markDone('00000000-0000-4000-8000-0000000000ff')).resolves.toBe(false);
      await expect(service.rollbackToCreate('00000000-0000-4000-8000-0000000000ff')).resolves.toBe(
        false,
      );
    });
  });
});
