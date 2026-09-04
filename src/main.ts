/**
 * 부트스트랩. SPEC [RUN-002], [RUN-004], [CON-007]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SystemClock } from './common/clock';
import { APP_CONFIG, AppConfig, configWarnings, DEFAULT_CONFIG, loadConfig } from './common/config';
import { APP_LOGGER, AppLogger } from './common/logging/app-logger';
import { FileLogger } from './common/logging/file-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // [CON-007] SIGINT/SIGTERM에서 onApplicationShutdown이 실행되게 한다.
  app.enableShutdownHooks();

  const logger = app.get<AppLogger>(APP_LOGGER);
  // 앱이 실제로 주입받은 설정을 그대로 검사한다.
  for (const warning of configWarnings(app.get<AppConfig>(APP_CONFIG))) {
    logger.log('WARN', 'storage', warning);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log('INFO', 'http', `서버 기동 완료: http://localhost:${port}`);
}

bootstrap().catch(async (error: unknown) => {
  // [RUN-004] jobs.json이 손상된 경우 자동 초기화하지 않고 비-0 종료 코드로 중단한다.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);

  // stderr를 먼저 쓴다 — 아래 로깅이 실패해도 원인은 남는다.
  process.stderr.write(`기동 실패: ${detail}\n`);

  // DI가 아직 없으므로 로거를 직접 만든다(best-effort).
  // 설정 자체가 잘못돼 기동이 실패한 경우 loadConfig()도 던지므로 기본값으로 되돌린다.
  try {
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
    // 로깅 실패가 종료 코드를 가리지 않게 한다([LOG-005]).
  }

  process.exit(1);
});
