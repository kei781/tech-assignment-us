/**
 * 로깅 테스트. SPEC.md §4 [LOG-001], [LOG-002], [LOG-005]
 * ([LOG-003]은 api.e2e-spec, [LOG-004]는 worker-consume.spec에서 검증)
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { createFileLogger } from '../src/contracts/factories';
import {
  LOG_LINE_RE,
  ManualClock,
  mkStorageDir,
  readLogLines,
  rmDir,
  testConfig,
} from './helpers/test-utils';

const flush = () => new Promise((r) => setTimeout(r, 50)); // best-effort append 대기

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
    const logger = createFileLogger({ config, clock });

    logger.log('INFO', 'http', 'GET /jobs 200 3ms');
    logger.log('WARN', 'storage', 'stale lock detected');
    logger.log('ERROR', 'worker', 'processing failed');
    await flush();

    const lines = await readLogLines(config.logFilePath);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(LOG_LINE_RE);
    }
    expect(lines[0]).toContain('[INFO] [http] GET /jobs 200 3ms');
    expect(lines[0]).toContain(`[${clock.iso()}]`);
  });

  it('[LOG-001] 여러 로거 인스턴스가 같은 파일에 append해도 라인이 섞이지 않는다', async () => {
    const clock = new ManualClock();
    const config = testConfig(dir);
    const l1 = createFileLogger({ config, clock });
    const l2 = createFileLogger({ config, clock });

    for (let i = 0; i < 50; i += 1) {
      l1.log('INFO', 'worker', `w1 message ${i}`);
      l2.log('INFO', 'worker', `w2 message ${i}`);
    }
    await flush();

    const lines = await readLogLines(config.logFilePath);
    expect(lines).toHaveLength(100);
    for (const line of lines) {
      expect(line).toMatch(LOG_LINE_RE); // 부분 문자열 교차 없음
    }
  });

  it('[LOG-005] 로그 기록 실패가 예외를 전파하지 않는다 (best-effort)', async () => {
    const clock = new ManualClock();
    // 디렉터리 자리에 파일을 만들어 append를 실패시킨다
    const blocked = path.join(dir, 'blocked');
    await fs.writeFile(blocked, 'not a directory', 'utf8');
    const config = testConfig(dir, { logFilePath: path.join(blocked, 'logs.txt') });

    const logger = createFileLogger({ config, clock });
    expect(() => logger.log('INFO', 'http', 'should not throw')).not.toThrow();
    await flush(); // 비동기 실패도 unhandled rejection 없이 지나가야 한다
  });
});
