/**
 * 루트 모듈. SPEC §1.1 — HTTP 서버와 스케줄러가 한 프로세스에서 함께 실행된다.
 *
 * 설정·시계·로거·공통 에러 형식·전역 pipe를 여기서 전부 등록한다.
 */
import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_CONFIG, CLOCK, loadConfig, SystemClock } from './common/config';
import { AllExceptionsFilter } from './common/exception.filter';
import { APP_LOGGER, FileLogger, RequestLoggingMiddleware } from './common/logger';
import { JobsModule } from './jobs/jobs.module';

@Global()
@Module({
  imports: [ScheduleModule.forRoot(), JobsModule],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: CLOCK, useClass: SystemClock },
    { provide: APP_LOGGER, useClass: FileLogger },
    RequestLoggingMiddleware,
    // [API-001] 모든 에러 응답을 공통 형식으로 변환
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // [API-003] 정의되지 않은 필드를 거부하고 DTO 변환을 수행
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
          // query parameter는 항상 문자열로 오므로 암묵 변환을 끈다.
          transformOptions: { enableImplicitConversion: false },
        }),
    },
  ],
  exports: [APP_CONFIG, CLOCK, APP_LOGGER],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // [LOG-003] 모든 HTTP 요청을 로깅한다 — 라우트 미매칭·validation 실패 포함.
    // Express 5(path-to-regexp v8)에서는 와일드카드에 이름이 필요하다.
    consumer.apply(RequestLoggingMiddleware).forRoutes('{*splat}');
  }
}
