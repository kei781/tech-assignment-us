/**
 * jobs.json 저장소. SPEC §3 [CON-002] ~ [CON-004], [CON-006], [RUN-004]
 *
 * 이 클래스가 동시성 설계 전체를 담는다.
 *  - [CON-002] 모든 변경은 단일 mutex를 통과하고, 저장 성공 후에만 인메모리 상태를 교체한다.
 *  - [CON-003] 저장은 임시 파일 + fsync + 원자적 rename으로 수행한다.
 *  - [CON-004] 읽기는 인메모리 스냅샷에서 동기적으로 수행한다.
 *  - [CON-006] 기동 시 pending Job을 create로 되돌린다.
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Config, JsonDB } from 'node-json-db';
import { CLOCK, Clock, isoNow } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../common/config';
import { APP_LOGGER, AppLogger } from '../common/logging/app-logger';
import { emptyJobsFile, JobsFile } from './jobs.types';

/** [RUN-004] jobs.json을 신뢰할 수 없어 기동을 중단해야 하는 상황 */
export class JobsFileLoadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'JobsFileLoadError';
  }
}

@Injectable()
export class JobsStore implements OnModuleInit {
  /**
   * [CON-004] writer가 이 프로세스 하나이므로([CON-001]) 디스크가 아니라
   * 이 인메모리 상태가 단일 진실 소스다.
   */
  private state: JobsFile = emptyJobsFile();

  /** [CON-002] mutex — promise chain. 새 작업은 직전 작업의 완료(성공·실패 무관) 뒤에 실행된다. */
  private tail: Promise<unknown> = Promise.resolve();

  private initialized = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  /** [RUN-004] 부트스트랩: 디렉터리 생성 → genesis 생성 → 로드 → [CON-006] 기동 복구 */
  async init(): Promise<void> {
    if (this.initialized) return;

    const filePath = path.resolve(this.config.jobsFilePath);

    // ① 상위 디렉터리가 없으면 생성
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // ② 파일이 없으면 { "jobs": [] }로 생성.
    //    node-json-db는 파일이 없을 때 load()에서 {}로 만들어버리므로,
    //    스키마를 보장하기 위해 먼저 우리가 원자적으로 만든다.
    if (!(await this.exists(filePath))) {
      await this.writeAtomic(filePath, this.serialize(emptyJobsFile()));
      this.logger.log('INFO', 'storage', `jobs.json이 없어 새로 생성했습니다: ${filePath}`);
    }

    // ③ 로드 — 파싱은 node-json-db가 담당한다.
    this.state = await this.load(filePath);

    // ④ [CON-006] 기동 복구
    const recovered = await this.recoverPending();
    this.logger.log(
      'INFO',
      'storage',
      `기동 복구 완료: pending → create ${recovered}건, 전체 ${this.state.jobs.length}건 로드 (${filePath})`,
    );

    this.initialized = true;
  }

  /**
   * [CON-004] 읽기. 인메모리 스냅샷을 만들어 콜백에 넘긴다.
   * [CON-002]의 변경이 동기 구간에서 적용되므로 읽기는 mutex를 필요로 하지 않는다.
   */
  read<T>(fn: (file: JobsFile) => T): T {
    return fn(this.snapshot());
  }

  /** 인메모리 상태의 깊은 복사본 */
  snapshot(): JobsFile {
    return JSON.parse(this.serialize(this.state)) as JobsFile;
  }

  /**
   * [CON-002] 변경. 순서를 반드시 지킨다.
   *   1) 현재 인메모리 상태의 복사본을 만든다
   *   2) 복사본에 변경을 적용한다 (검증·조건 검사도 이 안에서 수행)
   *   3) 복사본을 [CON-003]으로 저장한다
   *   4) 저장이 성공한 뒤에만 인메모리 참조를 교체한다
   *
   * 콜백이 예외를 던지면 아무것도 저장되지 않고 인메모리 상태도 그대로다.
   * 콜백이 draft를 바꾸지 않았으면 디스크 쓰기를 생략한다.
   */
  async mutate<T>(fn: (draft: JobsFile) => T | Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      const before = this.serialize(this.state); // 1)
      const draft = JSON.parse(before) as JobsFile;

      const result = await fn(draft); // 2)

      const after = this.serialize(draft);
      if (after !== before) {
        await this.writeAtomic(path.resolve(this.config.jobsFilePath), after); // 3)
        this.state = draft; // 4)
      }
      return result;
    });
  }

  /**
   * [CON-002] mutex. 새 작업은 직전 작업이 끝난 뒤에 실행된다.
   * 직전 작업이 실패해도 체인이 끊기지 않도록 성공·실패 모두 같은 콜백에 연결한다.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** [CON-006] pending → create 복구. 복구 건수를 반환한다. */
  private async recoverPending(): Promise<number> {
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

  /** node-json-db로 파싱한다. 손상 파일은 자동 초기화하지 않고 오류를 던진다([RUN-004]). */
  private async load(filePath: string): Promise<JobsFile> {
    let raw: unknown;
    try {
      // saveOnPush=false: 디스크 게시는 [CON-003] 절차가 전담한다.
      const db = new JsonDB(new Config(filePath, false, true, '/'));
      await db.load();
      raw = await db.getObject<unknown>('/');
    } catch (error) {
      throw new JobsFileLoadError(
        `jobs.json을 파싱할 수 없습니다 (${filePath}). 데이터 보호를 위해 자동 초기화하지 않습니다.`,
        error,
      );
    }

    // [DATA-001] 최상위 키 jobs(배열) 검증
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as JobsFile).jobs)) {
      throw new JobsFileLoadError(
        `jobs.json의 최상위 jobs 배열을 찾을 수 없습니다 (${filePath}). 데이터 보호를 위해 자동 초기화하지 않습니다.`,
      );
    }

    // getObject는 내부 참조를 반환하므로 복사해서 보관한다.
    return { jobs: (raw as JobsFile).jobs.map((job) => ({ ...job })) };
  }

  /**
   * [CON-003] 원자적 저장.
   * 임시 파일에 전체 내용을 쓰고 fsync한 뒤 rename으로 교체한다.
   * rename은 원자적이므로 저장 도중 프로세스가 죽어도 jobs.json은 항상
   * 이전 또는 이후의 완전한 상태이며, 절단된 파일이 남지 않는다.
   */
  private async writeAtomic(filePath: string, serialized: string): Promise<void> {
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
      // open 이후의 모든 실패 지점(write·fsync·close·rename)에서 임시 파일을 정리한다.
      // rename만 정리하면 반복되는 디스크 오류가 숨겨진 .tmp를 계속 누적시킨다.
      // open 자체가 실패했다면 tmpPath가 없으므로 force:true가 ENOENT를 무시한다.
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serialize(file: JobsFile): string {
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
