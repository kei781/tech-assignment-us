/**
 * 설정·시계·로거·공통 에러 형식. 애플리케이션 전역에서 쓰인다.
 */
import { Global, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { CLOCK, SystemClock } from './clock';
import { APP_CONFIG, loadConfig } from './config';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { APP_LOGGER } from './logging/app-logger';
import { FileLogger } from './logging/file-logger';
import { RequestLoggingMiddleware } from './logging/request-logging.middleware';

@Global()
@Module({
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
  exports: [APP_CONFIG, CLOCK, APP_LOGGER, RequestLoggingMiddleware],
})
export class CommonModule {}
