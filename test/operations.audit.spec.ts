import { describe,expect,it,vi } from 'vitest';
import type { Principal } from '../src/common/common';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { OperationsController } from '../src/modules/operations/operations';

const principal:Principal={tenantId:'00000000-0000-4000-8000-000000000001',tenantSlug:'acme',userId:'00000000-0000-4000-8000-000000000002',departmentId:'00000000-0000-4000-8000-000000000003',role:'AUDITOR'};

describe('OperationsController audit pagination',()=>{
 it('uses stable server-side pagination and the same filters for rows and count',async()=>{
  const rows=[{id:'log-2',actorId:null,eventType:'APPLICATION_SUBMITTED',targetType:'APPLICATION',createdAt:new Date('2026-08-10T00:00:00Z')}];
  const findMany=vi.fn().mockReturnValue({operation:'findMany'}),count=vi.fn().mockReturnValue({operation:'count'});
  const transaction=vi.fn(async()=>[rows,41]);
  const db={$transaction:transaction,auditLog:{findMany,count},user:{findMany:vi.fn()}} as unknown as PrismaService;

  const result=await new OperationsController(db).audit(principal,{page:3,pageSize:20,eventType:'APPLICATION',actorId:principal.userId,targetType:'APPLICATION',result:'SUCCESS',from:'2026-08-01T00:00:00.000Z',to:'2026-08-31T23:59:59.999Z'});

  const expectedWhere={tenantId:principal.tenantId,eventType:{contains:'APPLICATION'},actorId:principal.userId,result:'SUCCESS',targetType:'APPLICATION',createdAt:{gte:new Date('2026-08-01T00:00:00.000Z'),lte:new Date('2026-08-31T23:59:59.999Z')}};
  expect(findMany).toHaveBeenCalledWith({where:expectedWhere,skip:40,take:20,orderBy:[{createdAt:'desc'},{id:'desc'}]});
  expect(count).toHaveBeenCalledWith({where:expectedWhere});
  expect(transaction).toHaveBeenCalledWith([{operation:'findMany'},{operation:'count'}]);
  expect(result).toMatchObject({page:3,pageSize:20,total:41,totalPages:3,items:rows});
 });

 it('returns empty out-of-range pages without changing the requested page metadata',async()=>{
  const db={$transaction:vi.fn(async()=>[[],7]),auditLog:{findMany:vi.fn().mockReturnValue({}),count:vi.fn().mockReturnValue({})},user:{findMany:vi.fn()}} as unknown as PrismaService;
  const result=await new OperationsController(db).audit(principal,{page:9,pageSize:5});
  expect(result).toMatchObject({items:[],page:9,pageSize:5,total:7,totalPages:2});
 });
});
