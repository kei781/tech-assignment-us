import { Inject, Injectable, NestMiddleware, OnApplicationShutdown } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { APP_CONFIG, AppConfig, CLOCK, Clock, isoNow } from './config';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export type LogScope = 'http' | 'scheduler' | 'storage';

export interface AppLogger {
  /** 기록 실패가 호출자를 실패시키지 않으므로 동기 시그니처다. */
  log(level: LogLevel, scope: LogScope, message: string): void;
  flush(): Promise<void>;
}

export const APP_LOGGER = Symbol('APP_LOGGER');

export function formatLogLine(
  iso: string,
  level: LogLevel,
  scope: LogScope,
  message: string,
): string {
  // 개행이 섞이면 한 항목이 여러 라인으로 쪼개져 형식이 깨진다.
  const singleLine = message.replace(/\r?\n/g, ' ');
  return `[${iso}] [${level}] [${scope}] ${singleLine}\n`;
}

@Injectable()
export class FileLogger implements AppLogger, OnApplicationShutdown {
  /** append를 직렬화해 호출 순서와 파일 순서를 일치시킨다. */
  private appendChain: Promise<void> = Promise.resolve();

  private logDirEnsured = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  log(level: LogLevel, scope: LogScope, message: string): void {
    const line = formatLogLine(isoNow(this.clock), level, scope, message);

    this.appendChain = this.appendChain.then(
      () => this.append(line),
      () => this.append(line),
    );
  }

  flush(): Promise<void> {
    return this.appendChain.catch(() => undefined);
  }

  /**
   * log()가 append를 예약만 하고 반환하므로, Nest가 shutdown hook 직후
   * 프로세스를 재종료하면 대기 중이던 요청·처리 로그가 유실된다.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  private async append(line: string): Promise<void> {
    try {
      const filePath = path.resolve(this.config.logFilePath);
      if (!this.logDirEnsured) {
        await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined);
        this.logDirEnsured = true;
      }
      await fs.appendFile(filePath, line, 'utf8');
    } catch {
      // 로깅 실패로 요청이나 스케줄러 처리를 실패시키지 않는다.
    }
  }
}

/**
 * 인터셉터가 아니라 미들웨어인 이유: 인터셉터는 예외를 만나면 exception filter가
 * 응답 상태 코드를 확정하기 *전에* 종료되므로 에러 응답의 실제 코드를 알 수 없다.
 * `res.on('finish')`는 라우트 미매칭·validation 실패·filter가 만든 응답까지
 * 전부 최종 코드로 기록한다.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
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
