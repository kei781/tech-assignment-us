/** POST /jobs 요청 본문. [API-010], [DATA-002] */
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { trimIfString } from './transforms';

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
