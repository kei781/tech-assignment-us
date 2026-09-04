/**
 * 저장소 테스트. SPEC §3 [CON-002] ~ [CON-004], [CON-006], [RUN-004]
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AppConfig } from '../src/common/config';
import { FileLogger } from '../src/common/logging/file-logger';
import { JobsFileLoadError, JobsStore } from '../src/jobs/jobs.store';
import {
  fileExists,
  jobsJsonPath,
  listDir,
  makeJob,
  ManualClock,
  mkStorageDir,
  readJobsFile,
  readLogLines,
  rmDir,
  seedJobs,
  testConfig,
  writeRawJobsFile,
} from './helpers/test-utils';

describe('JobsStore', () => {
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;
  let logger: FileLogger;

  const newStore = (): JobsStore => new JobsStore(config, clock, logger);

  beforeEach(async () => {
    dir = await mkStorageDir();
    config = testConfig(dir);
    clock = new ManualClock();
    logger = new FileLogger(config, clock);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await logger.flush();
    await rmDir(dir);
  });

  describe('[RUN-004] 부트스트랩', () => {
    it('상위 디렉터리가 없으면 생성하고 jobs.json을 기본 스키마로 만든다', async () => {
      const nested = path.join(dir, 'a', 'b', 'jobs.json');
      config = { ...config, jobsFilePath: nested };
      logger = new FileLogger(config, clock);

      await newStore().init();

      expect(await fileExists(nested)).toBe(true);
      const raw = JSON.parse(await fs.readFile(nested, 'utf8'));
      expect(raw).toEqual({ jobs: [] });
    });

    it('기존 파일이 있으면 그 내용을 로드한다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);

      const store = newStore();
      await store.init();

      expect(store.snapshot().jobs.map((j) => j.id)).toEqual([job.id]);
    });

    it('[DATA-001] 손상된 JSON은 자동 초기화하지 않고 오류를 던진다', async () => {
      await writeRawJobsFile(dir, '{ "jobs": [ this is not json');

      await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);

      // 데이터 보호: 원본을 덮어쓰지 않았다
      const raw = await fs.readFile(jobsJsonPath(dir), 'utf8');
      expect(raw).toContain('this is not json');
    });

    it('[DATA-001] 최상위 jobs 배열이 없으면 오류를 던진다', async () => {
      await writeRawJobsFile(dir, JSON.stringify({ items: [] }));
      await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
    });

    it('init을 두 번 호출해도 데이터를 다시 덮어쓰지 않는다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);

      const store = newStore();
      await store.init();
      await store.init();

      expect(store.snapshot().jobs).toHaveLength(1);
    });
  });

  describe('[CON-006] 기동 복구', () => {
    it('pending Job을 모두 create로 되돌리고 updatedAt을 갱신한다', async () => {
      const pendingA = makeJob({ status: 'pending', updatedAt: '2026-09-01T00:00:00.000Z' });
      const pendingB = makeJob({ status: 'pending', updatedAt: '2026-09-01T00:00:00.000Z' });
      const done = makeJob({ status: 'done' });
      const create = makeJob({ status: 'create' });
      await seedJobs(dir, [pendingA, pendingB, done, create]);

      const store = newStore();
      await store.init();

      const byId = new Map(store.snapshot().jobs.map((j) => [j.id, j]));
      expect(byId.get(pendingA.id)?.status).toBe('create');
      expect(byId.get(pendingB.id)?.status).toBe('create');
      expect(byId.get(pendingA.id)?.updatedAt).toBe(clock.iso());
      // 다른 상태는 건드리지 않는다
      expect(byId.get(done.id)?.status).toBe('done');
      expect(byId.get(create.id)?.updatedAt).toBe(create.updatedAt);
    });

    it('복구 결과가 디스크에도 반영된다', async () => {
      await seedJobs(dir, [makeJob({ status: 'pending' })]);
      await newStore().init();

      const file = await readJobsFile(dir);
      expect(file.jobs[0].status).toBe('create');
    });

    it('[LOG-004] 복구 건수를 storage scope로 로깅한다', async () => {
      await seedJobs(dir, [makeJob({ status: 'pending' }), makeJob({ status: 'pending' })]);
      await newStore().init();
      await logger.flush();

      const lines = await readLogLines(config.logFilePath);
      const line = lines.find((l) => l.includes('[storage]') && l.includes('기동 복구'));
      expect(line).toBeDefined();
      expect(line).toContain('2건');
    });

    it('복구할 pending이 없으면 디스크를 다시 쓰지 않는다', async () => {
      await seedJobs(dir, [makeJob({ status: 'create' })]);
      const before = await fs.readFile(jobsJsonPath(dir), 'utf8');

      await newStore().init();

      expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(before);
    });
  });

  describe('[CON-002] 직렬화', () => {
    it('동시에 시작한 변경이 서로를 덮어쓰지 않는다 (lost update 없음)', async () => {
      const store = newStore();
      await store.init();

      const count = 25;
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          store.mutate((draft) => {
            draft.jobs.push(makeJob({ id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0') }));
          }),
        ),
      );

      expect(store.snapshot().jobs).toHaveLength(count);
      expect((await readJobsFile(dir)).jobs).toHaveLength(count);
    });

    it('변경 콜백이 예외를 던지면 아무것도 저장되지 않는다', async () => {
      const store = newStore();
      await store.init();

      await expect(
        store.mutate((draft) => {
          draft.jobs.push(makeJob());
          throw new Error('도메인 규칙 위반');
        }),
      ).rejects.toThrow('도메인 규칙 위반');

      expect(store.snapshot().jobs).toHaveLength(0);
      expect((await readJobsFile(dir)).jobs).toHaveLength(0);
    });

    it('한 변경이 실패해도 mutex 체인이 끊기지 않는다', async () => {
      const store = newStore();
      await store.init();

      const failing = store.mutate(() => {
        throw new Error('boom');
      });
      const following = store.mutate((draft) => {
        draft.jobs.push(makeJob());
        return 'ok';
      });

      await expect(failing).rejects.toThrow('boom');
      await expect(following).resolves.toBe('ok');
      expect(store.snapshot().jobs).toHaveLength(1);
    });

    it('저장이 실패하면 인메모리 상태와 디스크가 모두 변경 전으로 남는다', async () => {
      const store = newStore();
      await store.init();
      await store.mutate((draft) => {
        draft.jobs.push(makeJob({ title: 'first' }));
      });

      const diskBefore = await fs.readFile(jobsJsonPath(dir), 'utf8');
      jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('디스크 오류'));

      await expect(
        store.mutate((draft) => {
          draft.jobs.push(makeJob({ title: 'second' }));
        }),
      ).rejects.toThrow('디스크 오류');

      // 인메모리: 교체는 저장 성공 후에만 일어난다([CON-002] 4단계)
      expect(store.snapshot().jobs).toHaveLength(1);
      expect(store.snapshot().jobs[0].title).toBe('first');
      // 디스크: 그대로
      expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(diskBefore);
    });
  });

  describe('[CON-003] 원자적 저장', () => {
    it('저장 후 임시 파일이 남지 않는다', async () => {
      const store = newStore();
      await store.init();

      for (let i = 0; i < 5; i += 1) {
        await store.mutate((draft) => {
          draft.jobs.push(makeJob());
        });
      }

      const files = await listDir(dir);
      expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(files).toContain('jobs.json');
    });

    it('rename이 실패해도 임시 파일을 남기지 않는다', async () => {
      const store = newStore();
      await store.init();

      jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename 실패'));
      await expect(
        store.mutate((draft) => {
          draft.jobs.push(makeJob());
        }),
      ).rejects.toThrow('rename 실패');

      const files = await listDir(dir);
      expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('디스크에 쓰기 전에 fsync한다', async () => {
      const store = newStore();
      await store.init();

      const opened = await fs.open(path.join(dir, 'probe'), 'w');
      const syncSpy = jest.spyOn(Object.getPrototypeOf(opened), 'sync');
      await opened.close();

      await store.mutate((draft) => {
        draft.jobs.push(makeJob());
      });

      expect(syncSpy).toHaveBeenCalled();
    });

    it('저장된 파일은 항상 파싱 가능한 완전한 JSON이다', async () => {
      const store = newStore();
      await store.init();
      await store.mutate((draft) => {
        draft.jobs.push(makeJob({ title: '한글 제목', description: '설명' }));
      });

      const file = await readJobsFile(dir);
      expect(file.jobs[0].title).toBe('한글 제목');
    });
  });

  describe('[CON-004] 읽기', () => {
    it('반환된 스냅샷을 변경해도 저장소 상태에 영향이 없다', async () => {
      const store = newStore();
      await store.init();
      await store.mutate((draft) => {
        draft.jobs.push(makeJob({ title: 'original' }));
      });

      const snapshot = store.read((file) => file);
      snapshot.jobs[0].title = 'tampered';
      snapshot.jobs.push(makeJob());

      expect(store.snapshot().jobs).toHaveLength(1);
      expect(store.snapshot().jobs[0].title).toBe('original');
    });

    it('변경 직후의 읽기는 반영된 값을 본다', async () => {
      const store = newStore();
      await store.init();

      await store.mutate((draft) => {
        draft.jobs.push(makeJob({ title: 'visible' }));
      });

      expect(store.read((file) => file.jobs[0].title)).toBe('visible');
    });
  });
});
