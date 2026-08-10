import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe,expect,it } from 'vitest';
import { ApprovalActionDto,AuditQueryDto } from '../src/operations.dto';

describe('operations DTO validation',()=>{
 it('rejects an invalid approval action and version',async()=>{
  const errors=await validate(plainToInstance(ApprovalActionDto,{action:'SKIP',version:0}));
  expect(errors.map(error=>error.property)).toEqual(expect.arrayContaining(['action','version']));
 });

 it('transforms and bounds audit page size',async()=>{
  const valid=plainToInstance(AuditQueryDto,{page:'2',pageSize:'50',result:'SUCCESS',targetType:'APPLICATION',from:'2026-08-01T00:00:00.000Z'});
  expect(await validate(valid)).toHaveLength(0);
  expect(valid.pageSize).toBe(50);
  expect(valid.page).toBe(2);
  expect(plainToInstance(AuditQueryDto,{})).toMatchObject({page:1,pageSize:20});
  expect(await validate(plainToInstance(AuditQueryDto,{page:'0'}))).not.toHaveLength(0);
  expect(await validate(plainToInstance(AuditQueryDto,{pageSize:'101'}))).not.toHaveLength(0);
 });
});
