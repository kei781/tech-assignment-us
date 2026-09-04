/**
 * DTO 공용 변환기. [DATA-002], [API-030]
 */
import { TransformFnParams } from 'class-transformer';

/** trim만 수행한다. 문자열이 아니면 그대로 넘겨 타입 검사에 걸리게 한다. */
export function trimIfString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * [API-030] 1단계 정규화: trim 후 빈 문자열이면 "전달되지 않은 것으로 간주"한다.
 * undefined로 바꾸면 @IsOptional()이 이후 validation을 건너뛰므로,
 * `?status=`가 enum validation을 타지 않는다.
 */
export function trimToUndefined({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
