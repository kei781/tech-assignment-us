/**
 * 공통 에러 응답 형식. SPEC §4.1 [API-001], [API-002], [API-004]
 *
 * 모든 응답 본문은 `{ status, result }` 형태이며 `status`는 HTTP 상태 코드와 항상 일치한다.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { Response } from 'express';
import { APP_LOGGER, AppLogger } from '../logging/app-logger';

const INTERNAL_ERROR_MESSAGE = '요청 처리 중 오류가 발생했습니다.';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const result =
      exception instanceof HttpException
        ? extractMessage(exception)
        : INTERNAL_ERROR_MESSAGE;

    // [API-004] 내부 오류는 원인을 남긴다. 응답 본문에는 노출하지 않는다.
    if (!(exception instanceof HttpException)) {
      const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
      this.logger.log('ERROR', 'http', `처리되지 않은 예외: ${detail}`);
    }

    // [API-002] 본문 status는 실제 HTTP 상태 코드와 일치한다.
    res.status(status).json({ status, result });
  }
}

/**
 * HttpException의 사유 문자열을 뽑는다.
 * ValidationPipe는 `{ message: string[] }` 형태로 던지므로 합쳐서 한 문장으로 만든다([API-003]).
 */
function extractMessage(exception: HttpException): string {
  const response = exception.getResponse();

  if (typeof response === 'string') return response;

  if (typeof response === 'object' && response !== null) {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  }

  return exception.message;
}
