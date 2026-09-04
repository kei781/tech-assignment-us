/** GET /jobs/search query parameter. [API-030], [API-031] */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { JOB_STATUSES, JobStatus } from '../jobs.types';
import { AtLeastOneField } from './at-least-one-field.decorator';
import { trimToUndefined } from './transforms';

/**
 * [API-030] 처리 순서:
 *   1) 정규화 — trim 후 빈 문자열은 미전달로 간주 (trimToUndefined)
 *   2) 조건 존재 검사 — 남은 파라미터가 없으면 400 (AtLeastOneField)
 *   3) validation — 남은 파라미터에만 적용 (@IsOptional로 undefined는 건너뜀)
 */
@AtLeastOneField(['title', 'description', 'status'], {
  message: 'title, description, status 중 하나 이상을 입력하여 주세요.',
})
export class SearchJobsDto {
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString({ message: 'title은 문자열이어야 합니다.' })
  title?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString({ message: 'description은 문자열이어야 합니다.' })
  description?: string;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsIn(JOB_STATUSES as readonly string[], {
    message: `status는 ${JOB_STATUSES.join(' | ')} 중 하나여야 합니다.`,
  })
  status?: JobStatus;
}
