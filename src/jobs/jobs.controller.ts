/**
 * REST API. SPEC §4
 *
 * 응답 본문은 전부 [API-001] 형식이며 `status`는 HTTP 상태 코드를 미러링한다([API-002]).
 * 에러 경로는 AllExceptionsFilter가 같은 형식으로 변환한다.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CreateJobDto, SearchJobsDto, UpdateJobDto } from './jobs.dto';
import { JobsService } from './jobs.service';
import { Job, MESSAGES } from './jobs.types';

/** [API-040] :id는 UUID 형식(버전 무관)이어야 하며, 아니면 400 */
const uuidParam = new ParseUUIDPipe({
  exceptionFactory: () => new BadRequestException(MESSAGES.invalidId),
});

interface Envelope {
  status: number;
  result: string;
}

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** [API-010] ~ [API-012] */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateJobDto): Promise<Envelope & { job: Job }> {
    const job = await this.jobs.create(dto);
    return { status: HttpStatus.CREATED, result: MESSAGES.success, job };
  }

  /** [API-020] */
  @Get()
  findAll(): Envelope & { list: Job[] } {
    return { status: HttpStatus.OK, result: MESSAGES.success, list: this.jobs.findAll() };
  }

  /**
   * [API-030] ~ [API-032]
   * [API-005] 이 라우트는 반드시 `:id`보다 먼저 선언되어야 한다.
   */
  @Get('search')
  search(@Query() dto: SearchJobsDto): Envelope & { list: Job[] } {
    const list = this.jobs.search(dto);
    return {
      status: HttpStatus.OK,
      // [API-032] 결과 없음은 200이면서 result에 사유 메시지를 담는 유일한 예외다.
      result: list.length > 0 ? MESSAGES.success : MESSAGES.searchEmpty,
      list,
    };
  }

  /** [API-040] */
  @Get(':id')
  findOne(@Param('id', uuidParam) id: string): Envelope & { job: Job } {
    return { status: HttpStatus.OK, result: MESSAGES.success, job: this.jobs.findOne(id) };
  }

  /** [API-050] ~ [API-053] */
  @Patch(':id')
  async update(
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateJobDto,
  ): Promise<Envelope & { job: Job }> {
    const job = await this.jobs.update(id, dto);
    return { status: HttpStatus.OK, result: MESSAGES.success, job };
  }
}
