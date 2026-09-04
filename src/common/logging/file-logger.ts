/**
 * logs.txt 파일 로거. SPEC §6 [LOG-001], [LOG-002], [LOG-005]
 */
import { Inject, Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CLOCK, Clock, isoNow } from '../clock';
import { APP_CONFIG, AppConfig } from '../config';
import { AppLogger, formatLogLine, LogLevel, LogScope } from './app-logger';

@Injectable()
export class FileLogger implements AppLogger {
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
