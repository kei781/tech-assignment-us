/**
 * 로거 테스트. SPEC §6 [LOG-001], [LOG-002], [LOG-005]
 * ([LOG-003]은 api.e2e-spec, [LOG-004]는 scheduler.spec에서 검증)
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { formatLogLine } from '../src/common/logging/app-logger';
import { FileLogger } from '../src/common/logging/file-logger';
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
    // 호출 순서가 파일 순서와 일치한다
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

  it('[LOG-002] formatLogLine은 명세된 형식을 만든다', () => {
    const line = formatLogLine('2026-09-03T20:00:00.000Z', 'INFO', 'http', 'POST /jobs 201 12ms');
    expect(line).toBe('[2026-09-03T20:00:00.000Z] [INFO] [http] POST /jobs 201 12ms\n');
  });
});
