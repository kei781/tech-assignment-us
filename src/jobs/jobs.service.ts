/**
 * Job 도메인 로직. SPEC §4, §5
 *
 * jobs.json에 접근하는 모든 경로가 이 클래스를 지난다. 변경은 예외 없이
 * JobsStore.mutate([CON-002])를 통과하므로, HTTP 핸들러와 스케줄러가
 * 같은 데이터를 동시에 건드려도 직렬화된다.
 */
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

  /** [API-010] ~ [API-012] */
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

  /** [API-020] createdAt ASC, 동률 시 id ASC */
  findAll(): Job[] {
    return this.store.read((file) => file.jobs.sort(compareJobs));
  }

  /** [API-031] title/description은 대소문자 무시 부분 일치, status는 정확 일치, 복수 조건은 AND */
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

  /** [API-040] */
  findOne(id: string): Job {
    const job = this.store.read((file) => file.jobs.find((candidate) => candidate.id === id));
    if (!job) throw new NotFoundException(MESSAGES.notFound);
    return job;
  }

  /**
   * [API-050] ~ [API-053], [CON-005]
   * 상태 검사와 수정이 같은 mutex 구간에서 이루어지므로 "검사를 통과한 직후
   * 스케줄러가 선점" 같은 창이 존재하지 않는다.
   */
  async update(id: string, dto: UpdateJobDto): Promise<Job> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((candidate) => candidate.id === id);

      // [API-053] 판정 우선순위: ① 존재 → ② done → ③ pending
      if (!job) throw new NotFoundException(MESSAGES.notFound);
      if (job.status === 'done') throw new ConflictException(MESSAGES.alreadyDone);
      if (job.status === 'pending') throw new ConflictException(MESSAGES.inProgress);

      if (dto.title !== undefined) job.title = dto.title;
      if (dto.description !== undefined) job.description = dto.description;
      job.updatedAt = isoNow(this.clock);

      return { ...job };
    });
  }

  /**
   * [SCH-003] 선점. create 중 가장 오래된 Job 하나를 pending으로 커밋하고 반환한다.
   * 대상이 없으면 null.
   */
  async claimNext(): Promise<Job | null> {
    return this.store.mutate((draft) => {
      const candidate = draft.jobs
        .filter((job) => job.status === 'create')
        .sort(compareJobs)[0];

      if (!candidate) return null;

      candidate.status = 'pending';
      candidate.updatedAt = isoNow(this.clock);
      return { ...candidate };
    });
  }

  /**
   * [SCH-004] 완료. 여전히 pending인지 확인한 뒤에만 done으로 커밋한다.
   * 상태가 바뀌어 있으면 덮어쓰지 않고 false를 반환한다.
   */
  async markDone(id: string): Promise<boolean> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((candidate) => candidate.id === id);
      if (!job || job.status !== 'pending') return false;

      job.status = 'done';
      job.updatedAt = isoNow(this.clock);
      return true;
    });
  }

  /** [SCH-005] 처리 실패 롤백. pending일 때만 create로 되돌린다. */
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
