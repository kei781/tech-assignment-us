import { configWarnings, DEFAULT_CONFIG, loadConfig } from '../src/common/config';

const ENV_KEYS = [
  'JOBS_FILE_PATH',
  'LOG_FILE_PATH',
  'CONSUME_INTERVAL_MS',
  'JOB_PROCESSING_MS',
  'SHUTDOWN_DRAIN_MS',
  'SCHEDULER_ENABLED',
] as const;

describe('loadConfig', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('[CFG-001] 환경 변수가 없으면 기본값을 사용한다', () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('[CFG-001] 환경 변수로 재정의할 수 있다', () => {
    process.env.JOBS_FILE_PATH = '/tmp/custom.json';
    process.env.CONSUME_INTERVAL_MS = '2000';
    process.env.SCHEDULER_ENABLED = 'false';

    const config = loadConfig();
    expect(config.jobsFilePath).toBe('/tmp/custom.json');
    expect(config.consumeIntervalMs).toBe(2000);
    expect(config.schedulerEnabled).toBe(false);
  });

  it('빈 문자열 환경 변수는 미설정으로 간주한다', () => {
    process.env.CONSUME_INTERVAL_MS = '   ';
    expect(loadConfig().consumeIntervalMs).toBe(DEFAULT_CONFIG.consumeIntervalMs);
  });

  describe('interval 값 범위 검증', () => {
    /**
     * Node timer는 delay가 0이거나 32-bit signed 범위를 넘으면 사실상 1ms로 보정한다.
     * 그러면 빈 큐에서도 매 tick 로그를 append해 CPU/I-O를 태우고 logs.txt를 채운다.
     * 오설정을 런타임 폭주로 바꾸지 않고 기동 시점에 거부한다.
     */
    it('CONSUME_INTERVAL_MS=0은 거부한다 (1ms busy loop 방지)', () => {
      process.env.CONSUME_INTERVAL_MS = '0';
      expect(() => loadConfig()).toThrow(/CONSUME_INTERVAL_MS/);
    });

    it('CONSUME_INTERVAL_MS가 32-bit signed 범위를 넘으면 거부한다', () => {
      process.env.CONSUME_INTERVAL_MS = '2147483648';
      expect(() => loadConfig()).toThrow(/CONSUME_INTERVAL_MS/);
    });

    it('경계값은 허용한다', () => {
      process.env.CONSUME_INTERVAL_MS = '1';
      expect(loadConfig().consumeIntervalMs).toBe(1);

      process.env.CONSUME_INTERVAL_MS = '2147483647';
      expect(loadConfig().consumeIntervalMs).toBe(2_147_483_647);
    });

    it('처리 시간과 drain은 0을 허용한다 (대기 없음이라는 의미가 있다)', () => {
      process.env.JOB_PROCESSING_MS = '0';
      process.env.SHUTDOWN_DRAIN_MS = '0';

      const config = loadConfig();
      expect(config.jobProcessingMs).toBe(0);
      expect(config.shutdownDrainMs).toBe(0);
    });
  });

  describe('잘못된 값', () => {
    it.each([
      ['정수가 아님', 'CONSUME_INTERVAL_MS', '1.5'],
      ['숫자가 아님', 'CONSUME_INTERVAL_MS', 'soon'],
      ['음수', 'JOB_PROCESSING_MS', '-1'],
    ])('%s이면 오류를 던진다', (_name, key, value) => {
      process.env[key] = value;
      expect(() => loadConfig()).toThrow();
    });

    it('SCHEDULER_ENABLED가 boolean이 아니면 오류를 던진다', () => {
      process.env.SCHEDULER_ENABLED = 'maybe';
      expect(() => loadConfig()).toThrow(/SCHEDULER_ENABLED/);
    });
  });

  describe('configWarnings', () => {
    it('JOB_PROCESSING_MS >= CONSUME_INTERVAL_MS면 경고한다', () => {
      const warnings = configWarnings({
        ...DEFAULT_CONFIG,
        jobProcessingMs: 60_000,
        consumeIntervalMs: 60_000,
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('CONSUME_INTERVAL_MS');
    });

    it('스케줄러가 꺼져 있으면 경고하지 않는다', () => {
      const warnings = configWarnings({
        ...DEFAULT_CONFIG,
        jobProcessingMs: 60_000,
        consumeIntervalMs: 60_000,
        schedulerEnabled: false,
      });
      expect(warnings).toEqual([]);
    });

    it('기본값은 경고를 만들지 않는다', () => {
      expect(configWarnings(DEFAULT_CONFIG)).toEqual([]);
    });
  });
});

describe('[RUN-003] 실행 전제', () => {
  it('package.json이 의존성의 Node 요구사항을 engines로 선언한다', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../package.json') as { engines?: { node?: string } };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nest = require('@nestjs/core/package.json') as { engines?: { node?: string } };

    expect(pkg.engines?.node).toBeDefined();

    // @nestjs/core가 요구하는 major 이상을 선언해야 한다.
    const required = Number(/(\d+)/.exec(nest.engines?.node ?? '')?.[1]);
    const declared = Number(/(\d+)/.exec(pkg.engines?.node ?? '')?.[1]);
    expect(declared).toBeGreaterThanOrEqual(required);
  });
});
