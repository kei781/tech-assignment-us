import { Module } from '@nestjs/common';
import { DelayJobTask, JOB_TASK } from './job-task';
import { JobsController } from './jobs.controller';
import { JobsProcessor } from './jobs.processor';
import { JobsService } from './jobs.service';
import { JobsStore } from './jobs.store';

@Module({
  controllers: [JobsController],
  providers: [
    JobsStore,
    JobsService,
    JobsProcessor,
    // [SCH-004] 실제 처리 로직은 주입 가능하다 — 테스트가 교체한다([TST-002]).
    { provide: JOB_TASK, useClass: DelayJobTask },
  ],
  exports: [JobsService, JobsStore, JobsProcessor],
})
export class JobsModule {}
