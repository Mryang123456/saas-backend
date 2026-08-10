import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApplicationStatus } from '@prisma/client';

export class ApplicationItemDto {
  @ApiProperty({ type: String, maxLength: 200, example: '笔记本电脑' })
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: 'name must contain a non-whitespace character' })
  name!: string;

  @ApiProperty({ type: String, pattern: '^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,4})?$', example: '2.0000' })
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/)
  quantity!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: Number.MAX_SAFE_INTEGER, example: 899900 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  unitPriceCents!: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class CreateApplicationDto {
  @ApiProperty({ type: String, maxLength: 100, example: '研发设备采购' })
  @IsString()
  @MaxLength(100)
  @Matches(/\S/, { message: 'title must contain a non-whitespace character' })
  title!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCenter?: string | null;

  @ApiProperty({ type: () => [ApplicationItemDto], minItems: 1, maxItems: 20 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ApplicationItemDto)
  items!: ApplicationItemDto[];
}

export class UpdateApplicationDto extends CreateApplicationDto {
  @ApiProperty({ type: Number, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

export class SubmitApplicationDto {
  @ApiProperty({ type: Number, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

export class ApplicationListQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsUUID()
  creatorId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  validStatuses() {
    return this.status?.split(',').filter((value): value is ApplicationStatus => Object.values(ApplicationStatus).includes(value as ApplicationStatus));
  }
}
