/**
 * 저장소·잠금 테스트. SPEC.md §2.3 [LOCK-003]~[LOCK-011], [RUN-004]
 */
import { promises as fs } from 'fs';
import { AppConfig } from '../src/contracts/config';
import { CorruptedStoreError, GlobalLockWaitTimeoutError } from '../src/contracts/errors';
import { createJobLock, createJobsStore } from '../src/contracts/factories';
import { JobsStore } from '../src/contracts/interfaces';
import {
  fileExists,
  globalLockPath,
  hex64,
  jobLockPath,
  jobsJsonPath,
  listLockDirFiles,
  locksDir,
  makeJob,
  ManualClock,
  mkStorageDir,
  readJobsFile,
  reapMutexPath,
  rmDir,
  seedJobs,
  setMtimeAgo,
  testConfig,
  writeGlobalLock,
} from './helpers/test-utils';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('JobsStore / 잠금', () => {
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;

  const workerStore = (processId: string): JobsStore =>
    createJobsStore({ config, processId, ownerType: 'worker', clock });
  const apiStore = (processId: string): JobsStore =>
    createJobsStore({ config, processId, ownerType: 'api', clock });

  beforeEach(async () => {
    dir = await mkStorageDir();
    config = testConfig(dir);
    clock = new ManualClock();
  });

  afterEach(async () => {
    await rmDir(dir);
  });

  describe('[RUN-004] 부트스트랩 초기화', () => {
    it('storage/locks 디렉터리와 genesis jobs.json을 생성한다', async () => {
      const store = workerStore(hex64('p1'));
      await store.init();

      expect(await fileExists(jobsJsonPath(dir))).toBe(true);
      expect(await fileExists(locksDir(dir))).toBe(true);
      const file = await readJobsFile(dir);
      expect(file).toEqual({
        jobs: [],
        workers: {},
        reaper: { workerId: null, lastGlobalLockReapAt: null },
      });
    });

    it('기존 jobs.json이 있으면 데이터를 보존한다 (동시 기동 race 방어)', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);

      await workerStore(hex64('p1')).init();
      await workerStore(hex64('p2')).init();

      const file = await readJobsFile(dir);
      expect(file.jobs).toHaveLength(1);
      expect(file.jobs[0].id).toBe(job.id);
    });

    it('최상위 키 누락 시 누락 키만 보정한다', async () => {
      const job = makeJob();
      await fs.mkdir(locksDir(dir), { recursive: true });
      await fs.writeFile(jobsJsonPath(dir), JSON.stringify({ jobs: [job] }), 'utf8');

      await workerStore(hex64('p1')).init();

      const file = await readJobsFile(dir);
      expect(file.jobs).toHaveLength(1);
      expect(file.workers).toEqual({});
      expect(file.reaper).toEqual({ workerId: null, lastGlobalLockReapAt: null });
    });

    it('손상된 jobs.json은 자동 초기화하지 않는다', async () => {
      await fs.mkdir(locksDir(dir), { recursive: true });
      const corrupt = '{"jobs": [truncated';
      await fs.writeFile(jobsJsonPath(dir), corrupt, 'utf8');

      const store = workerStore(hex64('p1'));
      await expect(store.init()).rejects.toThrow(CorruptedStoreError);

      // 파일이 덮어써지지 않았어야 한다
      expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(corrupt);
    });

    it('런타임 중 손상 감지 시 해당 작업만 실패하고 파일은 보존한다', async () => {
      const store = workerStore(hex64('p1'));
      await store.init();

      const corrupt = 'not json at all';
      await fs.writeFile(jobsJsonPath(dir), corrupt, 'utf8');

      await expect(store.snapshot()).rejects.toThrow(CorruptedStoreError);
      expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(corrupt);
    });
  });

  describe('[LOCK-005] global lock 임계 구역', () => {
    it('save() 호출 시 변경이 영속화되고 임계 구역 종료 후 lock 파일이 남지 않는다', async () => {
      const store = workerStore(hex64('p1'));
      await store.init();

      await store.withGlobalLock(async (tx) => {
        tx.data.jobs.push(makeJob({ id: '00000000-0000-4000-8000-0000000000aa' }));
        await tx.save();
      });

      const file = await readJobsFile(dir);
      expect(file.jobs.some((j) => j.id === '00000000-0000-4000-8000-0000000000aa')).toBe(true);
      expect(await fileExists(globalLockPath(dir))).toBe(false);
    });

    it('save()를 호출하지 않으면 변경이 버려진다', async () => {
      const store = workerStore(hex64('p1'));
      await store.init();

      await store.withGlobalLock(async (tx) => {
        tx.data.jobs.push(makeJob());
      });

      const file = await readJobsFile(dir);
      expect(file.jobs).toHaveLength(0);
    });

    it('잠금 획득 후 디스크에서 reload한다 (외부 변경이 보인다)', async () => {
      const store = workerStore(hex64('p1'));
      await store.init();
      await store.snapshot(); // 인메모리 캐시를 채웠을 수 있는 호출

      // store를 우회한 외부 변경
      const external = makeJob({ id: '00000000-0000-4000-8000-0000000000bb' });
      await seedJobs(dir, [external]);

      const seen = await store.withGlobalLock(async (tx) => tx.data.jobs.map((j) => j.id));
      expect(seen).toContain(external.id);
    });

    it('임계 구역 중 lock 파일이 존재하며 [LOCK-002] 메타데이터를 담는다', async () => {
      const pid = hex64('p1');
      const store = workerStore(pid);
      await store.init();

      await store.withGlobalLock(async () => {
        const raw = JSON.parse(await fs.readFile(globalLockPath(dir), 'utf8'));
        expect(raw.preemption).toBe(pid);
        expect(raw.ownerType).toBe('worker');
        expect(typeof raw.preemptedAt).toBe('string');
      });
    });

    it('save 후 임시 파일 잔존물이 남지 않는다', async () => {
      const store = workerStore(hex64('p1'));
      await store.init();
      await store.withGlobalLock(async (tx) => {
        tx.data.jobs.push(makeJob());
        await tx.save();
      });
      const entries = await fs.readdir(dir);
      expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
    });

    it('[CON-003] 동시 read-modify-write에서 lost update가 없다', async () => {
      const store1 = workerStore(hex64('p1'));
      const store2 = workerStore(hex64('p2'));
      await store1.init();

      const addJob = (store: JobsStore, i: number) =>
        store.withGlobalLock(async (tx) => {
          await sleep(5); // 임계 구역 내 인위적 지연으로 경합 유도
          tx.data.jobs.push(makeJob());
          await tx.save();
        });

      await Promise.all([
        addJob(store1, 1),
        addJob(store2, 2),
        addJob(store1, 3),
        addJob(store2, 4),
        addJob(store1, 5),
        addJob(store2, 6),
      ]);

      const file = await readJobsFile(dir);
      expect(file.jobs).toHaveLength(6);
    });
  });

  describe('[LOCK-008] 경합 대기', () => {
    it('worker는 잠금이 풀릴 때까지 재시도한다', async () => {
      const a = workerStore(hex64('pa'));
      const b = workerStore(hex64('pb'));
      await a.init();

      const order: string[] = [];
      const long = a.withGlobalLock(async () => {
        order.push('a-start');
        await sleep(80);
        order.push('a-end');
      });
      await sleep(10); // a가 먼저 잠금을 잡도록
      const short = b.withGlobalLock(async () => {
        order.push('b');
      });
      await Promise.all([long, short]);
      expect(order).toEqual(['a-start', 'a-end', 'b']);
    });

    it('API는 누적 대기 초과 시 GlobalLockWaitTimeoutError', async () => {
      const store = apiStore(hex64('papi'));
      await store.init();

      // 다른 프로세스 소유의 신선한 lock (주입 시계 기준 — stale reap 방지)
      await writeGlobalLock(dir, {
        preemption: hex64('holder'),
        ownerType: 'api',
        preemptedAt: clock.isoAgo(1_000),
      });

      await expect(store.withGlobalLock(async () => undefined)).rejects.toThrow(
        GlobalLockWaitTimeoutError,
      );
    });
  });

  describe('[LOCK-009][LOCK-010] stale global lock 복구', () => {
    it('preemptedAt이 GLOBAL_LOCK_STALE_AFTER_MS 초과면 어떤 프로세스든 제거하고 진행한다', async () => {
      const store = apiStore(hex64('papi'));
      await store.init();

      await writeGlobalLock(dir, {
        preemption: hex64('dead'),
        ownerType: 'worker',
        preemptedAt: clock.isoAgo(config.globalLockStaleAfterMs + 60_000),
      });

      const result = await store.withGlobalLock(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('reap 후 reaper.lastGlobalLockReapAt이 기록된다', async () => {
      const store = workerStore(hex64('pw'));
      await store.init();

      await writeGlobalLock(dir, {
        preemption: hex64('dead'),
        ownerType: 'worker',
        preemptedAt: clock.isoAgo(config.globalLockStaleAfterMs + 60_000),
      });

      await store.withGlobalLock(async () => undefined);

      const file = await readJobsFile(dir);
      expect(file.reaper.lastGlobalLockReapAt).not.toBeNull();
    });

    it('reap 후 reap-mutex가 남지 않는다', async () => {
      const store = workerStore(hex64('pw'));
      await store.init();
      await writeGlobalLock(dir, {
        preemption: hex64('dead'),
        ownerType: 'worker',
        preemptedAt: clock.isoAgo(config.globalLockStaleAfterMs + 60_000),
      });
      await store.withGlobalLock(async () => undefined);
      expect(await fileExists(reapMutexPath(dir))).toBe(false);
    });

    it('신선한 lock은 reap하지 않는다 (API는 timeout)', async () => {
      const store = apiStore(hex64('papi'));
      await store.init();
      const meta = {
        preemption: hex64('alive'),
        ownerType: 'worker' as const,
        preemptedAt: clock.isoAgo(1_000),
      };
      await writeGlobalLock(dir, meta);

      await expect(store.withGlobalLock(async () => undefined)).rejects.toThrow(
        GlobalLockWaitTimeoutError,
      );
      // lock이 그대로 남아 있어야 한다
      const raw = JSON.parse(await fs.readFile(globalLockPath(dir), 'utf8'));
      expect(raw.preemption).toBe(meta.preemption);
    });

    it('[LOCK-010] 신선한 reap-mutex가 존재하면 reap이 차단된다', async () => {
      const store = apiStore(hex64('papi'));
      await store.init();
      await writeGlobalLock(dir, {
        preemption: hex64('dead'),
        ownerType: 'worker',
        preemptedAt: clock.isoAgo(config.globalLockStaleAfterMs + 60_000),
      });
      // 다른 프로세스가 reaping 중인 상황 (주입 시계 기준 신선한 mutex)
      await fs.writeFile(
        reapMutexPath(dir),
        JSON.stringify({ preemption: hex64('other'), preemptedAt: clock.isoAgo(1_000) }),
        'utf8',
      );

      await expect(store.withGlobalLock(async () => undefined)).rejects.toThrow(
        GlobalLockWaitTimeoutError,
      );
    });

    it('[LOCK-010] stale reap-mutex는 직접 제거하고 reap을 진행한다', async () => {
      const store = workerStore(hex64('pw'));
      await store.init();
      await writeGlobalLock(dir, {
        preemption: hex64('dead'),
        ownerType: 'worker',
        preemptedAt: clock.isoAgo(config.globalLockStaleAfterMs + 60_000),
      });
      const mutexPath = reapMutexPath(dir);
      await fs.writeFile(
        mutexPath,
        JSON.stringify({ preemption: hex64('crashed'), preemptedAt: clock.isoAgo(config.reapMutexStaleMs + 30_000) }),
        'utf8',
      );
      await setMtimeAgo(mutexPath, config.reapMutexStaleMs + 30_000, clock);

      const result = await store.withGlobalLock(async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  describe('JobLockService [LOCK-001][LOCK-003][LOCK-004]', () => {
    const jobId = '00000000-0000-4000-8000-0000000000cc';

    it('tryAcquire 성공 시 metadata가 단일 원자 쓰기로 기록된다', async () => {
      const lock = createJobLock({ config, clock });
      const w1 = hex64('w1');

      expect(await lock.tryAcquire(jobId, w1)).toBe(true);
      const meta = await lock.read(jobId);
      expect(meta?.preemption).toBe(w1);
      expect(typeof meta?.preemptedAt).toBe('string');
    });

    it('이미 잠긴 job의 tryAcquire는 false', async () => {
      const lock = createJobLock({ config, clock });
      await lock.tryAcquire(jobId, hex64('w1'));
      expect(await lock.tryAcquire(jobId, hex64('w2'))).toBe(false);
    });

    it('[CON-001] 동시 tryAcquire 경쟁에서 정확히 1개만 성공한다', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => {
          const lock = createJobLock({ config, clock });
          return lock.tryAcquire(jobId, hex64(`w${i}`));
        }),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('소유자의 release는 lock을 삭제한다', async () => {
      const lock = createJobLock({ config, clock });
      const w1 = hex64('w1');
      await lock.tryAcquire(jobId, w1);

      expect(await lock.release(jobId, w1)).toBe(true);
      expect(await lock.exists(jobId)).toBe(false);
    });

    it('[LOCK-004] 비소유자의 release는 lock을 삭제하지 않는다', async () => {
      const lock = createJobLock({ config, clock });
      const w1 = hex64('w1');
      await lock.tryAcquire(jobId, w1);

      expect(await lock.release(jobId, hex64('w2'))).toBe(false);
      expect(await lock.exists(jobId)).toBe(true);
      const meta = await lock.read(jobId);
      expect(meta?.preemption).toBe(w1);
    });

    it('release 후 locks 디렉터리에 잔존물이 남지 않는다', async () => {
      const lock = createJobLock({ config, clock });
      const w1 = hex64('w1');
      await lock.tryAcquire(jobId, w1);
      await lock.release(jobId, w1);
      const files = await listLockDirFiles(dir);
      expect(files.filter((f) => f.startsWith(jobId))).toEqual([]);
    });
  });
});
