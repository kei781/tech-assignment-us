import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { Response } from 'express';
import { APP_LOGGER, AppLogger } from './logger';

const INTERNAL_ERROR_MESSAGE = '요청 처리 중 오류가 발생했습니다.';

/**
 * 성공·실패 응답의 본문 형식을 `{ status, result }` 하나로 고정하기 위해,
 * 에러 응답도 전부 이 한 곳에서 만든다.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const isHttpException = exception instanceof HttpException;

    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const result = isHttpException ? extractMessage(exception) : INTERNAL_ERROR_MESSAGE;

    // 내부 오류의 원인은 로그로만 남긴다 — 응답 본문에 노출하지 않는다.
    if (!isHttpException) {
      const detail =
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
      this.logger.log('ERROR', 'http', `처리되지 않은 예외: ${detail}`);
    }

    res.status(status).json({ status, result });
  }
}

function extractMessage(exception: HttpException): string {
  const response = exception.getResponse();

  if (typeof response === 'string') return response;

  if (typeof response === 'object' && response !== null) {
    const message = (response as { message?: unknown }).message;
    // ValidationPipe는 위반 사유를 배열로 던진다.
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  }

  return exception.message;
}
