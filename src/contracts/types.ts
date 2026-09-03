/**
 * SPEC.md 데이터 모델 계약. [DATA-001] ~ [DATA-003], [LOCK-001], [LOCK-002]
 */

export type JobStatus = 'create' | 'pending' | 'done';

export const JOB_STATUSES: readonly JobStatus[] = ['create', 'pending', 'done'];

export interface Job {
  id: string; // UUID v4
  title: string; // trim 후 1..1000자
  description: string; // trim 후 1..2000자
  status: JobStatus;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}

export interface WorkerRegistryEntry {
  heartbeatAt: string; // ISO 8601 UTC
}

export interface ReaperState {
  workerId: string | null;
  lastGlobalLockReapAt: string | null;
}

/** jobs.json 전체 구조. [DATA-001] */
export interface JobsFile {
  jobs: Job[];
  workers: Record<string, WorkerRegistryEntry>;
  reaper: ReaperState;
}

/** {jobId}-lock.json 내용. [LOCK-001] */
export interface JobLockMetadata {
  preemption: string; // 64-hex worker id
  preemptedAt: string; // ISO 8601 UTC
}

/** jobs-global-lock.json 내용. [LOCK-002] */
export type LockOwnerType = 'api' | 'worker';

export interface GlobalLockMetadata extends JobLockMetadata {
  ownerType: LockOwnerType;
}

export function emptyJobsFile(): JobsFile {
  return { jobs: [], workers: {}, reaper: { workerId: null, lastGlobalLockReapAt: null } };
}
