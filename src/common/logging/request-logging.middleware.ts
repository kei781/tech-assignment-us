/**
 * HTTP 요청 로깅. SPEC §6 [LOG-003]
 *
 * 인터셉터가 아니라 미들웨어인 이유:
 * 인터셉터는 예외를 만나면 exception filter가 응답 상태 코드를 확정하기 *전에*
 * 종료되므로, 에러 응답의 실제 상태 코드를 알 수 없다. 미들웨어에서
 * `res.on('finish')`를 걸면 라우트 미매칭·validation 실패·filter가 만든 응답까지
 * 전부 최종 상태 코드로 기록된다 — [LOG-003]이 요구하는 "모든 요청"을 만족한다.
 */
import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { APP_LOGGER, AppLogger } from './app-logger';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    // originalUrl은 query string을 포함한다([LOG-003]).
    const target = req.originalUrl || req.url;
    const method = req.method;

    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = res.statusCode;
      const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
      this.logger.log(level, 'http', `${method} ${target} ${status} ${elapsedMs.toFixed(0)}ms`);
    });

    next();
  }
}
