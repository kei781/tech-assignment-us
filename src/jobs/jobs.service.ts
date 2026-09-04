import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, Clock, isoNow } from '../common/config';
import { CreateJobDto, SearchJobsDto, UpdateJobDto } from './jobs.dto';
import { JobsStore } from './jobs.store';
import { compareJobs, Job, MESSAGES } from './jobs.types';

@Injectable()
export class JobsService {
  constructor(
    private readonly store: JobsStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(dto: CreateJobDto): Promise<Job> {
    return this.store.mutate((draft) => {
      const now = isoNow(this.clock);
      const job: Job = {
        id: randomUUID(),
        title: dto.title,
        description: dto.description,
        status: 'create',
        createdAt: now,
        updatedAt: now,
      };
      draft.jobs.push(job);
      return { ...job };
    });
  }

  findAll(): Job[] {
    return this.store.read((file) => file.jobs.sort(compareJobs));
  }

  search(dto: SearchJobsDto): Job[] {
    const title = dto.title?.toLowerCase();
    const description = dto.description?.toLowerCase();

    return this.store.read((file) =>
      file.jobs
        .filter((job) => {
          if (title !== undefined && !job.title.toLowerCase().includes(title)) return false;
          if (description !== undefined && !job.description.toLowerCase().includes(description)) {
            return false;
          }
          if (dto.status !== undefined && job.status !== dto.status) return false;
          return true;
        })
        .sort(compareJobs),
    );
  }

  findOne(id: string): Job {
    const job = this.store.read((file) => file.jobs.find((candidate) => candidate.id === id));
    if (!job) throw new NotFoundException(MESSAGES.notFound);
    return job;
  }

  /**
   * 처리 중인 Job을 API가 덮어쓰지 못하게 막는 지점 — 과제의 핵심 질문에 대한 답이다.
   * 상태 검사와 수정이 같은 mutex 구간에 있으므로 "검사를 통과한 직후 스케줄러가
   * 선점" 같은 창이 없고, 반대로 수정이 진행되는 동안 선점도 끼어들지 못한다.
   */
  async update(id: string, dto: UpdateJobDto): Promise<Job> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((candidate) => candidate.id === id);

      // 이 순서가 곧 응답 사유의 우선순위다 — 바꾸면 클라이언트가 보는 메시지가 달라진다.
      if (!job) throw new NotFoundException(MESSAGES.notFound);
      if (job.status === 'done') throw new ConflictException(MESSAGES.alreadyDone);
      if (job.status === 'pending') throw new ConflictException(MESSAGES.inProgress);

      if (dto.title !== undefined) job.title = dto.title;
      if (dto.description !== undefined) job.description = dto.description;
      job.updatedAt = isoNow(this.clock);

      return { ...job };
    });
  }

  /** 가장 오래된 대기 Job 하나를 선점한다. 대상이 없으면 null. */
  async claimNext(): Promise<Job | null> {
    return this.store.mutate((draft) => {
      const candidate = draft.jobs.filter((job) => job.status === 'create').sort(compareJobs)[0];

      if (!candidate) return null;

      candidate.status = 'pending';
      candidate.updatedAt = isoNow(this.clock);
      return { ...candidate };
    });
  }

  /** 처리하는 동안 다른 주체가 상태를 바꿨다면 그 결과를 덮어쓰지 않는다. */
  async markDone(id: string): Promise<boolean> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((candidate) => candidate.id === id);
      if (!job || job.status !== 'pending') return false;

      job.status = 'done';
      job.updatedAt = isoNow(this.clock);
      return true;
    });
  }

  async rollbackToCreate(id: string): Promise<boolean> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((candidate) => candidate.id === id);
      if (!job || job.status !== 'pending') return false;

      job.status = 'create';
      job.updatedAt = isoNow(this.clock);
      return true;
    });
  }
}
