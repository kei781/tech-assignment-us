import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { DelayJobTask, JOB_TASK, JobsProcessor } from './jobs.processor';
import { JobsService } from './jobs.service';
import { JobsStore } from './jobs.store';

@Module({
  controllers: [JobsController],
  providers: [
    JobsStore,
    JobsService,
    JobsProcessor,
    { provide: JOB_TASK, useClass: DelayJobTask },
  ],
  exports: [JobsService, JobsStore, JobsProcessor],
})
export class JobsModule {}
