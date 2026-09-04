/**
 * 실제 처리 로직. SPEC [SCH-004]
 *
 * 과제는 비즈니스 작업을 정의하지 않는다. 기본 구현은 `JOB_PROCESSING_MS` 동안
 * 처리한 것으로 간주하며, 테스트는 이 토큰을 교체해 실제 대기 없이 검증한다([TST-002]).
 */
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config';
import { Job } from './jobs.types';

export interface JobTask {
  run(job: Job): Promise<void>;
}

export const JOB_TASK = Symbol('JOB_TASK');

@Injectable()
export class DelayJobTask implements JobTask {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async run(_job: Job): Promise<void> {
    const ms = this.config.jobProcessingMs;
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
