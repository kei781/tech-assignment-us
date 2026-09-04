/** PATCH /jobs/:id 요청 본문. [API-050], [DATA-002] */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AtLeastOneField } from './at-least-one-field.decorator';
import { trimIfString } from './transforms';

/**
 * [API-050] title/description 중 하나 이상 필수.
 * 빈 문자열은 "미입력"이 아니라 "잘못된 값"이므로 undefined로 바꾸지 않고
 * MinLength(1)에서 400으로 거른다.
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
