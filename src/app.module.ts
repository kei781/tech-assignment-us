import { Global, MiddlewareConsumer, Module, NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_CONFIG, CLOCK, loadConfig, SystemClock } from './common/config';
import { AllExceptionsFilter } from './common/exception.filter';
import { APP_LOGGER, FileLogger, RequestLoggingMiddleware } from './common/logger';
import { JobsModule } from './jobs/jobs.module';

/** HTTP 서버와 스케줄러를 한 프로세스에서 함께 띄운다. */
@Global()
@Module({
  imports: [ScheduleModule.forRoot(), JobsModule],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: CLOCK, useClass: SystemClock },
    { provide: APP_LOGGER, useClass: FileLogger },
    RequestLoggingMiddleware,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          transform: true,
          // 정의되지 않은 필드를 거부한다 — status를 API로 바꾸려는 요청을 막는다.
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
    // Express 5(path-to-regexp v8)에서는 와일드카드에 이름이 필요하다.
    consumer.apply(RequestLoggingMiddleware).forRoutes('{*splat}');
  }
}
