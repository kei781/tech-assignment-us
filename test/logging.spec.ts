/** 요청 로깅은 api.e2e-spec, 스케줄러 로깅은 scheduler.spec에서 검증한다. */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileLogger, formatLogLine } from '../src/common/logger';
import {
  LOG_LINE_RE,
  ManualClock,
  mkStorageDir,
  readLogLines,
  rmDir,
  testConfig,
} from './helpers/test-utils';

describe('FileLogger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkStorageDir();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rmDir(dir);
  });

  it('[LOG-001][LOG-002] 형식에 맞는 라인을 append한다', async () => {
    const clock = new ManualClock();
    const config = testConfig(dir);
    const logger = new FileLogger(config, clock);

    logger.log('INFO', 'http', 'GET /jobs 200 3ms');
    logger.log('WARN', 'storage', '기동 복구 대상 없음');
    logger.log('ERROR', 'scheduler', '처리 실패');
    await logger.flush();

    const lines = await readLogLines(config.logFilePath);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(LOG_LINE_RE);
    }
    expect(lines[0]).toBe('[' + clock.iso() + '] [INFO] [http] GET /jobs 200 3ms');
  });

  it('[LOG-001] append 모드이므로 기존 내용을 덮어쓰지 않는다', async () => {
    const clock = new ManualClock();
    const config = testConfig(dir);
    await fs.writeFile(config.logFilePath, '[기존 내용]\n', 'utf8');

    const logger = new FileLogger(config, clock);
    logger.log('INFO', 'http', 'appended');
    await logger.flush();

    const raw = await fs.readFile(config.logFilePath, 'utf8');
    expect(raw.startsWith('[기존 내용]\n')).toBe(true);
    expect(raw).toContain('appended');
  });

  it('[LOG-001] 많은 항목을 연속 기록해도 라인이 섞이지 않는다', async () => {
    const clock = new ManualClock();
    const config = testConfig(dir);
    const logger = new FileLogger(config, clock);

    for (let i = 0; i < 100; i += 1) {
      logger.log('INFO', 'scheduler', 'message ' + i);
    }
    await logger.flush();

    const lines = await readLogLines(config.logFilePath);
    expect(lines).toHaveLength(100);
    for (const line of lines) {
      expect(line).toMatch(LOG_LINE_RE);
    }
    expect(lines[0]).toContain('message 0');
    expect(lines[99]).toContain('message 99');
  });

  it('[LOG-002] 개행이 포함된 메시지도 한 라인으로 기록한다', async () => {
    const clock = new ManualClock();
    const config = testConfig(dir);
    const logger = new FileLogger(config, clock);

    logger.log('ERROR', 'http', 'Error: boom\n    at somewhere\n    at elsewhere');
    await logger.flush();

    const lines = await readLogLines(config.logFilePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(LOG_LINE_RE);
  });

  it('[LOG-005] 로그 기록 실패가 예외를 전파하지 않는다 (best-effort)', async () => {
    const clock = new ManualClock();
    // 디렉터리 자리에 파일을 만들어 append를 실패시킨다
    const blocked = path.join(dir, 'blocked');
    await fs.writeFile(blocked, 'not a directory', 'utf8');
    const config = testConfig(dir, { logFilePath: path.join(blocked, 'logs.txt') });

    const logger = new FileLogger(config, clock);
    expect(() => logger.log('INFO', 'http', 'should not throw')).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
  });

  /**
   * append가 거부되면 체인이 rejected로 굳는다. `log()`의 실패 슬롯이 그것을
   * 되살리는 유일한 수단인데(흡수 전용 단계가 없다), 슬롯을 지워도 통과하는
   * 테스트만 있으면 다음 정리에서 도달 불가능 코드로 오인되어 삭제된다.
   *
   * append는 내부에서 오류를 삼켜 스스로 거부하지 않으므로, 그 보장이 깨진
   * 상황을 만들려면 append 자체를 한 번 거부시켜야 한다.
   */
  it('[LOG-005] append가 한 번 거부돼도 이후 로그가 계속 기록된다', async () => {
    const clock = new ManualClock();
    const config = testConfig(dir);
    const logger = new FileLogger(config, clock);

    const appendSpy = jest
      .spyOn(logger as unknown as { append: (line: string) => Promise<void> }, 'append')
      .mockRejectedValueOnce(new Error('append 실패'));

    logger.log('INFO', 'http', '첫째 — 거부된다');
    logger.log('INFO', 'http', '둘째 — 기록되어야 한다');
    logger.log('INFO', 'http', '셋째 — 기록되어야 한다');
    await logger.flush();

    expect(appendSpy).toHaveBeenCalledTimes(3);

    const lines = await readLogLines(config.logFilePath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('둘째');
    expect(lines[1]).toContain('셋째');
  });

  it('[LOG-002] formatLogLine은 명세된 형식을 만든다', () => {
    const line = formatLogLine('2026-09-03T20:00:00.000Z', 'INFO', 'http', 'POST /jobs 201 12ms');
    expect(line).toBe('[2026-09-03T20:00:00.000Z] [INFO] [http] POST /jobs 201 12ms\n');
  });
});
