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

/** 버전을 가리지 않는다 — 외부에서 만든 UUID도 받을 수 있게. */
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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateJobDto): Promise<Envelope & { job: Job }> {
    const job = await this.jobs.create(dto);
    return { status: HttpStatus.CREATED, result: MESSAGES.success, job };
  }

  @Get()
  findAll(): Envelope & { list: Job[] } {
    return { status: HttpStatus.OK, result: MESSAGES.success, list: this.jobs.findAll() };
  }

  /** 반드시 `:id`보다 먼저 선언되어야 한다 — 아니면 search가 id로 해석된다. */
  @Get('search')
  search(@Query() dto: SearchJobsDto): Envelope & { list: Job[] } {
    const list = this.jobs.search(dto);
    return {
      status: HttpStatus.OK,
      // 결과 없음을 404로 두지 않았다. 조건에 맞는 게 없는 것은 오류가 아니라
      // 정상적인 검색 결과이므로, 200에 사유만 담는다.
      result: list.length > 0 ? MESSAGES.success : MESSAGES.searchEmpty,
      list,
    };
  }

  @Get(':id')
  findOne(@Param('id', uuidParam) id: string): Envelope & { job: Job } {
    return { status: HttpStatus.OK, result: MESSAGES.success, job: this.jobs.findOne(id) };
  }

  @Patch(':id')
  async update(
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateJobDto,
  ): Promise<Envelope & { job: Job }> {
    const job = await this.jobs.update(id, dto);
    return { status: HttpStatus.OK, result: MESSAGES.success, job };
  }
}
