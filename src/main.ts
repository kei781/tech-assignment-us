import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  APP_CONFIG,
  AppConfig,
  configWarnings,
  DEFAULT_CONFIG,
  loadConfig,
  SystemClock,
} from './common/config';
import { APP_LOGGER, AppLogger, FileLogger } from './common/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.enableShutdownHooks();

  const logger = app.get<AppLogger>(APP_LOGGER);
  // 별도로 loadConfig()를 부르지 않는다 — 앱이 실제로 주입받은 설정을 그대로 검사해야 한다.
  for (const warning of configWarnings(app.get<AppConfig>(APP_CONFIG))) {
    logger.log('WARN', 'storage', warning);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log('INFO', 'http', `서버 기동 완료: http://localhost:${port}`);
}

/**
 * jobs.json이 손상됐으면 자동 초기화하지 않고 여기로 온다 — 데이터를 지키는 쪽을
 * 택했으므로, 사람이 파일을 확인할 수 있게 비-0 종료 코드로 멈춘다.
 */
bootstrap().catch(async (error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);

  // stderr를 먼저 쓴다 — 아래 로깅이 실패해도 원인은 남는다.
  process.stderr.write(`기동 실패: ${detail}\n`);

  try {
    // DI 컨테이너가 없으므로 로거를 직접 만든다. 설정 자체가 잘못돼 기동이
    // 실패한 경우 loadConfig()도 다시 던지므로 기본값으로 되돌린다.
    let config: AppConfig;
    try {
      config = loadConfig();
    } catch {
      config = DEFAULT_CONFIG;
    }
    const logger = new FileLogger(config, new SystemClock());
    logger.log('ERROR', 'storage', `기동 실패: ${detail}`);
    await logger.flush();
  } catch {
    // 로깅 실패가 종료 코드를 가리지 않게 한다.
  }

  process.exit(1);
});
