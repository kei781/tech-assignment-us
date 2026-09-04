/**
 * `pending`은 "처리 대기"가 아니라 **스케줄러가 선점해 처리 중**을 뜻한다.
 * 과제 예시는 초기 상태를 pending으로 뒀지만, 대기와 처리 중을 구분해야
 * 처리 중인 Job의 수정을 막을 수 있어 create를 추가했다.
 */
export type JobStatus = 'create' | 'pending' | 'done';

export const JOB_STATUSES: readonly JobStatus[] = ['create', 'pending', 'done'];

export interface Job {
  id: string;
  title: string;
  description: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface JobsFile {
  jobs: Job[];
}

export function emptyJobsFile(): JobsFile {
  return { jobs: [] };
}

/**
 * createdAt이 같은 Job이 생길 수 있어 id를 2차 기준으로 둔다 — 그래야 목록
 * 순서와 선점 순서가 결정적이다. ISO 8601 UTC는 사전순 비교가 시간순과 일치한다.
 */
export function compareJobs(a: Job, b: Job): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export const MESSAGES = {
  success: 'success',
  notFound: '존재하지 않는 데이터입니다.',
  searchEmpty: '데이터가 존재하지 않습니다.',
  alreadyDone: '이미 완료된 프로세스입니다.',
  inProgress: '처리중인 프로세스입니다.',
  invalidId: 'id는 UUID 형식이어야 합니다.',
} as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const JOB_KEYS: readonly string[] = [
  'id',
  'title',
  'description',
  'status',
  'createdAt',
  'updatedAt',
];

export const TITLE_MAX = 1000;
export const DESCRIPTION_MAX = 2000;

/**
 * "1,000자"를 코드포인트로 센다. `String.length`(UTF-16)로 세면 이모지 하나가
 * 2자로 잡혀, DTO를 통과한 값이 로더에서 거부된다 — 성공한 POST가 재시작 불능
 * 파일을 만든다. class-validator가 surrogate pair를 한 자로 취급하므로 이 정의가
 * DTO와 일치한다.
 */
export function countCharacters(value: string): number {
  return [...value].length;
}

function violationOfText(value: unknown, field: string, max: number): string | null {
  if (typeof value !== 'string') return `${field}이(가) 문자열이 아닙니다`;
  if (value.trim().length < 1) return `${field}이(가) 비어 있습니다`;
  // [DATA-002]는 trim된 값을 저장한다고 규정한다.
  if (value !== value.trim()) return `${field}에 앞뒤 공백이 있습니다`;
  if (countCharacters(value) > max) return `${field}이(가) ${max}자를 초과합니다`;
  return null;
}

/**
 * 형식만 보면 `2026-99-99T99:99:99.999Z`가 통과하고, `2026-02-30`은 JS Date가
 * `2026-03-02`로 넘겨버려 조용히 다른 값이 된다. 왕복시켜 실재하는 시각인지 본다.
 */
function isRealIsoInstant(value: string): boolean {
  if (!ISO_8601_UTC.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * 영속 데이터의 레코드 하나를 검사한다. 위반 사유를 돌려주고, 없으면 null.
 *
 * API 입력은 DTO가 막지만 파일은 사람이 직접 고칠 수 있다. parse만 되고 스키마가
 * 어긋난 레코드를 받아들이면 원인에서 멀리 떨어진 곳에서 TypeError로 터지므로,
 * 로드 시점에 걸러야 한다.
 */
export function findJobViolation(candidate: unknown, index: number): string | null {
  const at = `jobs[${index}]`;

  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return `${at}이(가) 객체가 아닙니다`;
  }

  const job = candidate as Record<string, unknown>;

  const unknownKeys = Object.keys(job).filter((key) => !JOB_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    return `${at}에 정의되지 않은 키가 있습니다: ${unknownKeys.join(', ')}`;
  }

  if (typeof job.id !== 'string' || !UUID_V4.test(job.id)) {
    return `${at}.id가 UUID v4가 아닙니다`;
  }

  const titleViolation = violationOfText(job.title, 'title', TITLE_MAX);
  if (titleViolation) return `${at}.${titleViolation}`;

  const descriptionViolation = violationOfText(job.description, 'description', DESCRIPTION_MAX);
  if (descriptionViolation) return `${at}.${descriptionViolation}`;

  if (typeof job.status !== 'string' || !JOB_STATUSES.includes(job.status as JobStatus)) {
    return `${at}.status가 ${JOB_STATUSES.join(' | ')} 중 하나가 아닙니다`;
  }

  for (const field of ['createdAt', 'updatedAt'] as const) {
    const value = job[field];
    if (typeof value !== 'string' || !isRealIsoInstant(value)) {
      return `${at}.${field}이(가) 실재하는 ISO 8601 UTC 시각이 아닙니다`;
    }
  }

  return null;
}

const JOBS_FILE_KEYS: readonly string[] = ['jobs'];

/**
 * 파일 전체를 검사한다 — 최상위 형태, 레코드별 위반, `id` 중복.
 *
 * 최상위 키를 정확히 검사하는 이유: 인메모리 상태는 `{ jobs }`만 담으므로,
 * 다른 키가 있는 파일을 받아들이면 다음 쓰기에서 그 키가 조용히 사라진다.
 * 손상 파일을 자동 초기화하지 않는 방침과 정반대되는 데이터 손실이다.
 */
export function findJobsFileViolation(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '최상위가 객체가 아닙니다';
  }

  const file = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(file).filter((key) => !JOBS_FILE_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    return `최상위에 정의되지 않은 키가 있습니다: ${unknownKeys.join(', ')}`;
  }

  if (!Array.isArray(file.jobs)) {
    return '최상위 jobs가 배열이 아닙니다';
  }

  const seenIds = new Set<string>();

  for (const [index, candidate] of file.jobs.entries()) {
    const violation = findJobViolation(candidate, index);
    if (violation) return violation;

    const { id } = candidate as Job;
    if (seenIds.has(id)) return `jobs[${index}].id가 중복입니다: ${id}`;
    seenIds.add(id);
  }

  return null;
}
