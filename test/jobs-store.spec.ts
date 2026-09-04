import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AppConfig } from '../src/common/config';
import { FileLogger } from '../src/common/logger';
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

      const raw = await fs.readFile(jobsJsonPath(dir), 'utf8');
      expect(raw).toContain('this is not json');
    });

    it('[DATA-001] 최상위 jobs 배열이 없으면 오류를 던진다', async () => {
      await writeRawJobsFile(dir, JSON.stringify({ items: [] }));
      await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
    });

    /**
     * 인메모리 상태는 { jobs }만 담으므로, 최상위에 다른 키가 있는 파일을 받아들이면
     * 다음 쓰기에서 그 키가 조용히 사라진다. 손상 파일을 자동 초기화하지 않는
     * 방침과 정반대되는 데이터 손실이라, 로드 시점에 거부해야 한다.
     */
    describe('[RUN-005][DATA-001] 최상위 키 검증', () => {
      it.each([
        ['정의되지 않은 키가 섞임', { jobs: [], sentinel: { must: 'remain' } }],
        ['jobs 외 다른 키만', { items: [] }],
        ['jobs가 배열이 아님', { jobs: {} }],
        ['최상위가 배열', []],
        ['최상위가 배열 안 객체', [{ jobs: [] }]],
      ])('%s이면 기동을 중단시킨다', async (_name, content) => {
        await writeRawJobsFile(dir, JSON.stringify(content));
        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
      });

      it('거부 시 원본 파일이 그대로 보존된다', async () => {
        const raw = JSON.stringify({ jobs: [], sentinel: { must: 'remain' } });
        await writeRawJobsFile(dir, raw);

        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);

        expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(raw);
      });

      it('오류 메시지가 어느 키가 문제인지 알려준다', async () => {
        await writeRawJobsFile(dir, JSON.stringify({ jobs: [], sentinel: 1 }));
        await expect(newStore().init()).rejects.toThrow(/sentinel/);
      });
    });

    /**
     * parse는 되지만 스키마가 어긋난 레코드가 통과하면, 원인에서 멀리 떨어진
     * 런타임에서 TypeError로 터진다. 손상 JSON과 같은 취급으로 기동을 멈춘다.
     */
    describe('[RUN-005][DATA-002] 레코드 단위 스키마 검증', () => {
      const valid = {
        id: '3f1c9a6e-5b47-4d2a-9c8e-1a2b3c4d5e6f',
        title: 't',
        description: 'd',
        status: 'create',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      };

      const seedRaw = async (jobs: unknown[]): Promise<void> => {
        await writeRawJobsFile(dir, JSON.stringify({ jobs }));
      };

      it('빈 객체 레코드는 기동을 중단시킨다', async () => {
        await seedRaw([{}]);
        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
      });

      it.each([
        ['id 누락', { ...valid, id: undefined }],
        ['id가 UUID v4가 아님', { ...valid, id: '550e8400-e29b-11d4-0716-446655440000' }],
        ['title 누락', { ...valid, title: undefined }],
        ['title이 문자열 아님', { ...valid, title: 123 }],
        ['title 공백만', { ...valid, title: '   ' }],
        ['title 길이 초과', { ...valid, title: 'a'.repeat(1001) }],
        ['description 누락', { ...valid, description: undefined }],
        ['description 길이 초과', { ...valid, description: 'a'.repeat(2001) }],
        ['status가 enum 아님', { ...valid, status: 'unknown' }],
        ['createdAt이 ISO UTC 아님', { ...valid, createdAt: '2026-09-01' }],
        ['updatedAt 누락', { ...valid, updatedAt: undefined }],
        ['정의되지 않은 키 포함', { ...valid, extra: 1 }],
        ['레코드가 객체 아님', 'not-an-object'],
      ])('%s이면 기동을 중단시킨다', async (_name, record) => {
        await seedRaw([record]);
        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
      });

      /**
       * [DATA-002]는 trim된 값을 저장한다고 규정한다. 로더가 공백을 허용하면
       * API가 만든 데이터와 손으로 고친 데이터의 규칙이 갈린다.
       */
      it.each(['  padded  ', 'trailing ', ' leading'])(
        'title에 앞뒤 공백이 있으면(%j) 기동을 중단시킨다',
        async (title) => {
          await seedRaw([{ ...valid, title }]);
          await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
        },
      );

      /**
       * 형식만 보는 정규식은 존재하지 않는 시각을 통과시킨다. `2026-02-30`은
       * JS Date가 `2026-03-02`로 넘겨버려 조용히 다른 값이 된다.
       */
      it.each([
        '2026-99-99T99:99:99.999Z',
        '2026-13-01T00:00:00.000Z',
        '2026-02-30T00:00:00.000Z',
        '2026-09-01T25:00:00.000Z',
      ])('실제로 존재하지 않는 시각(%s)이면 기동을 중단시킨다', async (createdAt) => {
        await seedRaw([{ ...valid, createdAt }]);
        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
      });

      /**
       * 길이는 코드포인트로 센다 — DTO(class-validator)와 같은 정의여야
       * 성공한 POST가 재시작 불능 파일을 만들지 않는다.
       */
      it('이모지로 최대 길이를 채운 레코드는 정상 로드된다', async () => {
        await seedRaw([{ ...valid, title: '😀'.repeat(1000), description: '🎉'.repeat(2000) }]);

        const store = newStore();
        await store.init();

        expect([...store.snapshot().jobs[0].title]).toHaveLength(1000);
      });

      it('코드포인트가 한 자 초과하면 기동을 중단시킨다', async () => {
        await seedRaw([{ ...valid, title: '😀'.repeat(1001) }]);
        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
      });

      it('id가 중복되면 기동을 중단시킨다', async () => {
        await seedRaw([valid, { ...valid, title: 'other' }]);
        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);
      });

      it('오류 메시지가 몇 번째 레코드의 무엇이 문제인지 알려준다', async () => {
        await seedRaw([valid, { ...valid, id: 'nope' }]);
        await expect(newStore().init()).rejects.toThrow(/jobs\[1\].*id/);
      });

      it('규칙을 만족하는 레코드는 정상 로드된다', async () => {
        await seedRaw([valid]);
        const store = newStore();
        await store.init();
        expect(store.snapshot().jobs).toEqual([valid]);
      });

      it('검증 실패 시 원본 파일을 덮어쓰지 않는다', async () => {
        await seedRaw([{}]);
        const before = await fs.readFile(jobsJsonPath(dir), 'utf8');

        await expect(newStore().init()).rejects.toThrow(JobsFileLoadError);

        expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(before);
      });
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

    /**
     * 위 테스트의 실패는 콜백의 동기 throw다. 저장 단계(rename)에서 실패하는 경로는
     * `await`를 지난 뒤 거부되므로 mutate를 다른 지점까지 통과한다. 그 실패 뒤에도
     * 저장소가 계속 쓸 수 있는지는 별도로 봐야 한다 — 기존 저장 실패 테스트는
     * 그 시점의 상태만 보고 이후 변경을 확인하지 않는다.
     */
    it('저장 실패 후에도 다음 변경이 성공하고 디스크까지 반영된다', async () => {
      const store = newStore();
      await store.init();

      jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('일시적 디스크 오류'));

      await expect(
        store.mutate((draft) => {
          draft.jobs.push(makeJob({ title: '유실될 변경' }));
        }),
      ).rejects.toThrow('일시적 디스크 오류');

      // 디스크가 회복된 뒤의 변경은 정상 저장되어야 한다.
      const saved = await store.mutate((draft) => {
        const job = makeJob({ title: '회복 후 변경' });
        draft.jobs.push(job);
        return job.id;
      });

      expect(store.snapshot().jobs.map((j) => j.title)).toEqual(['회복 후 변경']);

      const onDisk = await readJobsFile(dir);
      expect(onDisk.jobs.map((j) => j.id)).toEqual([saved]);
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

      // 교체는 저장 성공 후에만 일어난다
      expect(store.snapshot().jobs).toHaveLength(1);
      expect(store.snapshot().jobs[0].title).toBe('first');
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

    /**
     * rename만이 실패 지점이 아니다. write/fsync/close 실패도 임시 파일을 남기면
     * 반복되는 디스크 오류가 숨겨진 .tmp를 계속 누적시킨다.
     */
    it.each(['writeFile', 'sync'] as const)(
      'FileHandle.%s가 실패해도 임시 파일을 남기지 않는다',
      async (method) => {
        const store = newStore();
        await store.init();
        const diskBefore = await fs.readFile(jobsJsonPath(dir), 'utf8');

        const probe = await fs.open(path.join(dir, 'probe-' + method), 'w');
        const handleProto = Object.getPrototypeOf(probe);
        await probe.close();

        const spy = jest
          .spyOn(handleProto, method)
          .mockRejectedValueOnce(new Error(method + ' 실패'));

        await expect(
          store.mutate((draft) => {
            draft.jobs.push(makeJob());
          }),
        ).rejects.toThrow(method + ' 실패');

        spy.mockRestore();

        const files = await listDir(dir);
        expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
        expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(diskBefore);
        expect(store.snapshot().jobs).toHaveLength(0);
      },
    );

    it('close가 실패해도 임시 파일을 남기지 않는다', async () => {
      const store = newStore();
      await store.init();
      const diskBefore = await fs.readFile(jobsJsonPath(dir), 'utf8');

      // close는 프로토타입이 아니라 FileHandle 인스턴스의 own property이므로
      // open을 감싸서 주입한다. fd는 실제로 닫은 뒤 오류를 던진다 — close가
      // 오류를 보고하지만 디스크립터는 해제된 현실적인 상황이다.
      const realOpen = fs.open;
      jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
        const handle = await (realOpen as typeof fs.open)(...args);
        const realClose = handle.close.bind(handle);
        handle.close = async (): Promise<void> => {
          await realClose();
          throw new Error('close 실패');
        };
        return handle;
      });

      await expect(
        store.mutate((draft) => {
          draft.jobs.push(makeJob());
        }),
      ).rejects.toThrow('close 실패');

      const files = await listDir(dir);
      expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(diskBefore);
      expect(store.snapshot().jobs).toHaveLength(0);
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
