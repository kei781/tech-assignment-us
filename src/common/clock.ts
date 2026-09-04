/**
 * 주입 가능한 시계. [TST-002]
 * 모든 시간 판정은 이 Clock을 경유해야 테스트가 실제 대기 없이 검증할 수 있다.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** [DATA-003] 모든 시각은 ISO 8601 UTC 문자열로 기록·비교한다. */
export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}
