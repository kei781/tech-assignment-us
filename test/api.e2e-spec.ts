import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppConfig } from '../src/common/config';
import { AppLogger } from '../src/common/logger';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsFileLoadError } from '../src/jobs/jobs.store';
import { createTestApp } from './helpers/app-factory';
import {
  ISO_UTC_RE,
  LOG_LINE_RE,
  makeJob,
  ManualClock,
  mkStorageDir,
  readJobsFile,
  readLogLines,
  rmDir,
  seedJobs,
  testConfig,
  UUID_V4_RE,
  writeRawJobsFile,
} from './helpers/test-utils';

describe('Jobs API (e2e)', () => {
  let app: INestApplication;
  let service: JobsService;
  let logger: AppLogger;
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;

  const http = () => request(app.getHttpServer());

  /** seed 이후에 기동해야 하므로 beforeEach가 아니라 각 테스트가 호출한다. */
  const boot = async (): Promise<void> => {
    ({ app, service, logger } = await createTestApp({ config, clock }));
  };

  beforeEach(async () => {
    dir = await mkStorageDir();
    config = testConfig(dir);
    clock = new ManualClock();
  });

  afterEach(async () => {
    await app?.close();
    await rmDir(dir);
  });

  describe('[API-001][API-002] 공통 응답 형식', () => {
    beforeEach(boot);

    it('성공 응답은 status(HTTP 코드 미러링)와 result: success를 포함한다', async () => {
      const res = await http().get('/jobs').expect(200);
      expect(res.body.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(Array.isArray(res.body.list)).toBe(true);
    });

    it('에러 응답도 동일 형식을 유지하며 status가 HTTP 코드와 일치한다', async () => {
      const res = await http().post('/jobs').send({}).expect(400);
      expect(res.body.status).toBe(400);
      expect(typeof res.body.result).toBe('string');
      expect(res.body.result).not.toBe('success');
    });
  });

  describe('[API-010][API-011][API-012] POST /jobs', () => {
    beforeEach(boot);

    it('유효한 요청이면 201과 생성된 job을 반환한다', async () => {
      const res = await http()
        .post('/jobs')
        .send({ title: 'my title', description: 'my description' })
        .expect(201);

      expect(res.body.status).toBe(201);
      expect(res.body.result).toBe('success');
      const job = res.body.job;
      expect(job.id).toMatch(UUID_V4_RE);
      expect(job.title).toBe('my title');
      expect(job.description).toBe('my description');
      expect(job.status).toBe('create');
      expect(job.createdAt).toMatch(ISO_UTC_RE);
      expect(job.updatedAt).toMatch(ISO_UTC_RE);
    });

    it('생성된 job은 jobs.json에 영속화된다', async () => {
      const res = await http().post('/jobs').send({ title: 't', description: 'd' }).expect(201);
      const file = await readJobsFile(dir);
      expect(file.jobs.some((j) => j.id === res.body.job.id)).toBe(true);
    });

    it.each([
      ['title 누락', { description: 'd' }],
      ['description 누락', { title: 't' }],
      ['title 타입 오류', { title: 123, description: 'd' }],
      ['title 길이 초과(1001자)', { title: 'a'.repeat(1001), description: 'd' }],
      ['description 길이 초과(2001자)', { title: 't', description: 'a'.repeat(2001) }],
      ['title 공백만(trim 후 0자)', { title: '   ', description: 'd' }],
    ])('[DATA-002][API-003] validation 실패(%s)면 400', async (_name, body) => {
      const res = await http().post('/jobs').send(body).expect(400);
      expect(res.body.status).toBe(400);
    });

    it('[API-003][STATE-002] 정의되지 않은 필드(status)는 거부한다', async () => {
      await http().post('/jobs').send({ title: 't', description: 'd', status: 'done' }).expect(400);
      const file = await readJobsFile(dir);
      expect(file.jobs).toHaveLength(0);
    });

    it('[DATA-002] title/description은 trim되어 저장된다', async () => {
      const res = await http()
        .post('/jobs')
        .send({ title: '  padded  ', description: '  padded desc  ' })
        .expect(201);
      expect(res.body.job.title).toBe('padded');
      expect(res.body.job.description).toBe('padded desc');
    });

    it('[DATA-002] 길이 제한은 trim 후 기준이다(앞뒤 공백 포함 1001자는 통과)', async () => {
      const padded = ' ' + 'a'.repeat(1000);
      await http().post('/jobs').send({ title: padded, description: 'd' }).expect(201);
    });
  });

  describe('[API-020] GET /jobs', () => {
    it('빈 목록도 200 + list: []', async () => {
      await boot();
      const res = await http().get('/jobs').expect(200);
      expect(res.body.list).toEqual([]);
    });

    it('전체 목록을 createdAt ASC, 동률 시 id ASC로 반환한다', async () => {
      const t1 = '2026-09-01T00:00:00.000Z';
      const t2 = '2026-09-02T00:00:00.000Z';
      const a = makeJob({ id: '00000000-0000-4000-8000-000000000002', createdAt: t2 });
      const b = makeJob({ id: '00000000-0000-4000-8000-000000000001', createdAt: t1 });
      const c = makeJob({ id: '00000000-0000-4000-8000-000000000000', createdAt: t1 });
      await seedJobs(dir, [a, b, c]);
      await boot();

      const res = await http().get('/jobs').expect(200);
      expect(res.body.list.map((j: { id: string }) => j.id)).toEqual([c.id, b.id, a.id]);
    });
  });

  describe('[API-030][API-031][API-032] GET /jobs/search', () => {
    beforeEach(async () => {
      // 기동 복구가 pending을 create로 되돌리므로 fixture는 create/done만 둔다.
      // pending 검색은 기동 후 선점으로 만든다.
      await seedJobs(dir, [
        makeJob({
          id: '00000000-0000-4000-8000-00000000000a',
          title: 'Alpha Report',
          description: 'first doc',
          status: 'create',
          createdAt: '2026-09-01T00:00:00.000Z',
        }),
        makeJob({
          id: '00000000-0000-4000-8000-00000000000b',
          title: 'alpha summary',
          description: 'second doc',
          status: 'done',
          createdAt: '2026-09-01T00:00:01.000Z',
        }),
        makeJob({
          id: '00000000-0000-4000-8000-00000000000c',
          title: 'Beta Report',
          description: 'third doc',
          status: 'create',
          createdAt: '2026-09-01T00:00:02.000Z',
        }),
      ]);
      await boot();
    });

    it('[API-005] /jobs/search가 /jobs/:id보다 먼저 매칭된다(search가 UUID 검증에 걸리지 않음)', async () => {
      const res = await http().get('/jobs/search?title=alpha').expect(200);
      expect(res.body.result).toBe('success');
    });

    it('title: 대소문자 무시 부분 일치', async () => {
      const res = await http().get('/jobs/search?title=ALPHA').expect(200);
      expect(res.body.list).toHaveLength(2);
    });

    it('description: 대소문자 무시 부분 일치', async () => {
      const res = await http().get('/jobs/search?description=THIRD').expect(200);
      expect(res.body.list).toHaveLength(1);
      expect(res.body.list[0].title).toBe('Beta Report');
    });

    it('status: 정확 일치', async () => {
      const res = await http().get('/jobs/search?status=done').expect(200);
      expect(res.body.list).toHaveLength(1);
      expect(res.body.list[0].title).toBe('alpha summary');
    });

    it('status: 선점 직후 pending으로도 검색된다', async () => {
      await service.claimNext();
      const res = await http().get('/jobs/search?status=pending').expect(200);
      expect(res.body.list).toHaveLength(1);
      expect(res.body.list[0].title).toBe('Alpha Report');
    });

    it('복수 조건은 AND 결합', async () => {
      const res = await http().get('/jobs/search?title=alpha&status=create').expect(200);
      expect(res.body.list).toHaveLength(1);
      expect(res.body.list[0].title).toBe('Alpha Report');
    });

    it('결과 목록은 [API-020]과 동일 정렬', async () => {
      const res = await http().get('/jobs/search?title=report').expect(200);
      const ids = res.body.list.map((j: { id: string }) => j.id);
      expect(ids).toEqual([...ids].sort());
    });

    it('검색 결과 없음: 200 + 사유 메시지 + list: []', async () => {
      const res = await http().get('/jobs/search?title=nomatch').expect(200);
      expect(res.body.status).toBe(200);
      expect(res.body.result).toBe('데이터가 존재하지 않습니다.');
      expect(res.body.list).toEqual([]);
    });

    it('조건 전부 미입력: 400 + 안내 메시지', async () => {
      const res = await http().get('/jobs/search').expect(400);
      expect(res.body.result).toBe('title, description, status 중 하나 이상을 입력하여 주세요.');
    });

    it('[API-030] trim 후 빈 문자열 파라미터는 미입력으로 간주한다', async () => {
      const res = await http().get('/jobs/search?title=%20%20').expect(400);
      expect(res.body.result).toBe('title, description, status 중 하나 이상을 입력하여 주세요.');
    });

    it('[API-030] `?status=` 단독은 전부 미입력과 동일해 400 (enum validation을 타지 않는다)', async () => {
      const res = await http().get('/jobs/search?status=').expect(400);
      expect(res.body.result).toBe('title, description, status 중 하나 이상을 입력하여 주세요.');
    });

    it('[API-030] 빈 title + 유효 status 조합은 status만 적용된다', async () => {
      const res = await http().get('/jobs/search?title=&status=done').expect(200);
      expect(res.body.list).toHaveLength(1);
      expect(res.body.list[0].title).toBe('alpha summary');
    });

    it('[API-030] 정규화 후 남은 status가 enum이 아니면 400', async () => {
      const res = await http().get('/jobs/search?status=unknown').expect(400);
      expect(res.body.status).toBe(400);
    });

    it('[API-031] status는 trim 후 비교한다', async () => {
      const res = await http().get('/jobs/search?status=%20done%20').expect(200);
      expect(res.body.list).toHaveLength(1);
    });

    it('[API-003] 정의되지 않은 query parameter는 400', async () => {
      await http().get('/jobs/search?title=alpha&unknown=1').expect(400);
    });
  });

  describe('[API-040] GET /jobs/:id', () => {
    it('존재하는 job: 200 + job 필드', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);
      await boot();
      const res = await http().get('/jobs/' + job.id).expect(200);
      expect(res.body.result).toBe('success');
      expect(res.body.job.id).toBe(job.id);
    });

    it('존재하지 않는 job: 404 + 메시지', async () => {
      await boot();
      const res = await http().get('/jobs/00000000-0000-4000-8000-0000000000ff').expect(404);
      expect(res.body.status).toBe(404);
      expect(res.body.result).toBe('존재하지 않는 데이터입니다.');
    });

    it('UUID 형식이 아니면 400', async () => {
      await boot();
      const res = await http().get('/jobs/not-a-uuid').expect(400);
      expect(res.body.status).toBe(400);
      expect(res.body.result).toBe('id는 UUID 형식이어야 합니다.');
    });
  });

  describe('[API-050]~[API-053] PATCH /jobs/:id', () => {
    it('[API-051] create 상태 job 수정: 200 + 갱신된 job + updatedAt 갱신', async () => {
      const job = makeJob({ status: 'create', updatedAt: '2026-09-01T00:00:00.000Z' });
      await seedJobs(dir, [job]);
      await boot();

      const res = await http()
        .patch('/jobs/' + job.id)
        .send({ title: 'updated title' })
        .expect(200);

      expect(res.body.result).toBe('success');
      expect(res.body.job.title).toBe('updated title');
      expect(res.body.job.description).toBe(job.description);
      expect(res.body.job.updatedAt).not.toBe(job.updatedAt);

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.title).toBe('updated title');
    });

    it('[API-052] description만 보내도 title은 유지된다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      const res = await http()
        .patch('/jobs/' + job.id)
        .send({ description: 'new desc' })
        .expect(200);
      expect(res.body.job.title).toBe(job.title);
      expect(res.body.job.description).toBe('new desc');
    });

    it('[API-050] 빈 본문(수정 필드 없음)은 400', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();
      const res = await http()
        .patch('/jobs/' + job.id)
        .send({})
        .expect(400);
      expect(res.body.result).toBe('title, description 중 하나 이상을 입력하여 주세요.');
    });

    it('[API-050][STATE-002] status 필드 수정은 거부되고 상태도 그대로다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();
      await http()
        .patch('/jobs/' + job.id)
        .send({ status: 'done' })
        .expect(400);

      const file = await readJobsFile(dir);
      expect(file.jobs[0].status).toBe('create');
    });

    it('존재하지 않는 job: 404', async () => {
      await boot();
      const res = await http()
        .patch('/jobs/00000000-0000-4000-8000-0000000000ff')
        .send({ title: 'x' })
        .expect(404);
      expect(res.body.result).toBe('존재하지 않는 데이터입니다.');
    });

    it('[API-040] UUID 형식이 아니면 400 (PATCH에도 적용)', async () => {
      await boot();
      await http().patch('/jobs/not-a-uuid').send({ title: 'x' }).expect(400);
    });

    it('[API-051][CON-005] pending(처리 중) 상태: 409 + 처리중 메시지, 내용 불변', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      const claimed = await service.claimNext();
      expect(claimed?.status).toBe('pending');

      const res = await http()
        .patch('/jobs/' + job.id)
        .send({ title: 'x' })
        .expect(409);
      expect(res.body.result).toBe('처리중인 프로세스입니다.');

      const file = await readJobsFile(dir);
      expect(file.jobs[0].title).toBe(job.title);
    });

    it('done 상태: 409 + 완료 메시지', async () => {
      const job = makeJob({ status: 'done' });
      await seedJobs(dir, [job]);
      await boot();
      const res = await http()
        .patch('/jobs/' + job.id)
        .send({ title: 'x' })
        .expect(409);
      expect(res.body.result).toBe('이미 완료된 프로세스입니다.');
    });

    it('[API-053] validation 실패(400)는 상태 충돌(409)보다 우선한다', async () => {
      const job = makeJob({ status: 'done' });
      await seedJobs(dir, [job]);
      await boot();
      await http()
        .patch('/jobs/' + job.id)
        .send({ title: '' })
        .expect(400);
    });
  });

  describe('[LOG-003] HTTP 요청 로깅', () => {
    beforeEach(boot);

    it('성공/실패 요청 모두 logs.txt에 형식에 맞게 기록된다', async () => {
      await http().post('/jobs').send({ title: 't', description: 'd' }).expect(201);
      await http().get('/jobs/not-a-uuid').expect(400);
      await logger.flush();

      const lines = await readLogLines(config.logFilePath);
      const httpLines = lines.filter((line) => line.includes('[http]'));

      expect(httpLines.length).toBeGreaterThanOrEqual(2);
      for (const line of httpLines) {
        expect(line).toMatch(LOG_LINE_RE);
      }
      expect(httpLines.some((l) => l.includes('POST /jobs') && l.includes('201'))).toBe(true);
      expect(httpLines.some((l) => l.includes('GET /jobs/not-a-uuid') && l.includes('400'))).toBe(
        true,
      );
    });

    it('query string과 처리 시간(ms)이 로깅에 포함된다', async () => {
      await http().get('/jobs/search?title=abc').expect(200);
      await logger.flush();

      const lines = await readLogLines(config.logFilePath);
      const line = lines.find((l) => l.includes('/jobs/search?title=abc'));
      expect(line).toBeDefined();
      expect(line).toMatch(/GET \/jobs\/search\?title=abc 200 \d+ms$/);
    });

    it('라우트에 매칭되지 않는 요청도 로깅된다', async () => {
      await http().get('/unknown-route').expect(404);
      await logger.flush();

      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('GET /unknown-route') && l.includes('404'))).toBe(true);
    });
  });

  describe('[RUN-004] 부트스트랩', () => {
    it('[DATA-001] 앱 기동 시 jobs.json이 최상위 jobs 키만 가진 기본 스키마로 생성된다', async () => {
      await boot();
      const file = await readJobsFile(dir);
      expect(file.jobs).toEqual([]);
      expect(Object.keys(file)).toEqual(['jobs']);
    });

    it('손상된 jobs.json으로는 앱 기동이 실패한다 (자동 초기화하지 않음)', async () => {
      await writeRawJobsFile(dir, '{ "jobs": [ broken');

      const created = await createTestApp({ config, clock, skipInit: true });
      app = created.app;

      await expect(app.init()).rejects.toThrow(JobsFileLoadError);
    });
  });

  /**
   * DTO와 로더가 길이·공백을 다르게 판정하면, 성공한 POST가 재시작 불능 파일을
   * 만든다. 두 경계가 같은 정의를 쓰는지 실제 왕복으로 확인한다.
   */
  describe('[RUN-006][TST-006] API가 저장한 데이터는 재기동 시 다시 로드된다', () => {
    /** 재기동을 모사한다 — 같은 파일에 새 앱을 띄운다. */
    const restart = async (): Promise<void> => {
      await app.close();
      ({ app, service, logger } = await createTestApp({ config, clock }));
    };

    it.each([
      ['ASCII', 'a'.repeat(1000), 'b'.repeat(2000)],
      // 코드포인트 1개가 UTF-16 2칸을 쓰므로, 두 정의가 어긋나면 여기서 갈린다.
      ['단일 코드포인트 이모지', '😀'.repeat(1000), '🎉'.repeat(2000)],
      // ❤️는 하트 + variation selector로 2 코드포인트다. class-validator의
      // @MaxLength는 variation selector를 따로 빼서 1로 세므로, DTO가 그쪽에
      // 의존하면 여기서 어긋난다. 두 경계가 같은 함수를 쓰는지 확인한다.
      ['조합 이모지', '❤️'.repeat(500), '❤️'.repeat(1000)],
      ['한글', '가'.repeat(1000), '나'.repeat(2000)],
    ])('%s 최대 길이로 생성한 Job이 재기동 후에도 남아 있다', async (_name, title, description) => {
      await boot();

      const created = await http().post('/jobs').send({ title, description }).expect(201);
      const id = created.body.job.id;

      await restart();

      const found = await http().get('/jobs/' + id).expect(200);
      expect(found.body.job.title).toBe(title);
      expect(found.body.job.description).toBe(description);
    });

    it('DTO가 거부하는 길이는 로더 기준도 초과한다 (경계가 어긋나지 않는다)', async () => {
      await boot();

      await http()
        .post('/jobs')
        .send({ title: '😀'.repeat(1001), description: 'd' })
        .expect(400);
      await http()
        .post('/jobs')
        .send({ title: 't', description: '🎉'.repeat(2001) })
        .expect(400);
      // 조합 이모지도 코드포인트 기준으로 거부되어야 한다 (❤️ 501개 = 1,002 코드포인트).
      await http()
        .post('/jobs')
        .send({ title: '❤️'.repeat(501), description: 'd' })
        .expect(400);

      expect((await readJobsFile(dir)).jobs).toHaveLength(0);
    });

    it('공백이 섞인 입력도 trim되어 저장되므로 재기동을 막지 않는다', async () => {
      await boot();

      const created = await http()
        .post('/jobs')
        .send({ title: '  제목  ', description: '  설명  ' })
        .expect(201);

      await restart();

      const found = await http().get('/jobs/' + created.body.job.id).expect(200);
      expect(found.body.job.title).toBe('제목');
    });

    it('PATCH로 최대 길이까지 수정한 Job도 재기동 후 로드된다', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await boot();

      const title = '😀'.repeat(1000);
      await http()
        .patch('/jobs/' + job.id)
        .send({ title })
        .expect(200);

      await restart();

      const found = await http().get('/jobs/' + job.id).expect(200);
      expect(found.body.job.title).toBe(title);
    });
  });

  describe('[CON-004] 조회는 부수 효과가 없다', () => {
    it('조회 계열 요청은 jobs.json을 변경하지 않는다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);
      await boot();

      const before = await readJobsFile(dir);
      await http().get('/jobs').expect(200);
      await http().get('/jobs/' + job.id).expect(200);
      await http().get('/jobs/search?title=job').expect(200);
      const after = await readJobsFile(dir);

      expect(after).toEqual(before);
    });
  });
});
