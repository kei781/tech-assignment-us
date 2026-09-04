/**
 * 루트 모듈. SPEC §1.1 — HTTP 서버와 스케줄러가 한 프로세스에서 함께 실행된다.
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { RequestLoggingMiddleware } from './common/logging/request-logging.middleware';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [ScheduleModule.forRoot(), CommonModule, JobsModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // [LOG-003] 모든 HTTP 요청을 로깅한다 — 라우트 미매칭·validation 실패 포함.
    // Express 5(path-to-regexp v8)에서는 와일드카드에 이름이 필요하다.
    consumer.apply(RequestLoggingMiddleware).forRoutes('{*splat}');
  }
}
