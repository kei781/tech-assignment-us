/**
 * 테스트 공용 유틸. SPEC [TST-002]
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Clock } from '../../src/common/clock';
import { AppConfig, DEFAULT_CONFIG } from '../../src/common/config';
import { emptyJobsFile, Job, JobsFile, JobStatus } from '../../src/jobs/jobs.types';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** [API-011] 서버 생성 id는 UUID v4 (version=4, variant=8/9/a/b) */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** [LOG-002] 로그 라인 형식: `[ISO8601 UTC] [LEVEL] [scope] message` */
export const LOG_LINE_RE =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(INFO|WARN|ERROR)\] \[(http|scheduler|storage)\] .+$/;

export async function mkStorageDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'jobs-backend-test-'));
}

export async function rmDir(dir: string): Promise<void> {
  // Windows: 직전 테스트의 파일 핸들이 닫히는 중일 수 있어 재시도
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * 테스트 설정. [TST-002]
 *  - schedulerEnabled: false — tick 시점을 테스트가 직접 통제한다.
 *  - jobProcessingMs: 0 — 실제 처리 대기 없음.
 */
export function testConfig(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    jobsFilePath: jobsJsonPath(dir),
    logFilePath: path.join(dir, 'logs.txt'),
    jobProcessingMs: 0,
    shutdownDrainMs: 1_000,
    schedulerEnabled: false,
    ...overrides,
  };
}

/**
 * [TST-002] 수동 제어 시계. advance() 전까지 고정되어 결정적이다.
 */
export class ManualClock implements Clock {
  constructor(private t: Date = new Date('2026-09-04T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.t.getTime());
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
  set(iso: string): void {
    this.t = new Date(iso);
  }
  iso(): string {
    return this.t.toISOString();
  }
}

// ── fixture ──

let jobSeq = 0;
export function makeJob(partial: Partial<Job> = {}): Job {
  jobSeq += 1;
  const n = jobSeq.toString(16).padStart(12, '0');
  return {
    id: `550e8400-e29b-41d4-a716-${n}`,
    title: `job title ${jobSeq}`,
    description: `job description ${jobSeq}`,
    status: 'create' as JobStatus,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    ...partial,
  };
}

export function jobsJsonPath(dir: string): string {
  return path.join(dir, 'jobs.json');
}

export async function writeJobsFile(dir: string, file: JobsFile): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(jobsJsonPath(dir), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** 손상 파일 등 임의 내용을 그대로 쓴다 ([RUN-004] 테스트용) */
export async function writeRawJobsFile(dir: string, raw: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(jobsJsonPath(dir), raw, 'utf8');
}

export async function readJobsFile(dir: string): Promise<JobsFile> {
  return JSON.parse(await fs.readFile(jobsJsonPath(dir), 'utf8')) as JobsFile;
}

export async function seedJobs(dir: string, jobs: Job[]): Promise<void> {
  const file = emptyJobsFile();
  file.jobs = jobs;
  await writeJobsFile(dir, file);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export async function readLogLines(logFilePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(logFilePath, 'utf8');
    return raw.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 조건이 참이 될 때까지 폴링한다 (실제 대기 최소화용 짧은 간격) */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 5,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
