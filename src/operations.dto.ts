import { Type } from 'class-transformer';
import { IsDateString,IsEnum,IsInt,IsOptional,IsString,IsUUID,Max,MaxLength,Min,ValidateIf } from 'class-validator';
import { ApprovalAction,AuditResult } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';

export { ApprovalAction,AuditResult };

export class ApprovalActionDto {
 @IsEnum(ApprovalAction)
 action!:ApprovalAction;

 @IsOptional()
 @IsString()
 @MaxLength(500)
 @ValidateIf(value=>value.action===ApprovalAction.REJECT)
 comment?:string;

 @Type(()=>Number)
 @IsInt()
 @Min(1)
 version!:number;
}

export class AuditQueryDto {
 @ApiPropertyOptional({type:String,maxLength:100})
 @IsOptional()
 @IsString()
 @MaxLength(100)
 eventType?:string;

 @ApiPropertyOptional({type:String,format:'uuid'})
 @IsOptional()
 @IsUUID()
 actorId?:string;

 @ApiPropertyOptional({enum:AuditResult})
 @IsOptional()
 @IsEnum(AuditResult)
 result?:AuditResult;

 @ApiPropertyOptional({type:String,maxLength:64})
 @IsOptional()
 @IsString()
 @MaxLength(64)
 targetType?:string;

 @ApiPropertyOptional({type:String,format:'date-time'})
 @IsOptional()
 @IsDateString({strict:true})
 from?:string;

 @ApiPropertyOptional({type:String,format:'date-time'})
 @IsOptional()
 @IsDateString({strict:true})
 to?:string;

 @ApiPropertyOptional({type:Number,minimum:1,default:1})
 @IsOptional()
 @Type(()=>Number)
 @IsInt()
 @Min(1)
 page=1;

 @ApiPropertyOptional({type:Number,minimum:1,maximum:100,default:20})
 @IsOptional()
 @Type(()=>Number)
 @IsInt()
 @Min(1)
 @Max(100)
 pageSize=20;
}
