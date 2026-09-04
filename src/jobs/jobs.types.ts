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
