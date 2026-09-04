/**
 * 데이터 모델. SPEC §2 [DATA-001] ~ [DATA-003], [STATE-001]
 */

export type JobStatus = 'create' | 'pending' | 'done';

export const JOB_STATUSES: readonly JobStatus[] = ['create', 'pending', 'done'];

export interface Job {
  /** UUID v4. PK, 생성 후 불변 */
  id: string;
  /** trim 후 1..1000자 */
  title: string;
  /** trim 후 1..2000자 */
  description: string;
  status: JobStatus;
  /** ISO 8601 UTC. 생성 시각, 불변 */
  createdAt: string;
  /** ISO 8601 UTC. 마지막 변경 시각 */
  updatedAt: string;
}

/** [DATA-001] jobs.json의 최상위 키는 jobs 하나다. */
export interface JobsFile {
  jobs: Job[];
}

export function emptyJobsFile(): JobsFile {
  return { jobs: [] };
}

/**
 * [API-020] 정렬 기준: createdAt ASC, 동률 시 id ASC.
 * ISO 8601 UTC 문자열은 사전순 비교가 시간순 비교와 일치한다([DATA-003]).
 */
export function compareJobs(a: Job, b: Job): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** 응답 사유 메시지. SPEC §4 */
export const MESSAGES = {
  success: 'success',
  notFound: '존재하지 않는 데이터입니다.',
  searchEmpty: '데이터가 존재하지 않습니다.',
  alreadyDone: '이미 완료된 프로세스입니다.',
  inProgress: '처리중인 프로세스입니다.',
  invalidId: 'id는 UUID 형식이어야 합니다.',
} as const;
