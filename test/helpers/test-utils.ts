import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig, DEFAULT_CONFIG } from '../../src/contracts/config';
import { Clock } from '../../src/contracts/interfaces';
import {
  emptyJobsFile,
  GlobalLockMetadata,
  Job,
  JobLockMetadata,
  JobsFile,
  JobStatus,
} from '../../src/contracts/types';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** [API-011] 서버 생성 id는 UUID v4 (version=4, variant=8/9/a/b) */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 테스트 전용 임시 storage 디렉터리 생성 */
export async function mkStorageDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'jobs-backend-test-'));
}

export async function rmDir(dir: string): Promise<void> {
  // Windows: 직전 테스트의 파일 핸들이 닫히는 중일 수 있어 재시도
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * 테스트용 설정: 실제 대기가 필요한 값은 짧게. [TST-002]
 * storageDir/logFilePath는 호출자가 임시 디렉터리로 지정한다.
 */
export function testConfig(storageDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    storageDir,
    logFilePath: path.join(storageDir, 'logs.txt'),
    globalLockRetryMs: 10,
    globalLockApiWaitMs: 200,
    ...overrides,
  };
}

/**
 * [TST-002] 수동 제어 시계.
 * 기본 시작 시각은 "실제 현재 시각"이다 — 파일 mtime(실제 시간축)과
 * 주입 시계(판정 기준)의 축을 일치시켜, 벽시계에 따라 결과가 갈리는
 * 단언을 방지한다. advance() 전까지는 고정되어 결정적이다.
 */
export class ManualClock implements Clock {
  constructor(private t: Date = new Date()) {}
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
  isoAgo(ms: number): string {
    return new Date(this.t.getTime() - ms).toISOString();
  }
}

export function hex64(seed: string): string {
  // 결정적 64-hex 생성 (테스트 fixture용)
  const base = Buffer.from(seed).toString('hex');
  return (base.repeat(Math.ceil(64 / base.length))).slice(0, 64);
}

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

// ── 파일 경로 헬퍼 (SPEC [RUN-001], [LOCK-001], [LOCK-002], [LOCK-010]) ──

export function jobsJsonPath(dir: string): string {
  return path.join(dir, 'jobs.json');
}
export function locksDir(dir: string): string {
  return path.join(dir, 'locks');
}
export function jobLockPath(dir: string, jobId: string): string {
  return path.join(locksDir(dir), `${jobId}-lock.json`);
}
export function globalLockPath(dir: string): string {
  return path.join(locksDir(dir), 'jobs-global-lock.json');
}
export function reapMutexPath(dir: string): string {
  return path.join(locksDir(dir), 'reap-mutex.json');
}

// ── fixture 직접 조작 (store 구현을 우회한 사전 상태 구성) ──

export async function writeJobsFile(dir: string, file: JobsFile): Promise<void> {
  await fs.mkdir(locksDir(dir), { recursive: true });
  await fs.writeFile(jobsJsonPath(dir), JSON.stringify(file, null, 2), 'utf8');
}

export async function readJobsFile(dir: string): Promise<JobsFile> {
  return JSON.parse(await fs.readFile(jobsJsonPath(dir), 'utf8'));
}

export async function seedJobs(dir: string, jobs: Job[], extra: Partial<JobsFile> = {}): Promise<void> {
  const file = emptyJobsFile();
  file.jobs = jobs;
  Object.assign(file, extra);
  await writeJobsFile(dir, file);
}

export async function writeJobLock(dir: string, jobId: string, meta: JobLockMetadata): Promise<void> {
  await fs.mkdir(locksDir(dir), { recursive: true });
  await fs.writeFile(jobLockPath(dir, jobId), JSON.stringify(meta), 'utf8');
}

export async function writeGlobalLock(dir: string, meta: GlobalLockMetadata): Promise<void> {
  await fs.mkdir(locksDir(dir), { recursive: true });
  await fs.writeFile(globalLockPath(dir), JSON.stringify(meta), 'utf8');
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 파일 mtime을 과거로 설정 ([RPR-011] mtime 기반 규칙 테스트용) */
export async function setMtimeAgo(p: string, msAgo: number, clock: Clock): Promise<void> {
  const t = new Date(clock.now().getTime() - msAgo);
  await fs.utimes(p, t, t);
}

export async function readLogLines(logFilePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(logFilePath, 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** [LOG-002] 로그 라인 형식 */
export const LOG_LINE_RE =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(INFO|WARN|ERROR|FATAL)\] \[(http|worker|reaper|storage)\] .+$/;

/** 조건이 참이 될 때까지 폴링 (실제 대기 최소화용 짧은 간격) */
export async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
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

export async function listLockDirFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(locksDir(dir));
  } catch {
    return [];
  }
}
