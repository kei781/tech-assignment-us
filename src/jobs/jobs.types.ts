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

const TITLE_MAX = 1000;
const DESCRIPTION_MAX = 2000;

function violationOfText(value: unknown, field: string, max: number): string | null {
  if (typeof value !== 'string') return `${field}이(가) 문자열이 아닙니다`;
  if (value.trim().length < 1) return `${field}이(가) 비어 있습니다`;
  if (value.length > max) return `${field}이(가) ${max}자를 초과합니다`;
  return null;
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
    if (typeof value !== 'string' || !ISO_8601_UTC.test(value)) {
      return `${at}.${field}이(가) ISO 8601 UTC가 아닙니다`;
    }
  }

  return null;
}

/** 레코드별 위반과 id 중복을 함께 본다. */
export function findJobsFileViolation(jobs: readonly unknown[]): string | null {
  const seenIds = new Set<string>();

  for (const [index, candidate] of jobs.entries()) {
    const violation = findJobViolation(candidate, index);
    if (violation) return violation;

    const { id } = candidate as Job;
    if (seenIds.has(id)) return `jobs[${index}].id가 중복입니다: ${id}`;
    seenIds.add(id);
  }

  return null;
}
