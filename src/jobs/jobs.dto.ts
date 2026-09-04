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

/** 문자열이 아니면 그대로 넘겨 타입 검사에 걸리게 한다. */
function trimIfString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * trim 후 빈 문자열을 undefined로 만들어 "전달되지 않은 것"으로 취급한다.
 * `@IsOptional()`이 이후 validation을 건너뛰므로, `?status=`가 enum 검사에
 * 걸려 "빈 문자열은 유효한 enum이 아니다"라는 엉뚱한 사유로 400이 되지 않는다.
 */
function trimToUndefined({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

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
 * 검색과 달리 빈 문자열을 undefined로 바꾸지 않는다 — 수정 요청의 빈 제목은
 * "미입력"이 아니라 "잘못된 값"이므로 MinLength에서 걸러야 한다.
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
 * 처리 순서를 정규화 → 조건 존재 검사 → validation으로 고정했다.
 * 정규화가 먼저 오지 않으면 `?title=&status=done`처럼 빈 파라미터가 섞인
 * 요청이 조건 부족으로 거부된다.
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
