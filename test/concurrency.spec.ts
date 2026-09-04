/**
 * 동시성 시나리오. SPEC [TST-003]
 *
 * 과제 요구사항 5번("API 요청과 스케줄러가 동시에 같은 데이터에 접근하는 환경에서
 * 데이터가 손실되거나 깨지지 않게 하라")에 대한 답을 8개 케이스로 고정한다.
 */
import { INestApplication } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import request from 'supertest';
import { AppConfig } from '../src/common/config';
import { AppLogger } from '../src/common/logger';
import { JobsProcessor } from '../src/jobs/jobs.processor';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsStore } from '../src/jobs/jobs.store';
import { ControllableTask, createTestApp } from './helpers/app-factory';
import {
  jobsJsonPath,
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

describe('[TST-003] 동시성 시나리오', () => {
  let app: INestApplication;
  let processor: JobsProcessor;
  let service: JobsService;
  let store: JobsStore;
  let logger: AppLogger;
  let task: ControllableTask;
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;

  const http = () => request(app.getHttpServer());

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
    jest.restoreAllMocks();
    task.unblock();
    await app?.close();
    await rmDir(dir);
  });

  it('1. 처리 중(pending)인 Job에 PATCH → 409, 내용 불변', async () => {
    const job = makeJob({ status: 'create', title: 'original', description: 'original desc' });
    await seedJobs(dir, [job]);
    await boot();

    task.block();
    const tick = processor.tickOnce();
    await waitFor(() => task.started.length === 1);
    expect(statusOf(job.id)).toBe('pending');

    const res = await http()
      .patch('/jobs/' + job.id)
      .send({ title: 'hijacked', description: 'hijacked desc' })
      .expect(409);
    expect(res.body.result).toBe('처리중인 프로세스입니다.');

    const stored = (await readJobsFile(dir)).jobs[0];
    expect(stored.title).toBe('original');
    expect(stored.description).toBe('original desc');

    task.unblock();
    await tick;
  });

  it('2. done Job에 PATCH → 409 이미 완료된 프로세스입니다.', async () => {
    const job = makeJob({ status: 'create' });
    await seedJobs(dir, [job]);
    await boot();

    await processor.tickOnce();
    expect(statusOf(job.id)).toBe('done');

    const res = await http()
      .patch('/jobs/' + job.id)
      .send({ title: 'x' })
      .expect(409);
    expect(res.body.result).toBe('이미 완료된 프로세스입니다.');
  });

  describe('3. 수정과 선점을 동시에 시작 → 수정이 소실된 채 pending이 되는 결과는 없다', () => {
    /**
     * [CON-002] mutex는 호출 순서대로 실행을 직렬화한다(promise chain에 동기 등록).
     * 따라서 두 순서를 각각 결정적으로 재현할 수 있다 — 확률에 기대지 않는다.
     */
    it('(a) 수정이 먼저 큐에 들어가면: 수정 성공 후 선점 — 수정 내용이 남는다', async () => {
      const job = makeJob({ status: 'create', title: 'original' });
      await seedJobs(dir, [job]);
      await boot();

      // update를 먼저 호출해 mutex 큐 앞자리를 잡는다.
      const updating = service.update(job.id, { title: 'updated' });
      const claiming = service.claimNext();

      const [updated, claimed] = await Promise.all([updating, claiming]);

      expect(updated.title).toBe('updated');
      expect(claimed?.id).toBe(job.id);

      const stored = (await readJobsFile(dir)).jobs[0];
      // 선점이 뒤따랐지만 수정 내용은 소실되지 않았다.
      expect(stored.status).toBe('pending');
      expect(stored.title).toBe('updated');
    });

    it('(b) 선점이 먼저 큐에 들어가면: 수정은 409로 거부되고 원본이 유지된다', async () => {
      const job = makeJob({ status: 'create', title: 'original' });
      await seedJobs(dir, [job]);
      await boot();

      const claiming = service.claimNext();
      const updating = service.update(job.id, { title: 'updated' });

      await expect(claiming).resolves.toMatchObject({ status: 'pending' });
      await expect(updating).rejects.toThrow('처리중인 프로세스입니다.');

      const stored = (await readJobsFile(dir)).jobs[0];
      expect(stored.status).toBe('pending');
      expect(stored.title).toBe('original');
    });

    it('(c) HTTP PATCH와 선점을 동시에 출발시켜도 불변식이 성립한다', async () => {
      const job = makeJob({ status: 'create', title: 'original' });
      await seedJobs(dir, [job]);
      await boot();

      const patching = http()
        .patch('/jobs/' + job.id)
        .send({ title: 'updated' });
      const claiming = service.claimNext();

      const [patchRes] = await Promise.all([patching, claiming]);
      const stored = (await readJobsFile(dir)).jobs[0];

      if (patchRes.status === 200) {
        expect(stored.title).toBe('updated');
      } else {
        expect(patchRes.status).toBe(409);
        expect(patchRes.body.result).toBe('처리중인 프로세스입니다.');
        expect(stored.title).toBe('original');
      }

      // 어느 순서든 "수정 성공 응답을 받았는데 그 내용이 사라진" 결과는 없다.
      const lostUpdate = patchRes.status === 200 && stored.title !== 'updated';
      expect(lostUpdate).toBe(false);
    });
  });

  it('4. 여러 POST를 동시에 발행 → 모든 Job이 jobs.json에 남는다 (lost update 없음)', async () => {
    await boot();

    const count = 30;
    const responses = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        http()
          .post('/jobs')
          .send({ title: 'concurrent ' + i, description: 'desc ' + i }),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    const ids = responses.map((r) => r.body.job.id);
    expect(new Set(ids).size).toBe(count);

    const file = await readJobsFile(dir);
    expect(file.jobs).toHaveLength(count);
    for (const id of ids) {
      expect(file.jobs.some((j) => j.id === id)).toBe(true);
    }
  });

  it('5. 스케줄러 처리 중에도 POST·GET이 정상 응답한다 (mutex를 처리 시간 동안 잡지 않는다)', async () => {
    const job = makeJob({ status: 'create' });
    await seedJobs(dir, [job]);
    await boot();

    task.block();
    const tick = processor.tickOnce();
    await waitFor(() => task.started.length === 1);

    // 처리가 진행되는 동안 요청을 보낸다.
    const created = await http()
      .post('/jobs')
      .send({ title: 'during processing', description: 'd' })
      .expect(201);
    const listed = await http().get('/jobs').expect(200);

    expect(listed.body.list).toHaveLength(2);
    expect(listed.body.list.some((j: { id: string }) => j.id === created.body.job.id)).toBe(true);

    task.unblock();
    await tick;

    expect(statusOf(job.id)).toBe('done');
  });

  it('6. 저장이 실패하도록 만든 뒤 POST → 500, 인메모리와 디스크 모두 변경 전', async () => {
    await boot();
    await http().post('/jobs').send({ title: 'first', description: 'd' }).expect(201);

    const diskBefore = await fs.readFile(jobsJsonPath(dir), 'utf8');
    const inMemoryBefore = store.snapshot();

    jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('디스크 오류'));

    const res = await http().post('/jobs').send({ title: 'second', description: 'd' }).expect(500);
    expect(res.body.status).toBe(500);

    expect(store.snapshot()).toEqual(inMemoryBefore);
    expect(await fs.readFile(jobsJsonPath(dir), 'utf8')).toBe(diskBefore);
  });

  it('7. pending Job이 남은 파일로 기동 → create 복구 + storage 로그', async () => {
    const stranded = makeJob({ status: 'pending', updatedAt: '2026-09-01T00:00:00.000Z' });
    await seedJobs(dir, [stranded]);

    await boot();

    expect(statusOf(stranded.id)).toBe('create');
    expect((await readJobsFile(dir)).jobs[0].status).toBe('create');

    await logger.flush();
    const lines = await readLogLines(config.logFilePath);
    const recovery = lines.find((l) => l.includes('[storage]') && l.includes('기동 복구'));
    expect(recovery).toBeDefined();
    expect(recovery).toContain('1건');
  });

  it('8. 처리 중 예외 → create 롤백, guard 해제로 다음 tick 정상 동작', async () => {
    const job = makeJob({ status: 'create' });
    await seedJobs(dir, [job]);
    await boot();

    task.failWith(new Error('처리 중 예외'));
    await processor.tickOnce();
    expect(statusOf(job.id)).toBe('create');

    task.clearFailure();
    await processor.tickOnce();

    expect(statusOf(job.id)).toBe('done');
    expect(task.started).toHaveLength(2);
  });
});
