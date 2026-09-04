export interface AppConfig {
  jobsFilePath: string;
  logFilePath: string;
  consumeIntervalMs: number;
  jobProcessingMs: number;
  shutdownDrainMs: number;
  /**
   * 테스트가 tick 시점을 직접 통제하기 위해 둔 seam.
   * 스케줄러 없이 API만 띄우는 운영 구성에도 쓸 수 있다.
   */
  schedulerEnabled: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  jobsFilePath: './data/jobs.json',
  logFilePath: './logs.txt',
  consumeIntervalMs: 60_000,
  jobProcessingMs: 5_000,
  shutdownDrainMs: 10_000,
  schedulerEnabled: true,
};

export const APP_CONFIG = Symbol('APP_CONFIG');

/** 이 값을 넘는 delay는 libuv가 1ms로 보정해버린다. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface IntRange {
  min?: number;
  max?: number;
}

function intFromEnv(
  name: string,
  fallback: number,
  { min = 0, max = MAX_TIMER_DELAY_MS }: IntRange = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name}은(는) 정수여야 합니다: "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name}은(는) ${min}..${max} 범위여야 합니다: "${raw}"`);
  }
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name}은(는) true/false여야 합니다: "${raw}"`);
}

function strFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

export function loadConfig(): AppConfig {
  return {
    jobsFilePath: strFromEnv('JOBS_FILE_PATH', DEFAULT_CONFIG.jobsFilePath),
    logFilePath: strFromEnv('LOG_FILE_PATH', DEFAULT_CONFIG.logFilePath),
    // 오설정을 런타임 폭주로 바꾸지 않으려고 0을 막는다. setInterval(fn, 0)은
    // 1ms로 보정되어, 빈 큐에서도 매 tick 로그를 append하며 CPU와 logs.txt를 태운다.
    consumeIntervalMs: intFromEnv('CONSUME_INTERVAL_MS', DEFAULT_CONFIG.consumeIntervalMs, {
      min: 1,
    }),
    // 아래 둘은 0이 "대기 없음"이라는 의미를 가지므로 허용한다.
    jobProcessingMs: intFromEnv('JOB_PROCESSING_MS', DEFAULT_CONFIG.jobProcessingMs),
    shutdownDrainMs: intFromEnv('SHUTDOWN_DRAIN_MS', DEFAULT_CONFIG.shutdownDrainMs),
    schedulerEnabled: boolFromEnv('SCHEDULER_ENABLED', DEFAULT_CONFIG.schedulerEnabled),
  };
}

/** 기동을 막을 만큼은 아니지만 알려야 하는 설정 조합. */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];

  // 처리 시간이 주기보다 길면 재진입 guard가 매 tick 발동해 실효 처리량이 절반 이하가 된다.
  if (config.schedulerEnabled && config.jobProcessingMs >= config.consumeIntervalMs) {
    warnings.push(
      `JOB_PROCESSING_MS(${config.jobProcessingMs}) >= CONSUME_INTERVAL_MS(${config.consumeIntervalMs}): ` +
        '매 tick guard가 발동해 실효 처리량이 떨어집니다.',
    );
  }

  return warnings;
}

/** 시간 판정을 전부 이 seam으로 모아, 테스트가 실제 대기 없이 검증할 수 있게 한다. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}
