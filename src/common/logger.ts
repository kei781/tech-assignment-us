/**
 * 로깅. SPEC §6 [LOG-001] ~ [LOG-005]
 *
 * 계약·파일 로거·요청 로깅 미들웨어를 한 파일에 둔다 — "로깅은 어디 있나"에 대한
 * 답이 한 곳이 되도록.
 */
import { Inject, Injectable, NestMiddleware, OnApplicationShutdown } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { APP_CONFIG, AppConfig, CLOCK, Clock, isoNow } from './config';

// ── 계약 ──

/** [LOG-002] LEVEL */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** [LOG-002] scope */
export type LogScope = 'http' | 'scheduler' | 'storage';

export interface AppLogger {
  /**
   * 한 항목을 기록한다.
   * [LOG-005] 기록 실패가 호출자를 실패시키지 않으므로 동기 시그니처다.
   */
  log(level: LogLevel, scope: LogScope, message: string): void;
  /** 대기 중인 기록이 모두 끝날 때까지 기다린다 (테스트·정상 종료용) */
  flush(): Promise<void>;
}

export const APP_LOGGER = Symbol('APP_LOGGER');

/** [LOG-002] 로그 라인 형식: `[ISO8601 UTC] [LEVEL] [scope] message` */
export function formatLogLine(
  iso: string,
  level: LogLevel,
  scope: LogScope,
  message: string,
): string {
  // 개행이 섞이면 한 항목이 여러 라인으로 쪼개져 형식이 깨지므로 치환한다.
  const oneLine = message.replace(/\r?\n/g, ' ');
  return `[${iso}] [${level}] [${scope}] ${oneLine}\n`;
}

// ── logs.txt 파일 로거 ──

@Injectable()
export class FileLogger implements AppLogger, OnApplicationShutdown {
  /**
   * append를 직렬화한다. [LOG-001] 한 항목은 한 번의 append 호출로 기록되며,
   * 체인 덕분에 호출 순서가 파일 순서와 일치한다.
   */
  private tail: Promise<void> = Promise.resolve();

  private dirEnsured = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  log(level: LogLevel, scope: LogScope, message: string): void {
    const line = formatLogLine(isoNow(this.clock), level, scope, message);

    // [LOG-005] best-effort: 기록 실패가 API 응답이나 스케줄러 처리를 실패시키지 않는다.
    this.tail = this.tail.then(
      () => this.append(line),
      () => this.append(line),
    );
  }

  flush(): Promise<void> {
    return this.tail.catch(() => undefined);
  }

  /**
   * 종료 시 예약된 append를 마무리한다.
   * log()는 비동기로 예약하고 즉시 반환하므로, Nest가 shutdown hook 직후
   * 프로세스를 재종료하면 대기 중이던 요청·처리 로그가 유실된다([LOG-003], [LOG-004]).
   */
  async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  private async append(line: string): Promise<void> {
    try {
      const filePath = path.resolve(this.config.logFilePath);
      if (!this.dirEnsured) {
        await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined);
        this.dirEnsured = true;
      }
      await fs.appendFile(filePath, line, 'utf8');
    } catch {
      // [LOG-005] 삼킨다. 로깅 실패로 요청·처리를 실패시키지 않는다.
    }
  }
}

// ── HTTP 요청 로깅 ──

/**
 * [LOG-003] 모든 HTTP 요청을 로깅한다.
 *
 * 인터셉터가 아니라 미들웨어인 이유:
 * 인터셉터는 예외를 만나면 exception filter가 응답 상태 코드를 확정하기 *전에*
 * 종료되므로, 에러 응답의 실제 상태 코드를 알 수 없다. 미들웨어에서
 * `res.on('finish')`를 걸면 라우트 미매칭·validation 실패·filter가 만든 응답까지
 * 전부 최종 상태 코드로 기록된다 — [LOG-003]이 요구하는 "모든 요청"을 만족한다.
 */
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
