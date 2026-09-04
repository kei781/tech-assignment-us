/**
 * 로거 계약. SPEC §6 [LOG-001] ~ [LOG-005]
 */

/** [LOG-002] LEVEL */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** [LOG-002] scope */
export type LogScope = 'http' | 'scheduler' | 'storage';

export interface AppLogger {
  /**
   * 한 항목을 기록한다.
   * [LOG-005] 기록 실패가 호출자를 실패시키지 않으므로 동기 시그니처다.
   */
  log(level: LogLevel, scope: LogScope, message: string): void;
  /** 대기 중인 기록이 모두 끝날 때까지 기다린다 (테스트·정상 종료용) */
  flush(): Promise<void>;
}

export const APP_LOGGER = Symbol('APP_LOGGER');

/** [LOG-002] 로그 라인 형식: `[ISO8601 UTC] [LEVEL] [scope] message` */
export function formatLogLine(iso: string, level: LogLevel, scope: LogScope, message: string): string {
  // 개행이 섞이면 한 항목이 여러 라인으로 쪼개져 형식이 깨지므로 치환한다.
  const oneLine = message.replace(/\r?\n/g, ' ');
  return `[${iso}] [${level}] [${scope}] ${oneLine}\n`;
}
