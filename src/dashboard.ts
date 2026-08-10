type DashboardRow = {
  status: string;
  totalAmountCents: bigint | number;
  submittedAt: Date | null;
  department: { id: string; name: string; status: string };
};

export type DashboardResult = {
  summary: { totalCount:number; draftCount:number; pendingCount:number; approvedCount:number; approvedAmountCents:number; rejectedCount:number; myPendingTaskCount:number };
  submissionTrend: Array<{ date:string; amountCents:number; count:number }>;
  departmentRanking: Array<{ department:DashboardRow['department']; amountCents:number; count:number }>;
};

const localDate=(date:Date,timezone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);

function dateRange(end:Date,timezone:string,days:number):string[]{
  const [year,month,day]=localDate(end,timezone).split('-').map(Number),anchor=Date.UTC(year,month-1,day);
  return Array.from({length:days},(_,index)=>new Date(anchor-(days-index-1)*86_400_000).toISOString().slice(0,10));
}

export function aggregateDashboard(rows:DashboardRow[],myPendingTaskCount:number,timezone:string,now=new Date()):DashboardResult{
  const count=(status:string)=>rows.filter(row=>row.status===status).length;
  const dates=dateRange(now,timezone,30),trend=new Map(dates.map(date=>[date,{date,amountCents:0,count:0}]));
  const departments=new Map<string,DashboardResult['departmentRanking'][number]>();
  for(const row of rows){
    const amount=Number(row.totalAmountCents);
    if(row.submittedAt){const point=trend.get(localDate(row.submittedAt,timezone));if(point){point.amountCents+=amount;point.count+=1}}
    if(row.status!=='DRAFT'){const ranking=departments.get(row.department.id)??{department:row.department,amountCents:0,count:0};ranking.amountCents+=amount;ranking.count+=1;departments.set(row.department.id,ranking)}
  }
  return{
    summary:{totalCount:rows.length,draftCount:count('DRAFT'),pendingCount:rows.filter(row=>row.status.startsWith('PENDING_')).length,approvedCount:count('APPROVED'),approvedAmountCents:rows.filter(row=>row.status==='APPROVED').reduce((sum,row)=>sum+Number(row.totalAmountCents),0),rejectedCount:count('REJECTED'),myPendingTaskCount},
    submissionTrend:dates.map(date=>trend.get(date)!),
    departmentRanking:[...departments.values()].sort((a,b)=>b.amountCents-a.amountCents||a.department.id.localeCompare(b.department.id)).slice(0,10),
  };
}
