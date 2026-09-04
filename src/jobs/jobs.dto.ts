/**
 * 요청 DTO와 공용 검증기. SPEC §4 [API-010], [API-030], [API-031], [API-050], [DATA-002]
 */
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { JOB_STATUSES, JobStatus } from './jobs.types';

// ── 변환기 ──

/** trim만 수행한다. 문자열이 아니면 그대로 넘겨 타입 검사에 걸리게 한다. */
function trimIfString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * [API-030] 1단계 정규화: trim 후 빈 문자열이면 "전달되지 않은 것으로 간주"한다.
 * undefined로 바꾸면 `@IsOptional()`이 이후 validation을 건너뛰므로,
 * `?status=`가 enum validation을 타지 않는다.
 */
function trimToUndefined({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ── 클래스 단위 검증기 ──

/**
 * 지정한 필드 중 최소 하나가 있어야 한다.
 * [API-030] 검색 조건 존재 검사, [API-050] PATCH 수정 필드 존재 검사에 쓴다.
 */
function AtLeastOneField(fields: string[], validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (constructor: Function): void {
    registerDecorator({
      name: 'atLeastOneField',
      target: constructor,
      propertyName: undefined as unknown as string,
      constraints: [fields],
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const target = args.object as Record<string, unknown>;
          const [names] = args.constraints as [string[]];
          return names.some((name) => target[name] !== undefined && target[name] !== null);
        },
        defaultMessage(args: ValidationArguments): string {
          const [names] = args.constraints as [string[]];
          return `${names.join(', ')} 중 하나 이상을 입력하여 주세요.`;
        },
      },
    });
  };
}

// ── DTO ──

/** `POST /jobs` 요청 본문. [API-010] */
export class CreateJobDto {
  @Transform(trimIfString)
  @IsString({ message: 'title은 문자열이어야 합니다.' })
  @MinLength(1, { message: 'title은 1자 이상이어야 합니다.' })
  @MaxLength(1000, { message: 'title은 최대 1,000자입니다.' })
  title!: string;

  @Transform(trimIfString)
  @IsString({ message: 'description은 문자열이어야 합니다.' })
  @MinLength(1, { message: 'description은 1자 이상이어야 합니다.' })
  @MaxLength(2000, { message: 'description은 최대 2,000자입니다.' })
  description!: string;
}

/**
 * `PATCH /jobs/:id` 요청 본문. [API-050]
 *
 * `title`/`description` 중 하나 이상 필수. 빈 문자열은 "미입력"이 아니라
 * "잘못된 값"이므로 undefined로 바꾸지 않고 `MinLength(1)`에서 400으로 거른다.
 */
@AtLeastOneField(['title', 'description'], {
  message: 'title, description 중 하나 이상을 입력하여 주세요.',
})
export class UpdateJobDto {
  @IsOptional()
  @Transform(trimIfString)
  @IsString({ message: 'title은 문자열이어야 합니다.' })
  @MinLength(1, { message: 'title은 1자 이상이어야 합니다.' })
  @MaxLength(1000, { message: 'title은 최대 1,000자입니다.' })
  title?: string;

  @IsOptional()
  @Transform(trimIfString)
  @IsString({ message: 'description은 문자열이어야 합니다.' })
  @MinLength(1, { message: 'description은 1자 이상이어야 합니다.' })
  @MaxLength(2000, { message: 'description은 최대 2,000자입니다.' })
  description?: string;
}

/**
 * `GET /jobs/search` query parameter. [API-030], [API-031]
 *
 * 처리 순서를 고정한다.
 *   1) 정규화 — trim 후 빈 문자열은 미전달로 간주 (`trimToUndefined`)
 *   2) 조건 존재 검사 — 남은 파라미터가 없으면 400 (`AtLeastOneField`)
 *   3) validation — 남은 파라미터에만 적용 (`@IsOptional`로 undefined는 건너뜀)
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
