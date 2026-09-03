/**
 * REST API e2e 테스트. SPEC.md §3, §4([LOG-003]), [LOCK-008]
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApiApp } from '../src/contracts/factories';
import { AppConfig } from '../src/contracts/config';
import { promises as fs } from 'fs';
import {
  fileExists,
  hex64,
  jobLockPath,
  jobsJsonPath,
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
  ISO_UTC_RE,
  writeGlobalLock,
  writeJobLock,
} from './helpers/test-utils';

describe('Queue API (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  let config: AppConfig;
  let clock: ManualClock;

  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    dir = await mkStorageDir();
    config = testConfig(dir);
    clock = new ManualClock();
    app = await createApiApp({ config, clock });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    await rmDir(dir);
  });

  describe('[API-001][API-002] 공통 응답 형식', () => {
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
      const res = await http()
        .post('/jobs')
        .send({ title: 't', description: 'd' })
        .expect(201);
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

    it('[API-003] 정의되지 않은 필드는 거부한다(400)', async () => {
      await http()
        .post('/jobs')
        .send({ title: 't', description: 'd', status: 'done' })
        .expect(400);
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
      await http()
        .post('/jobs')
        .send({ title: ' ' + 'a'.repeat(1000), description: 'd' })
        .expect(201);
    });
  });

  describe('[API-020] GET /jobs', () => {
    it('빈 목록도 200 + list: []', async () => {
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

      const res = await http().get('/jobs').expect(200);
      expect(res.body.list.map((j: { id: string }) => j.id)).toEqual([c.id, b.id, a.id]);
    });
  });

  describe('[API-030][API-031][API-032] GET /jobs/search', () => {
    beforeEach(async () => {
      await seedJobs(dir, [
        makeJob({ id: '00000000-0000-4000-8000-00000000000a', title: 'Alpha Report', description: 'first doc', status: 'create' }),
        makeJob({ id: '00000000-0000-4000-8000-00000000000b', title: 'alpha summary', description: 'second doc', status: 'done' }),
        makeJob({ id: '00000000-0000-4000-8000-00000000000c', title: 'Beta Report', description: 'third doc', status: 'pending' }),
      ]);
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

    it('[API-030] 빈 title + 유효 status 조합은 status만 적용된다', async () => {
      const res = await http().get('/jobs/search?title=&status=pending').expect(200);
      expect(res.body.list).toHaveLength(1);
      expect(res.body.list[0].title).toBe('Beta Report');
    });

    it('잘못된 status 값은 400', async () => {
      const res = await http().get('/jobs/search?status=unknown').expect(400);
      expect(res.body.status).toBe(400);
    });

    it('[API-031] status는 trim 후 비교한다', async () => {
      const res = await http().get('/jobs/search?status=%20done%20').expect(200);
      expect(res.body.list).toHaveLength(1);
    });
  });

  describe('[API-040] GET /jobs/:id', () => {
    it('존재하는 job: 200 + job 필드', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);
      const res = await http().get(`/jobs/${job.id}`).expect(200);
      expect(res.body.result).toBe('success');
      expect(res.body.job.id).toBe(job.id);
    });

    it('존재하지 않는 job: 404 + 메시지', async () => {
      const res = await http()
        .get('/jobs/00000000-0000-4000-8000-0000000000ff')
        .expect(404);
      expect(res.body.status).toBe(404);
      expect(res.body.result).toBe('존재하지 않는 데이터입니다.');
    });

    it('UUID 형식이 아니면 400', async () => {
      const res = await http().get('/jobs/not-a-uuid').expect(400);
      expect(res.body.status).toBe(400);
    });
  });

  describe('[API-050]~[API-053] PATCH /jobs/:id', () => {
    it('create 상태 job 수정: 200 + 갱신된 job + updatedAt 갱신', async () => {
      const job = makeJob({ status: 'create', updatedAt: '2026-09-01T00:00:00.000Z' });
      await seedJobs(dir, [job]);

      const res = await http()
        .patch(`/jobs/${job.id}`)
        .send({ title: 'updated title' })
        .expect(200);

      expect(res.body.result).toBe('success');
      expect(res.body.job.title).toBe('updated title');
      expect(res.body.job.description).toBe(job.description);
      expect(res.body.job.updatedAt).not.toBe(job.updatedAt);

      const file = await readJobsFile(dir);
      expect(file.jobs.find((j) => j.id === job.id)?.title).toBe('updated title');
    });

    it('[API-050] 빈 본문(수정 필드 없음)은 400', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await http().patch(`/jobs/${job.id}`).send({}).expect(400);
    });

    it('[API-050] status 등 허용되지 않은 필드는 400', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await http().patch(`/jobs/${job.id}`).send({ status: 'done' }).expect(400);
    });

    it('존재하지 않는 job: 404', async () => {
      const res = await http()
        .patch('/jobs/00000000-0000-4000-8000-0000000000ff')
        .send({ title: 'x' })
        .expect(404);
      expect(res.body.result).toBe('존재하지 않는 데이터입니다.');
    });

    it('[API-040] UUID 형식이 아니면 400 (PATCH에도 적용)', async () => {
      await http().patch('/jobs/not-a-uuid').send({ title: 'x' }).expect(400);
    });

    it('pending 상태: 409 + 처리중 메시지', async () => {
      const job = makeJob({ status: 'pending' });
      await seedJobs(dir, [job]);
      const res = await http().patch(`/jobs/${job.id}`).send({ title: 'x' }).expect(409);
      expect(res.body.result).toBe('처리중인 프로세스입니다.');
    });

    it('[API-051] create 상태여도 per-job lock 파일이 있으면 409 처리중', async () => {
      const job = makeJob({ status: 'create' });
      await seedJobs(dir, [job]);
      await writeJobLock(dir, job.id, { preemption: hex64('w1'), preemptedAt: clock.iso() });
      const res = await http().patch(`/jobs/${job.id}`).send({ title: 'x' }).expect(409);
      expect(res.body.result).toBe('처리중인 프로세스입니다.');
    });

    it('done 상태: 409 + 완료 메시지', async () => {
      const job = makeJob({ status: 'done' });
      await seedJobs(dir, [job]);
      const res = await http().patch(`/jobs/${job.id}`).send({ title: 'x' }).expect(409);
      expect(res.body.result).toBe('이미 완료된 프로세스입니다.');
    });

    it('[API-053] done + lock 파일 동시 존재 시 완료 메시지가 우선한다', async () => {
      const job = makeJob({ status: 'done' });
      await seedJobs(dir, [job]);
      await writeJobLock(dir, job.id, { preemption: hex64('w1'), preemptedAt: clock.iso() });
      const res = await http().patch(`/jobs/${job.id}`).send({ title: 'x' }).expect(409);
      expect(res.body.result).toBe('이미 완료된 프로세스입니다.');
    });

    it('[API-053] validation 실패(400)는 상태 충돌(409)보다 우선한다', async () => {
      const job = makeJob({ status: 'done' });
      await seedJobs(dir, [job]);
      await http().patch(`/jobs/${job.id}`).send({ title: '' }).expect(400);
    });
  });

  describe('[LOCK-008] global lock 대기 초과', () => {
    it('신선한(비-stale) global lock이 유지되면 API는 503을 반환한다', async () => {
      await writeGlobalLock(dir, {
        preemption: hex64('holder'),
        ownerType: 'api',
        preemptedAt: clock.iso(), // 주입 시계 기준 신선한 lock: stale 판정([LOCK-009]) 방지
      });
      const res = await http()
        .post('/jobs')
        .send({ title: 't', description: 'd' })
        .expect(503);
      expect(res.body.status).toBe(503);
    });
  });

  describe('[LOG-003] HTTP 요청 로깅', () => {
    it('성공/실패 요청 모두 logs.txt에 형식에 맞게 기록된다', async () => {
      await http().post('/jobs').send({ title: 't', description: 'd' }).expect(201);
      await http().get('/jobs/not-a-uuid').expect(400);

      const lines = await readLogLines(config.logFilePath);
      const httpLines = lines.filter((l) => l.includes('[http]'));
      expect(httpLines.length).toBeGreaterThanOrEqual(2);
      for (const line of httpLines) {
        expect(line).toMatch(LOG_LINE_RE);
      }
      expect(httpLines.some((l) => l.includes('POST /jobs') && l.includes('201'))).toBe(true);
      expect(httpLines.some((l) => l.includes('GET /jobs/not-a-uuid') && l.includes('400'))).toBe(true);
    });

    it('query string도 로깅에 포함된다', async () => {
      await http().get('/jobs/search?title=abc').expect(200);
      const lines = await readLogLines(config.logFilePath);
      expect(lines.some((l) => l.includes('/jobs/search?title=abc'))).toBe(true);
    });
  });

  describe('[RUN-004] 부트스트랩', () => {
    it('앱 기동 시 jobs.json이 기본 스키마로 생성된다', async () => {
      const file = await readJobsFile(dir);
      expect(file.jobs).toEqual([]);
      expect(file.workers).toEqual({});
      expect(file.reaper).toEqual({ workerId: null, lastGlobalLockReapAt: null });
    });
  });

  describe('부수 효과 없음', () => {
    it('조회 계열 요청은 job lock 파일을 남기지 않는다', async () => {
      const job = makeJob();
      await seedJobs(dir, [job]);
      await http().get('/jobs').expect(200);
      await http().get(`/jobs/${job.id}`).expect(200);
      expect(await fileExists(jobLockPath(dir, job.id))).toBe(false);
    });
  });
});
