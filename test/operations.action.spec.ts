import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import type { Principal } from '../src/common';
import { OperationsController } from '../src/operations';
import { ApprovalAction } from '../src/operations.dto';

const principal: Principal = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'acme',
  userId: '00000000-0000-4000-8000-000000000005',
  departmentId: '00000000-0000-4000-8000-000000000003',
  role: 'DEPT_MANAGER',
};
const applicationId = '00000000-0000-4000-8000-000000000004';

function harness() {
  const row: any = {
    id: applicationId,
    tenantId: principal.tenantId,
    creatorId: '00000000-0000-4000-8000-000000000002',
    departmentId: principal.departmentId,
    status: 'PENDING_DEPT_MANAGER',
    currentApprovalNode: 'DEPT_MANAGER',
    decidedAt: null,
    version: 1,
    totalAmountCents: 100n,
    department: { id: principal.departmentId, name: 'Engineering', status: 'ACTIVE' },
    creator: { id: '00000000-0000-4000-8000-000000000002', username: 'alice', displayName: 'Alice', role: 'EMPLOYEE', status: 'ACTIVE', department: { id: principal.departmentId, name: 'Engineering', status: 'ACTIVE' } },
    items: [{ quantity: { toFixed: () => '1.0000' }, unitPriceCents: 100n, lineAmountCents: 100n }],
    approvals: [],
    events: [],
  };
  const approvals: any[] = [];
  const audits: any[] = [];
  const queries: string[] = [];
  let locked = false;
  const waiters: Array<() => void> = [];
  const transaction = vi.fn(async (work: (value: any) => Promise<any>) => {
    let localRow: any = null;
    const localApprovals: any[] = [];
    const localAudits: any[] = [];
    let release: (() => void) | undefined;
    const tx: any = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(Array.from(strings).join('?'));
        if (locked) await new Promise<void>(resolve => waiters.push(resolve));
        locked = true;
        release = () => {
          const next = waiters.shift();
          if (next) next();
          else locked = false;
        };
        localRow = { ...row, approvals: [...row.approvals], events: [...row.events], items: [...row.items] };
        return [{ id: applicationId }];
      }),
      purchaseApplication: {
        findFirst: vi.fn(async () => localRow),
        update: vi.fn(async ({ data }: any) => { Object.assign(localRow, { status: data.status, currentApprovalNode: data.currentApprovalNode, decidedAt: data.decidedAt, version: localRow.version + 1 }); return localRow; }),
        findUniqueOrThrow: vi.fn(async () => localRow),
      },
      approvalRecord: { create: vi.fn(async ({ data }: any) => { localApprovals.push(data); return data; }) },
      auditLog: { create: vi.fn(async ({ data }: any) => { localAudits.push(data); return data; }) },
    };
    try {
      const result = await work(tx);
      Object.assign(row, localRow);
      approvals.push(...localApprovals);
      audits.push(...localAudits);
      return result;
    } finally {
      release?.();
    }
  });
  return { controller: new OperationsController({ $transaction: transaction } as unknown as PrismaService), row, approvals, audits, queries };
}

describe('OperationsController MySQL approval locking', () => {
  it('allows only one concurrent decision for a workflow node', async () => {
    const h = harness();
    const results = await Promise.allSettled([
      h.controller.action(principal, applicationId, { action: ApprovalAction.APPROVE, version: 1 }, 'request-a'),
      h.controller.action(principal, applicationId, { action: ApprovalAction.APPROVE, version: 1 }, 'request-b'),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ code: 'APPLICATION_STATE_CHANGED' }) });
    expect(h.row.status).toBe('PENDING_FINANCE');
    expect(h.row.version).toBe(2);
    expect(h.approvals).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it('uses a MySQL-compatible application row lock', async () => {
    const h = harness();
    await h.controller.action(principal, applicationId, { action: ApprovalAction.APPROVE, version: 1 }, 'request-lock');
    const sql = h.queries[0];
    expect(sql).toContain('FOR UPDATE');
    expect(sql).not.toContain('::uuid');
  });

  it('still forbids an approver from deciding their own application', async () => {
    const h = harness();
    h.row.creatorId = principal.userId;
    await expect(h.controller.action(principal, applicationId, { action: ApprovalAction.APPROVE, version: 1 }, 'request-self')).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    expect(h.approvals).toHaveLength(0);
  });

  it('does not expand approval to a non-node role', async () => {
    const h = harness();
    await expect(h.controller.action({ ...principal, role: 'TENANT_ADMIN' }, applicationId, { action: ApprovalAction.APPROVE, version: 1 }, 'request-admin')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.approvals).toHaveLength(0);
  });
});

describe('OperationsController approval task serialization', () => {
  it('converts nested Prisma Decimal and BigInt item values to JSON-safe values', async () => {
    const row: any = {
      id: applicationId,
      tenantId: principal.tenantId,
      creatorId: '00000000-0000-4000-8000-000000000002',
      departmentId: principal.departmentId,
      status: 'PENDING_DEPT_MANAGER',
      totalAmountCents: 253n,
      creator: { id: '00000000-0000-4000-8000-000000000002', username: 'alice', displayName: 'Alice', role: 'EMPLOYEE', status: 'ACTIVE', department: { id: principal.departmentId, name: 'Engineering', status: 'ACTIVE' } },
      department: { id: principal.departmentId, name: 'Engineering', status: 'ACTIVE' },
      items: [{ id: 'item-1', quantity: { toFixed: () => '2.5000' }, unitPriceCents: 101n, lineAmountCents: 253n }],
    };
    const db = { purchaseApplication: { findMany: vi.fn().mockResolvedValue([row]) } } as unknown as PrismaService;

    const result = await new OperationsController(db).tasks(principal);

    expect(result.items[0]).toMatchObject({
      totalAmountCents: 253,
      itemCount: 1,
      items: [{ quantity: '2.5000', unitPriceCents: 101, lineAmountCents: 253 }],
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
