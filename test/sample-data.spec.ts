/**
 * `data/jobs.json`은 과제 제출 요건("조회 동작 확인용 샘플 데이터")이면서
 * **앱이 실행 중에 덮어쓰는 파일**이다. 기본 설정으로 한 번 띄우기만 해도
 * 모든 Job이 done으로 바뀌므로, 시연 후 무심코 커밋하면 3상태를 보여준다는
 * 샘플의 목적이 사라진다. 이 스위트가 그 회귀를 커밋 전에 잡는다.
 *
 * 기대값을 운영 코드에서 가져오지 않고 여기에 직접 적어 둔다. `JOB_STATUSES`를
 * 그대로 순회하면, 운영 코드와 fixture가 같이 잘못됐을 때 테스트도 함께
 * 녹색이 되어 가드가 oracle 역할을 못 한다.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { JOB_STATUSES, JobsFile } from '../src/jobs/jobs.types';
import { ISO_UTC_RE, UUID_V4_RE } from './helpers/test-utils';

// cwd에 의존하지 않도록 이 파일 기준으로 저장소 루트를 찾는다.
const SAMPLE_PATH = path.join(__dirname, '..', 'data', 'jobs.json');

const EXPECTED_STATUSES = ['create', 'pending', 'done'] as const;

const EXPECTED_JOB_KEYS = [
  'createdAt',
  'description',
  'id',
  'status',
  'title',
  'updatedAt',
] as const;

describe('[DATA-004] 커밋된 샘플 데이터 (data/jobs.json)', () => {
  let raw: string;
  let file: JobsFile;

  beforeAll(async () => {
    raw = await fs.readFile(SAMPLE_PATH, 'utf8');
    file = JSON.parse(raw) as JobsFile;
  });

  it('파싱 가능한 JSON이다', () => {
    expect(file).toBeDefined();
  });

  it('[DATA-001] 최상위 키는 jobs 하나다', () => {
    expect(Object.keys(file)).toEqual(['jobs']);
    expect(Array.isArray(file.jobs)).toBe(true);
  });

  it('조회 동작을 확인할 수 있도록 1건 이상 들어 있다', () => {
    expect(file.jobs.length).toBeGreaterThan(0);
  });

  /** 운영 코드의 상태 집합 자체가 명세와 어긋나는 회귀를 잡는다. */
  it('[STATE-001] 운영 코드의 상태 집합이 명세와 정확히 일치한다', () => {
    expect([...JOB_STATUSES]).toEqual([...EXPECTED_STATUSES]);
  });

  /**
   * 이것이 이 스위트의 핵심이다. 앱을 실행하면 create → pending → done으로
   * 전이하므로, 실행 후 상태가 커밋되면 이 단언이 깨진다.
   */
  it.each(EXPECTED_STATUSES)('%s 상태를 최소 1건 포함한다', (status) => {
    const matching = file.jobs.filter((job) => job.status === status);
    expect(matching.length).toBeGreaterThanOrEqual(1);
  });

  it('앱 실행으로 오염되지 않았다 (모든 Job이 done인 상태가 아니다)', () => {
    const allDone = file.jobs.every((job) => job.status === 'done');
    expect(allDone).toBe(false);
  });

  it('[DATA-002] 모든 Job이 필드 규칙을 만족한다', () => {
    for (const job of file.jobs) {
      expect(job.id).toMatch(UUID_V4_RE);

      expect(typeof job.title).toBe('string');
      expect(job.title).toBe(job.title.trim());
      expect(job.title.length).toBeGreaterThanOrEqual(1);
      expect(job.title.length).toBeLessThanOrEqual(1000);

      expect(typeof job.description).toBe('string');
      expect(job.description).toBe(job.description.trim());
      expect(job.description.length).toBeGreaterThanOrEqual(1);
      expect(job.description.length).toBeLessThanOrEqual(2000);

      expect(EXPECTED_STATUSES).toContain(job.status);

      expect(job.createdAt).toMatch(ISO_UTC_RE);
      expect(job.updatedAt).toMatch(ISO_UTC_RE);
      expect(new Date(job.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(job.createdAt).getTime(),
      );

      expect(Object.keys(job).sort()).toEqual([...EXPECTED_JOB_KEYS]);
    }
  });

  it('[DATA-002] id는 PK이므로 중복이 없다', () => {
    const ids = file.jobs.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
