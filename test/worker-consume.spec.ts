/**
 * Worker consume 테스트. SPEC.md §5.1, §5.3 [WRK-001], [WRK-003], [WRK-004],
 * [WRK-020]~[WRK-025], [CON-001], [LOG-004]
 */
import { AppConfig } from '../src/contracts/config';
import { createWorkerRuntime } from '../src/contracts/factories';
import { WorkerRuntime } from '../src/contracts/interfaces';
import {
  deferred,
  fileExists,
  hex64,
  jobLockPath,
  makeJob,
  ManualClock,
  mkStorageDir,
  readJobsFile,
  readLogLines,
  rmDir,
  seedJobs,
  testConfig,
  waitFor,
  writeJobLock,
  writeJobsFile,
} from './helpers/test-utils';
import { emptyJobsFile } from '../src/contracts/types';

describe('Worker consume', () => {
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;
  const runtimes: WorkerRuntime[] = [];

  const instantProcess = () => Promise.resolve();

  async function makeWorker(
    seedName: string,
    processJob: (jobId: string) => Promise<void> = instantProcess,
  ): Promise<WorkerRuntime> {
    const rt = await createWorkerRuntime({
      config,
      clock,
      workerId: hex64(seedName),
      processJob,
    });
    runtimes.push(rt);
    return rt;
  }

  beforeEach(async () => {
    dir = await mkStorageDir();
    config = testConfig(dir);
    clock = new ManualClock();
    await writeJobsFile(dir, emptyJobsFile());
  });

  afterEach(async () => {
    for (const rt of runtimes.splice(0)) {
      try {
        await rt.shutdown();
      } catch {
        // 테스트 중 이미 종료된 런타임 무시
      }
    }
    await rmDir(dir);
  });

  describe('[WRK-001] 시작 등록', () => {
    it('생성 시 workers 레지스트리에 heartbeatAt과 함께 등록된다', async () => {
      const rt = await makeWorker('w1');
      const file = await readJobsFile(dir);
      expect(file.workers[rt.workerId]).toBeDefined();
      expect(file.workers[rt.workerId].heartbeatAt).toBe(clock.iso());
    });

    it('workerId는 64자리 hex다', async () => {
      const rt = await makeWorker('w1');
      expect(rt.workerId).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('[WRK-020][WRK-021] 후보 선정과 claim', () => {
    it('createdAt ASC, id ASC 첫 후보를 선점하여 pending → done 처리한다', async () => {
      const early = makeJob({
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: '2026-09-01T00:00:00.000Z',
      });
      const late = makeJob({
        id: '00000000-0000-4000-8000-000000000002',
        createdAt: '2026-09-02T00:00:00.000Z',
      });
      await seedJobs(dir, [late, early]);

      const gate = deferred<void>();
      const processed: string[] = [];
      const rt = await makeWorker('w1', async (jobId) => {
        processed.push(jobId);
        await gate.promise;
      });

      const ticking = rt.consume.consumeOnce();

      // 처리 중 상태 관찰: early가 pending + per-job lock 존재
      await waitFor(async () => {
        const f = await readJobsFile(dir);
        return f.jobs.find((j) => j.id === early.id)?.status === 'pending';
      });
      expect(await fileExists(jobLockPath(dir, early.id))).toBe(true);
      expect(processed).toEqual([early.id]);

      // late는 건드리지 않는다 (한 tick에 하나만)
      let file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === late.id)?.status).toBe('create');

      gate.resolve();
      await ticking;

      // [WRK-024] 완료: done + lock 삭제
      file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === early.id)?.status).toBe('done');
      expect(await fileExists(jobLockPath(dir, early.id))).toBe(false);
    });

    it('createdAt 동률이면 id ASC가 우선한다', async () => {
      const t = '2026-09-01T00:00:00.000Z';
      const a = makeJob({ id: '00000000-0000-4000-8000-00000000000a', createdAt: t });
      const b = makeJob({ id: '00000000-0000-4000-8000-00000000000b', createdAt: t });
      await seedJobs(dir, [b, a]);

      const processed: string[] = [];
      const rt = await makeWorker('w1', async (id) => {
        processed.push(id);
      });
      await rt.consume.consumeOnce();
      expect(processed).toEqual([a.id]);
    });

    it('첫 후보의 lock이 이미 있으면 즉시 다음 후보를 처리한다', async () => {
      const first = makeJob({
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: '2026-09-01T00:00:00.000Z',
      });
      const second = makeJob({
        id: '00000000-0000-4000-8000-000000000002',
        createdAt: '2026-09-02T00:00:00.000Z',
      });
      await seedJobs(dir, [first, second]);
      const foreign = hex64('other-worker');
      await writeJobLock(dir, first.id, { preemption: foreign, preemptedAt: clock.iso() });

      const rt = await makeWorker('w1');
      await rt.consume.consumeOnce();

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === second.id)?.status).toBe('done');
      // first는 그대로: 상태 유지 + 외부 lock 보존
      expect(file.jobs.find((j) => j.id === first.id)?.status).toBe('create');
      const lockRaw = JSON.parse(
        await (await import('fs')).promises.readFile(jobLockPath(dir, first.id), 'utf8'),
      );
      expect(lockRaw.preemption).toBe(foreign);
    });

    it('[WRK-022] 모든 후보의 lock 획득에 실패하면 tick이 조용히 끝난다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);
      await writeJobLock(dir, job.id, { preemption: hex64('other'), preemptedAt: clock.iso() });

      const processJob = jest.fn(instantProcess);
      const rt = await makeWorker('w1', processJob);
      await rt.consume.consumeOnce();

      expect(processJob).not.toHaveBeenCalled();
      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.status).toBe('create');
    });

    it('[WRK-022] create 후보가 없으면 아무 일도 하지 않는다', async () => {
      await seedJobs(dir, [makeJob({ status: 'done' }), makeJob({ status: 'pending' })]);
      const processJob = jest.fn(instantProcess);
      const rt = await makeWorker('w1', processJob);
      await rt.consume.consumeOnce();
      expect(processJob).not.toHaveBeenCalled();
    });
  });

  describe('[WRK-003] isConsuming guard', () => {
    it('처리 중에는 다음 tick이 새 job을 선점하지 않는다', async () => {
      const j1 = makeJob({ createdAt: '2026-09-01T00:00:00.000Z' });
      const j2 = makeJob({ createdAt: '2026-09-02T00:00:00.000Z' });
      await seedJobs(dir, [j1, j2]);

      const gate = deferred<void>();
      const rt = await makeWorker('w1', async () => gate.promise);

      const first = rt.consume.consumeOnce();
      await waitFor(async () => rt.consume.isConsuming);

      await rt.consume.consumeOnce(); // guard: 즉시 반환되어야 함

      const file = await readJobsFile(dir);
      const pendingCount = file.jobs.filter((j) => j.status === 'pending').length;
      expect(pendingCount).toBe(1);

      gate.resolve();
      await first;
    });
  });

  describe('[WRK-024] 완료 전 소유권 재검증', () => {
    it('처리 중 lock 소유자가 바뀌면 done으로 덮어쓰지 않는다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);

      const gate = deferred<void>();
      const rt = await makeWorker('w1', async () => gate.promise);
      const ticking = rt.consume.consumeOnce();

      await waitFor(async () => {
        const f = await readJobsFile(dir);
        return f.jobs.find((j) => j.id === job.id)?.status === 'pending';
      });

      // 외부 주체(복구 후 재선점 시나리오)가 lock을 교체
      const foreign = hex64('foreign');
      const fs = (await import('fs')).promises;
      await fs.writeFile(
        jobLockPath(dir, job.id),
        JSON.stringify({ preemption: foreign, preemptedAt: clock.iso() }),
        'utf8',
      );

      gate.resolve();
      await ticking;

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.status).not.toBe('done');
      // [LOCK-004] 타인 소유 lock은 삭제하지 않는다
      const lockRaw = JSON.parse(await fs.readFile(jobLockPath(dir, job.id), 'utf8'));
      expect(lockRaw.preemption).toBe(foreign);
    });
  });

  describe('[WRK-025] 처리 예외 복구', () => {
    it('processJob이 던지면 pending → create 롤백 + lock 삭제', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);

      const rt = await makeWorker('w1', async () => {
        throw new Error('processing failed');
      });
      await rt.consume.consumeOnce(); // 던지지 않고 내부에서 복구해야 함

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.status).toBe('create');
      expect(await fileExists(jobLockPath(dir, job.id))).toBe(false);
    });
  });

  describe('[WRK-004] 정상 종료', () => {
    it('처리 중 shutdown 시 pending job을 create로 롤백하고 등록을 해제한다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);

      const gate = deferred<void>();
      const rt = await makeWorker('w1', async () => gate.promise);
      const ticking = rt.consume.consumeOnce();

      await waitFor(async () => {
        const f = await readJobsFile(dir);
        return f.jobs.find((j) => j.id === job.id)?.status === 'pending';
      });

      await rt.shutdown();

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.status).toBe('create');
      expect(await fileExists(jobLockPath(dir, job.id))).toBe(false);
      expect(file.workers[rt.workerId]).toBeUndefined();

      // 진행 중이던 consume이 완료를 시도해도 done으로 덮어쓰지 않는다
      gate.resolve();
      await ticking;
      const after = await readJobsFile(dir);
      expect(after.jobs.find((j) => j.id === job.id)?.status).toBe('create');
    });

    it('유휴 상태 shutdown 시 workers에서 제거된다', async () => {
      const rt = await makeWorker('w1');
      await rt.shutdown();
      const file = await readJobsFile(dir);
      expect(file.workers[rt.workerId]).toBeUndefined();
    });
  });

  describe('[CON-001] 다중 Worker 경쟁', () => {
    it('두 Worker가 동시에 같은 job을 노려도 정확히 한 번만 처리된다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);

      const calls: string[] = [];
      const process1 = jest.fn(async (id: string) => {
        calls.push(`w1:${id}`);
      });
      const process2 = jest.fn(async (id: string) => {
        calls.push(`w2:${id}`);
      });
      const rt1 = await makeWorker('w1', process1);
      const rt2 = await makeWorker('w2', process2);

      await Promise.all([rt1.consume.consumeOnce(), rt2.consume.consumeOnce()]);

      expect(calls).toHaveLength(1);
      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.status).toBe('done');
      expect(await fileExists(jobLockPath(dir, job.id))).toBe(false);
    });

    it('job 2개 + worker 2개 동시 실행 시 서로 다른 job을 처리할 수 있고 중복이 없다', async () => {
      const j1 = makeJob({ createdAt: '2026-09-01T00:00:00.000Z' });
      const j2 = makeJob({ createdAt: '2026-09-02T00:00:00.000Z' });
      await seedJobs(dir, [j1, j2]);

      const seen: string[] = [];
      const rt1 = await makeWorker('w1', async (id) => {
        seen.push(id);
      });
      const rt2 = await makeWorker('w2', async (id) => {
        seen.push(id);
      });

      await Promise.all([rt1.consume.consumeOnce(), rt2.consume.consumeOnce()]);

      // 각 job은 최대 1회 처리 (중복 없음)
      expect(new Set(seen).size).toBe(seen.length);
      const file = await readJobsFile(dir);
      const doneCount = file.jobs.filter((j) => j.status === 'done').length;
      expect(doneCount).toBe(seen.length);
    });
  });

  describe('[LOG-004] Worker 처리 로깅', () => {
    it('claim과 완료가 worker scope로 로깅된다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);
      const rt = await makeWorker('w1');
      await rt.consume.consumeOnce();

      const lines = await readLogLines(config.logFilePath);
      const workerLines = lines.filter((l) => l.includes('[worker]'));
      expect(workerLines.some((l) => l.includes(job.id))).toBe(true);
      expect(workerLines.length).toBeGreaterThanOrEqual(2); // claim + done
    });

    it('롤백도 로깅된다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);
      const rt = await makeWorker('w1', async () => {
        throw new Error('boom');
      });
      await rt.consume.consumeOnce();

      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('[worker]') && l.includes(job.id))).toBe(true);
    });
  });
});
