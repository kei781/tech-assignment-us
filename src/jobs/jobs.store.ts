import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Config, JsonDB } from 'node-json-db';
import { APP_CONFIG, AppConfig, CLOCK, Clock, isoNow } from '../common/config';
import { APP_LOGGER, AppLogger } from '../common/logger';
import { emptyJobsFile, findJobsFileViolation, JobsFile } from './jobs.types';

export class JobsFileLoadError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'JobsFileLoadError';
  }
}

/**
 * 과제가 요구한 "API와 스케줄러가 같은 데이터를 동시에 건드려도 손실·손상되지 않게"를
 * 이 클래스 하나로 답한다. 둘이 같은 이벤트 루프에서 돌고 `await` 지점마다 실행이
 * 교차하므로, 단일 스레드라도 lost update가 실재한다.
 */
@Injectable()
export class JobsStore implements OnModuleInit {
  /** 쓰는 주체가 이 프로세스 하나뿐이므로, 디스크가 아니라 이쪽이 단일 진실 소스다. */
  private inMemoryState: JobsFile = emptyJobsFile();

  /** 변경을 직렬화하는 mutex. */
  private mutexChain: Promise<unknown> = Promise.resolve();

  private initialized = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const filePath = path.resolve(this.config.jobsFilePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // node-json-db는 파일이 없으면 load()에서 `{}`로 만들어버린다.
    // 스키마를 보장하려면 우리가 먼저 만들어야 한다.
    if (!(await this.fileExists(filePath))) {
      await this.writeAtomically(filePath, this.serialize(emptyJobsFile()));
      this.logger.log('INFO', 'storage', `jobs.json이 없어 새로 생성했습니다: ${filePath}`);
    }

    this.inMemoryState = await this.loadFromDisk(filePath);

    const recovered = await this.recoverStrandedPendingJobs();
    this.logger.log(
      'INFO',
      'storage',
      `기동 복구 완료: pending → create ${recovered}건, 전체 ${this.inMemoryState.jobs.length}건 로드 (${filePath})`,
    );

    this.initialized = true;
  }

  /**
   * 변경이 동기 구간에서만 적용되므로(mutate 참고) 읽기는 부분 적용 상태를
   * 관측할 수 없다. 그래서 읽기는 mutex를 타지 않는다.
   */
  read<T>(select: (file: JobsFile) => T): T {
    return select(this.snapshot());
  }

  snapshot(): JobsFile {
    return JSON.parse(this.serialize(this.inMemoryState)) as JobsFile;
  }

  /**
   * 복사본에 변경을 적용하고, **저장이 성공한 뒤에만** 인메모리 참조를 교체한다.
   * 순서를 뒤집으면 저장 실패 시 메모리와 디스크가 어긋나고, 이후 모든 응답이
   * 저장되지 않은 데이터를 사실처럼 반환한다.
   *
   * 조건 검사도 이 안에서 해야 한다 — 검사와 변경이 같은 구간에 있어야
   * "검사를 통과한 직후 다른 쪽이 상태를 바꾸는" 창이 생기지 않는다.
   */
  async mutate<T>(apply: (draft: JobsFile) => T | Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      const before = this.serialize(this.inMemoryState);
      const draft = JSON.parse(before) as JobsFile;

      const result = await apply(draft);

      const after = this.serialize(draft);
      if (after !== before) {
        await this.writeAtomically(path.resolve(this.config.jobsFilePath), after);
        this.inMemoryState = draft;
      }
      return result;
    });
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    // 성공·실패 양쪽에 같은 콜백을 연결한다. 한쪽만 연결하면 앞선 변경이 실패했을 때
    // 체인이 끊겨 이후 모든 변경이 영구히 멈춘다.
    const result = this.mutexChain.then(task, task);
    this.mutexChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 쓰는 주체가 하나이므로 기동 시점에 진행 중인 처리는 존재할 수 없다.
   * 따라서 남아 있는 pending은 예외 없이 이전 실행이 처리 중 죽은 잔여물이고,
   * 되돌리는 것이 항상 옳다. 이 한 규칙이 lease·heartbeat·리더 선출을 대체한다.
   */
  private async recoverStrandedPendingJobs(): Promise<number> {
    return this.mutate((draft) => {
      const now = isoNow(this.clock);
      let recovered = 0;

      for (const job of draft.jobs) {
        if (job.status === 'pending') {
          job.status = 'create';
          job.updatedAt = now;
          recovered += 1;
        }
      }

      return recovered;
    });
  }

  private async loadFromDisk(filePath: string): Promise<JobsFile> {
    let raw: unknown;
    try {
      // saveOnPush=false — 디스크 게시는 writeAtomically가 전담한다.
      const db = new JsonDB(new Config(filePath, false, true, '/'));
      await db.load();
      raw = await db.getObject<unknown>('/');
    } catch (error) {
      throw new JobsFileLoadError(
        `jobs.json을 파싱할 수 없습니다 (${filePath}). 데이터 보호를 위해 자동 초기화하지 않습니다.`,
        error,
      );
    }

    const violation = findJobsFileViolation(raw);
    if (violation) {
      throw new JobsFileLoadError(
        `jobs.json이 스키마를 위반합니다 (${filePath}): ${violation}. 데이터 보호를 위해 자동 초기화하지 않습니다.`,
      );
    }

    // getObject는 내부 참조를 반환한다.
    return { jobs: (raw as JobsFile).jobs.map((job) => ({ ...job })) };
  }

  /**
   * node-json-db의 save는 대상 파일에 직접 쓰므로, 쓰는 중 프로세스가 죽으면
   * 절단된 JSON이 남아 다시 로드할 수 없다. rename은 원자적이라 임시 파일에
   * 다 쓰고 교체하면 jobs.json이 항상 이전 또는 이후의 완전한 상태다.
   */
  private async writeAtomically(filePath: string, serialized: string): Promise<void> {
    const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;

    try {
      const handle = await fs.open(tmpPath, 'wx');
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.rename(tmpPath, filePath);
    } catch (error) {
      // write·fsync·close·rename 어디서 실패해도 정리한다. rename만 정리하면
      // 반복되는 디스크 오류가 숨겨진 .tmp를 계속 누적시킨다.
      // open 자체가 실패했다면 tmpPath가 없으므로 force가 ENOENT를 무시한다.
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serialize(file: JobsFile): string {
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
