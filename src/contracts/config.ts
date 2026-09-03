/**
 * SPEC.md §7 설정값 계약. [CFG-001]
 */

export interface AppConfig {
  storageDir: string;
  logFilePath: string;
  heartbeatIntervalMs: number;
  consumeIntervalMs: number;
  reaperInitialDelayMs: number;
  reaperCheckIntervalMs: number;
  reaperElectionGraceMs: number;
  reaperStaleAfterMs: number;
  workerDeleteAfterMs: number;
  globalLockRetryMs: number;
  globalLockApiWaitMs: number;
  globalLockStaleAfterMs: number;
  globalLockOrphanMinMs: number;
  reapMutexStaleMs: number;
  jobProcessingMs: number;
}

/** §7 기본값 */
export const DEFAULT_CONFIG: AppConfig = {
  storageDir: './data',
  logFilePath: './logs.txt',
  heartbeatIntervalMs: 60_000,
  consumeIntervalMs: 60_000,
  reaperInitialDelayMs: 60_000,
  reaperCheckIntervalMs: 60_000,
  reaperElectionGraceMs: 60_000,
  reaperStaleAfterMs: 300_000,
  workerDeleteAfterMs: 360_000,
  globalLockRetryMs: 1_000,
  globalLockApiWaitMs: 5_000,
  globalLockStaleAfterMs: 300_000,
  globalLockOrphanMinMs: 180_000,
  reapMutexStaleMs: 60_000,
  jobProcessingMs: 60_000,
};
