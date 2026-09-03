/**
 * Heartbeat·Reaper 테스트. SPEC.md §5.2, §5.4, §5.5
 * [WRK-010], [RPR-001]~[RPR-003], [RPR-010]~[RPR-013]
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { AppConfig } from '../src/contracts/config';
import { createWorkerRuntime } from '../src/contracts/factories';
import { WorkerRuntime } from '../src/contracts/interfaces';
import { emptyJobsFile, JobsFile } from '../src/contracts/types';
import {
  fileExists,
  globalLockPath,
  hex64,
  jobLockPath,
  locksDir,
  makeJob,
  ManualClock,
  mkStorageDir,
  readJobsFile,
  rmDir,
  setMtimeAgo,
  testConfig,
  writeGlobalLock,
  writeJobLock,
  writeJobsFile,
} from './helpers/test-utils';

describe('Heartbeat / Reaper', () => {
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;
  const runtimes: WorkerRuntime[] = [];

  async function makeWorker(seedName: string): Promise<WorkerRuntime> {
    const rt = await createWorkerRuntime({ config, clock, workerId: hex64(seedName) });
    runtimes.push(rt);
    return rt;
  }

  /** 현재 파일을 읽어 일부를 수정해 다시 쓴다 (fixture 조작) */
  async function patchFile(mutate: (f: JobsFile) => void): Promise<void> {
    const f = await readJobsFile(dir);
    mutate(f);
    await writeJobsFile(dir, f);
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
        // 이미 종료된 런타임 무시
      }
    }
    await rmDir(dir);
  });

  describe('[WRK-010] Heartbeat', () => {
    it('beatOnce가 heartbeatAt을 현재 시각으로 갱신한다', async () => {
      const rt = await makeWorker('w1');
      clock.advance(60_000);
      await rt.heartbeat.beatOnce();

      const file = await readJobsFile(dir);
      expect(file.workers[rt.workerId].heartbeatAt).toBe(clock.iso());
    });
  });

  describe('[RPR-001][RPR-002] 선출', () => {
    it('Reaper가 없으면 후보 등록하고, grace period 후 재확인하여 Reaper가 된다', async () => {
      const rt = await makeWorker('w1');

      await rt.reaper.checkOnce();
      let file = await readJobsFile(dir);
      expect(file.reaper.workerId).toBe(rt.workerId);
      expect(rt.reaper.isReaper).toBe(false); // grace 전에는 아직 아님

      clock.advance(config.reaperElectionGraceMs + 1_000);
      await rt.reaper.checkOnce();
      expect(rt.reaper.isReaper).toBe(true);
    });

    it('grace period 중 다른 후보로 교체되면 Reaper가 되지 못한다', async () => {
      const rt = await makeWorker('w1');
      await rt.reaper.checkOnce(); // 후보 등록

      // 경쟁자가 마지막 저장자가 된 상황
      const rival = hex64('rival');
      await patchFile((f) => {
        f.workers[rival] = { heartbeatAt: clock.iso() };
        f.reaper.workerId = rival;
      });

      clock.advance(config.reaperElectionGraceMs + 1_000);
      await rt.reaper.checkOnce();
      expect(rt.reaper.isReaper).toBe(false);
    });

    it('유효한 현 Reaper(등록 + heartbeat 5분 이내)가 있으면 후보 등록을 포기한다', async () => {
      const incumbent = hex64('incumbent');
      await patchFile((f) => {
        f.workers[incumbent] = { heartbeatAt: clock.isoAgo(60_000) };
        f.reaper.workerId = incumbent;
      });

      const rt = await makeWorker('w1');
      await rt.reaper.checkOnce();

      const file = await readJobsFile(dir);
      expect(file.reaper.workerId).toBe(incumbent);
      expect(rt.reaper.isReaper).toBe(false);
    });

    it('현 Reaper의 heartbeat가 5분 초과면 후보 등록한다', async () => {
      const stale = hex64('stale-reaper');
      await patchFile((f) => {
        f.workers[stale] = { heartbeatAt: clock.isoAgo(config.reaperStaleAfterMs + 60_000) };
        f.reaper.workerId = stale;
      });

      const rt = await makeWorker('w1');
      await rt.reaper.checkOnce();

      const file = await readJobsFile(dir);
      expect(file.reaper.workerId).toBe(rt.workerId);
    });

    it('현 Reaper가 workers에 없으면 후보 등록한다', async () => {
      await patchFile((f) => {
        f.reaper.workerId = hex64('ghost');
      });

      const rt = await makeWorker('w1');
      await rt.reaper.checkOnce();

      const file = await readJobsFile(dir);
      expect(file.reaper.workerId).toBe(rt.workerId);
    });
  });

  /** 자연 선출 경로([RPR-002])로 rt를 Reaper로 만드는 fixture */
  async function makeReaper(seedName = 'reaper'): Promise<WorkerRuntime> {
    const rt = await makeWorker(seedName);
    await rt.reaper.checkOnce(); // 후보 등록
    clock.advance(config.reaperElectionGraceMs + 1_000);
    await rt.reaper.checkOnce(); // grace 후 확정
    expect(rt.reaper.isReaper).toBe(true);
    return rt;
  }

  describe('[RPR-010] stale worker 정리', () => {
    it('heartbeat 6분 이상 경과한 worker를 삭제하고 신선한 worker는 유지한다', async () => {
      const rt = await makeReaper();
      const staleW = hex64('stale-w');
      const freshW = hex64('fresh-w');
      await patchFile((f) => {
        f.workers[staleW] = { heartbeatAt: clock.isoAgo(config.workerDeleteAfterMs + 1_000) };
        f.workers[freshW] = { heartbeatAt: clock.isoAgo(60_000) };
      });

      await rt.reaper.cleanupOnce();

      const file = await readJobsFile(dir);
      expect(file.workers[staleW]).toBeUndefined();
      expect(file.workers[freshW]).toBeDefined();
      expect(file.workers[rt.workerId]).toBeDefined();
    });

    it('자신의 heartbeat가 stale이면 cleanup을 수행하지 않는다', async () => {
      const rt = await makeReaper();
      const staleW = hex64('stale-w');
      await patchFile((f) => {
        f.workers[staleW] = { heartbeatAt: clock.isoAgo(config.workerDeleteAfterMs + 1_000) };
        f.workers[rt.workerId] = { heartbeatAt: clock.isoAgo(config.reaperStaleAfterMs + 1_000) };
      });

      await rt.reaper.cleanupOnce();

      const file = await readJobsFile(dir);
      expect(file.workers[staleW]).toBeDefined(); // 삭제되지 않음
    });

    it('[RPR-010 유예] lastGlobalLockReapAt이 최근이면 stale worker를 삭제하지 않는다', async () => {
      const rt = await makeReaper();
      const staleW = hex64('stale-w');
      await patchFile((f) => {
        f.workers[staleW] = { heartbeatAt: clock.isoAgo(config.workerDeleteAfterMs + 1_000) };
        f.reaper.lastGlobalLockReapAt = clock.isoAgo(30_000); // < 2 × heartbeatIntervalMs
      });

      await rt.reaper.cleanupOnce();
      let file = await readJobsFile(dir);
      expect(file.workers[staleW]).toBeDefined();

      // 유예 창이 지나면 삭제된다
      clock.advance(2 * config.heartbeatIntervalMs + 1_000);
      await rt.heartbeat.beatOnce(); // 자신이 stale로 판정되지 않도록 갱신
      await rt.reaper.cleanupOnce();
      file = await readJobsFile(dir);
      expect(file.workers[staleW]).toBeUndefined();
    });
  });

  describe('[RPR-011] orphan per-job lock 복구', () => {
    it('죽은 worker의 lock: pending job을 create로 롤백하고 lock을 삭제한다', async () => {
      const rt = await makeReaper();
      const job = makeJob({ status: 'pending', updatedAt: clock.isoAgo(120_000) });
      await patchFile((f) => {
        f.jobs.push(job);
      });
      await writeJobLock(dir, job.id, {
        preemption: hex64('dead-worker'),
        preemptedAt: clock.isoAgo(120_000),
      });

      await rt.reaper.cleanupOnce();

      const file = await readJobsFile(dir);
      const recovered = file.jobs.find((j) => j.id === job.id);
      expect(recovered?.status).toBe('create');
      expect(recovered?.updatedAt).toBe(clock.iso());
      expect(await fileExists(jobLockPath(dir, job.id))).toBe(false);
    });

    it('done job의 orphan lock은 상태 변경 없이 lock만 삭제한다', async () => {
      const rt = await makeReaper();
      const job = makeJob({ status: 'done' });
      await patchFile((f) => {
        f.jobs.push(job);
      });
      await writeJobLock(dir, job.id, {
        preemption: hex64('dead-worker'),
        preemptedAt: clock.isoAgo(120_000),
      });

      await rt.reaper.cleanupOnce();

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.status).toBe('done');
      expect(await fileExists(jobLockPath(dir, job.id))).toBe(false);
    });

    it('존재하지 않는 job의 orphan lock도 삭제한다', async () => {
      const rt = await makeReaper();
      const ghostJobId = '00000000-0000-4000-8000-0000000000dd';
      await writeJobLock(dir, ghostJobId, {
        preemption: hex64('dead-worker'),
        preemptedAt: clock.isoAgo(120_000),
      });

      await rt.reaper.cleanupOnce();
      expect(await fileExists(jobLockPath(dir, ghostJobId))).toBe(false);
    });

    it('살아 있는 worker의 lock은 건드리지 않는다', async () => {
      const rt = await makeReaper();
      const aliveW = hex64('alive-w');
      const job = makeJob({ status: 'pending' });
      await patchFile((f) => {
        f.jobs.push(job);
        f.workers[aliveW] = { heartbeatAt: clock.isoAgo(60_000) };
      });
      await writeJobLock(dir, job.id, { preemption: aliveW, preemptedAt: clock.isoAgo(30_000) });

      await rt.reaper.cleanupOnce();

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.status).toBe('pending');
      expect(await fileExists(jobLockPath(dir, job.id))).toBe(true);
    });

    it('파싱 불가 lock은 mtime이 5분 경과 전이면 보존, 경과 후면 삭제한다', async () => {
      const rt = await makeReaper();
      const jobId = '00000000-0000-4000-8000-0000000000ee';
      const lockPath = jobLockPath(dir, jobId);
      await fs.mkdir(locksDir(dir), { recursive: true });
      await fs.writeFile(lockPath, '', 'utf8'); // 빈 lock

      // mtime이 신선 → 보존
      await rt.reaper.cleanupOnce();
      expect(await fileExists(lockPath)).toBe(true);

      // mtime이 5분 초과 → 삭제
      await setMtimeAgo(lockPath, config.reaperStaleAfterMs + 60_000, clock);
      await rt.reaper.cleanupOnce();
      expect(await fileExists(lockPath)).toBe(false);
    });

    it('오래된 절차 잔존물(*.reaping-*, *.tmp)을 정리한다', async () => {
      const rt = await makeReaper();
      const residue1 = path.join(locksDir(dir), 'jobs-global-lock.json.reaping-' + hex64('x'));
      const residue2 = path.join(dir, 'jobs.json.' + hex64('y').slice(0, 8) + '.tmp');
      await fs.writeFile(residue1, '{}', 'utf8');
      await fs.writeFile(residue2, '{}', 'utf8');
      await setMtimeAgo(residue1, config.reaperStaleAfterMs + 60_000, clock);
      await setMtimeAgo(residue2, config.reaperStaleAfterMs + 60_000, clock);

      await rt.reaper.cleanupOnce();

      expect(await fileExists(residue1)).toBe(false);
      expect(await fileExists(residue2)).toBe(false);
    });
  });

  describe('[RPR-012] stale global lock 복구 (registry 기반 ①)', () => {
    it('worker 소유 + registry 부재 + orphanMin 경과면 global lock을 제거한다', async () => {
      const rt = await makeReaper();
      await writeGlobalLock(dir, {
        preemption: hex64('vanished-worker'),
        ownerType: 'worker',
        preemptedAt: clock.isoAgo(config.globalLockOrphanMinMs + 10_000), // < staleAfter
      });

      await rt.reaper.cleanupOnce();

      expect(await fileExists(globalLockPath(dir))).toBe(false);
      const file = await readJobsFile(dir);
      expect(file.reaper.lastGlobalLockReapAt).not.toBeNull();
    });

    it('orphanMin 경과 전의 worker 소유 lock(부트스트랩 lock)은 제거하지 않는다', async () => {
      const rt = await makeReaper();
      const bootstrapLock = {
        preemption: hex64('booting-worker'),
        ownerType: 'worker' as const,
        preemptedAt: clock.isoAgo(10_000), // orphanMin 미경과
      };
      await writeGlobalLock(dir, bootstrapLock);

      // cleanup은 global lock이 점유된 동안 대기하므로, 소유자 해제를 시뮬레이션:
      // 일정 시간 뒤 lock을 제거하고, 그 시점까지 lock이 보존됐는지 확인한다.
      const cleanup = rt.reaper.cleanupOnce();
      await new Promise((r) => setTimeout(r, 100));
      const stillThere = await fileExists(globalLockPath(dir));
      const raw = stillThere
        ? JSON.parse(await fs.readFile(globalLockPath(dir), 'utf8'))
        : null;
      await fs.rm(globalLockPath(dir), { force: true }); // 소유자 정상 해제 시뮬레이션
      await cleanup;

      expect(stillThere).toBe(true);
      expect(raw?.preemption).toBe(bootstrapLock.preemption);
    });
  });

  describe('[RPR-013] pending-무lock 복구', () => {
    it('lock 없는 pending job은 updatedAt 5분 초과 시 create로 롤백된다', async () => {
      const rt = await makeReaper();
      const staleJob = makeJob({
        status: 'pending',
        updatedAt: clock.isoAgo(config.reaperStaleAfterMs + 60_000),
      });
      const freshJob = makeJob({
        status: 'pending',
        updatedAt: clock.isoAgo(60_000),
      });
      await patchFile((f) => {
        f.jobs.push(staleJob, freshJob);
      });

      await rt.reaper.cleanupOnce();

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === staleJob.id)?.status).toBe('create');
      expect(file.jobs.find((j) => j.id === freshJob.id)?.status).toBe('pending');
    });
  });

  describe('[RPR-003] 자격 재검증', () => {
    it('cleanup 도중 reaper가 교체되어 있으면 파괴적 조치를 수행하지 않는다', async () => {
      const rt = await makeReaper();
      const staleW = hex64('stale-w');
      await patchFile((f) => {
        f.workers[staleW] = { heartbeatAt: clock.isoAgo(config.workerDeleteAfterMs + 1_000) };
        f.reaper.workerId = hex64('new-reaper'); // 외부에서 교체됨
      });

      await rt.reaper.cleanupOnce();

      const file = await readJobsFile(dir);
      expect(file.workers[staleW]).toBeDefined(); // 조치 없음
    });
  });

  describe('[WRK-004] 종료 시 Reaper 해제', () => {
    it('Reaper인 worker가 shutdown하면 reaper.workerId가 비워진다', async () => {
      const rt = await makeReaper();
      await rt.shutdown();

      const file = await readJobsFile(dir);
      expect(file.reaper.workerId).toBeNull();
      expect(file.workers[rt.workerId]).toBeUndefined();
    });
  });
});
