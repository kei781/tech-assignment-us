/** [LOCK-008] API 대기 초과 → 503 매핑용 오류 */
export class GlobalLockWaitTimeoutError extends Error {
  constructor(message = 'global lock wait timeout') {
    super(message);
    this.name = 'GlobalLockWaitTimeoutError';
  }
}

/** [RUN-004] ④ jobs.json 손상 감지 오류 (자동 초기화 금지) */
export class CorruptedStoreError extends Error {
  constructor(message = 'jobs.json is corrupted') {
    super(message);
    this.name = 'CorruptedStoreError';
  }
}

/** TDD red 단계 표식: pr-4에서 구현으로 대체된다 */
export class NotImplementedError extends Error {
  constructor(subject: string) {
    super(`Not implemented yet (planned for pr-4): ${subject}`);
    this.name = 'NotImplementedError';
  }
}
