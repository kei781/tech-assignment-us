/**
 * 애플리케이션 설정. SPEC §7 [CFG-001]
 *
 * 모든 값은 환경 변수로 재정의할 수 있고, 테스트는 이 객체를 직접 주입해
 * 실제 스케줄러 주기나 처리 시간을 기다리지 않는다([TST-002]).
 */

export interface AppConfig {
  /** jobs.json 경로. 상대 경로는 프로세스 cwd 기준 */
  jobsFilePath: string;
  /** logs.txt 경로 */
  logFilePath: string;
  /** 스케줄러 tick 주기 */
  consumeIntervalMs: number;
  /** 한 Job을 처리하는 데 걸리는 시간(모사) */
  jobProcessingMs: number;
  /** 종료 시 진행 중인 tick을 기다리는 최대 시간 [CON-007] */
  shutdownDrainMs: number;
  /**
   * 스케줄러 자동 실행 여부.
   * false면 interval 등록과 기동 즉시 tick([SCH-001])을 모두 건너뛴다.
   * 테스트가 tick 시점을 직접 통제하기 위한 seam이며([TST-002]),
   * API만 띄우는 운영 구성에도 쓸 수 있다.
   */
  schedulerEnabled: boolean;
}

/** SPEC §7 기본값 */
export const DEFAULT_CONFIG: AppConfig = {
  jobsFilePath: './data/jobs.json',
  logFilePath: './logs.txt',
  consumeIntervalMs: 60_000,
  jobProcessingMs: 5_000,
  shutdownDrainMs: 10_000,
  schedulerEnabled: true,
};

/** DI 토큰 */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Node timer가 처리할 수 있는 최대 delay (32-bit signed).
 * 이 값을 넘기면 libuv가 delay를 1ms로 보정해버린다.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function intFromEnv(name: string, fallback: number, min = 0, max = MAX_TIMER_DELAY_MS): number {
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
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
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
    // interval은 0을 허용하지 않는다. setInterval(fn, 0)은 1ms로 보정되어
    // 빈 큐에서도 매 tick 로그를 append하며 CPU/I-O를 태우고 logs.txt를 채운다.
    consumeIntervalMs: intFromEnv('CONSUME_INTERVAL_MS', DEFAULT_CONFIG.consumeIntervalMs, 1),
    // 처리 시간과 drain에는 0("대기 없음")이 의미가 있으므로 허용한다.
    jobProcessingMs: intFromEnv('JOB_PROCESSING_MS', DEFAULT_CONFIG.jobProcessingMs, 0),
    shutdownDrainMs: intFromEnv('SHUTDOWN_DRAIN_MS', DEFAULT_CONFIG.shutdownDrainMs, 0),
    schedulerEnabled: boolFromEnv('SCHEDULER_ENABLED', DEFAULT_CONFIG.schedulerEnabled),
  };
}

/**
 * SPEC §7 제약: JOB_PROCESSING_MS < CONSUME_INTERVAL_MS.
 * 위반하면 [SCH-002] guard가 매 tick 발동해 실효 처리량이 절반 이하로 떨어진다.
 * 기동을 막을 만한 오류는 아니므로 경고 문구만 돌려주고 호출자가 로깅한다.
 */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.schedulerEnabled && config.jobProcessingMs >= config.consumeIntervalMs) {
    warnings.push(
      `JOB_PROCESSING_MS(${config.jobProcessingMs}) >= CONSUME_INTERVAL_MS(${config.consumeIntervalMs}): ` +
        '매 tick [SCH-002] guard가 발동해 실효 처리량이 떨어집니다.',
    );
  }
  return warnings;
}
