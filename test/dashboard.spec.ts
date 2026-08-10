import { describe,expect,it } from 'vitest';
import { aggregateDashboard } from '../src/dashboard';
const department={id:'d1',name:'研发部',status:'ACTIVE'};
describe('dashboard aggregation',()=>{
 it('fills 30 local days and applies the documented totals',()=>{const result=aggregateDashboard([
  {status:'DRAFT',totalAmountCents:100,submittedAt:null,department},
  {status:'PENDING_FINANCE',totalAmountCents:200,submittedAt:new Date('2026-08-07T16:30:00Z'),department},
  {status:'APPROVED',totalAmountCents:300,submittedAt:new Date('2026-08-08T01:00:00Z'),department},
 ],2,'Asia/Shanghai',new Date('2026-08-08T12:00:00Z'));expect(result.summary).toEqual({totalCount:3,draftCount:1,pendingCount:1,approvedCount:1,approvedAmountCents:300,rejectedCount:0,myPendingTaskCount:2});expect(result.submissionTrend).toHaveLength(30);expect(result.submissionTrend.at(-1)).toEqual({date:'2026-08-08',amountCents:500,count:2});expect(result.departmentRanking[0]).toMatchObject({amountCents:500,count:2})});
 it('orders departments by amount then id and limits the ranking',()=>{const rows=Array.from({length:12},(_,index)=>({status:'APPROVED',totalAmountCents:index<2?1000:100-index,submittedAt:new Date('2026-08-08T01:00:00Z'),department:{id:`d${String(index).padStart(2,'0')}`,name:`部门${index}`,status:'ACTIVE'}}));const result=aggregateDashboard(rows,0,'Asia/Shanghai',new Date('2026-08-08T12:00:00Z'));expect(result.departmentRanking).toHaveLength(10);expect(result.departmentRanking.slice(0,2).map(row=>row.department.id)).toEqual(['d00','d01'])});
});
