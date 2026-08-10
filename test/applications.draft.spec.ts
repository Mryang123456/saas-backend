import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import type { Principal } from '../src/common';
import { ApiError } from '../src/common';
import { ApplicationsController } from '../src/applications';

const principal: Principal = {
  tenantId: '00000000-0000-4000-8000-000000000001', tenantSlug: 'acme',
  userId: '00000000-0000-4000-8000-000000000002', departmentId: '00000000-0000-4000-8000-000000000003', role: 'EMPLOYEE',
};
const body = { title: ' Draft ', reason: ' Reason ', costCenter: ' CC ', items: [{ name: ' Laptop ', quantity: '2.5000', unitPriceCents: 101, note: ' note ' }] };

function row() {
  const now = new Date('2026-08-09T00:00:00Z');
  return {
    id: '00000000-0000-4000-8000-000000000004', applicationNo: null, creatorId: principal.userId,
    title: 'Draft', reason: 'Reason', costCenter: 'CC', currency: 'CNY', totalAmountCents: 253n, status: 'DRAFT', currentApprovalNode: null,
    creator: { id: principal.userId, username: 'employee', displayName: 'Employee', role: 'EMPLOYEE', status: 'ACTIVE', department: { id: principal.departmentId, name: 'R&D', status: 'ACTIVE' } },
    department: { id: principal.departmentId, name: 'R&D', status: 'ACTIVE' },
    items: [{ id: 'item', lineNo: 1, name: 'Laptop', quantity: { toFixed: () => '2.5000' }, unitPriceCents: 101n, lineAmountCents: 253n, note: 'note' }],
    approvals: [], events: [], version: 1, submittedAt: null, createdAt: now, updatedAt: now,
  };
}

function createHarness() {
  let stored: any = null;
  let created = 0;
  const tx: any = {
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: any[]) => { if (!stored) stored = { id: 'key', requestHash: values[5], responseStatus: null, responseBody: null, expiresAt: new Date(Date.now() + 60_000) }; return 1; }),
    $queryRaw: vi.fn(async () => [{ id: 'key' }]),
    idempotencyKey: {
      findUnique: vi.fn(async () => stored),
      update: vi.fn(async ({ data }: any) => { Object.assign(stored, data); return stored; }),
    },
    purchaseApplication: { create: vi.fn(async () => { created += 1; return row(); }) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const db = { $transaction: vi.fn(async (work: any) => work(tx)) } as unknown as PrismaService;
  return { controller: new ApplicationsController(db), tx, created: () => created };
}

function updateHarness(ownerId = principal.userId) {
  const application = row();
  application.creatorId = ownerId;
  const tx: any = {
    purchaseApplication: {
      updateMany: vi.fn(async ({ where }: any) => ({ count: where.creatorId === ownerId && where.version === 1 ? 1 : 0 })),
      findUniqueOrThrow: vi.fn(async () => ({ ...application, version: 2 })),
    },
    purchaseApplicationItem: { deleteMany: vi.fn(async () => ({ count: 1 })), createMany: vi.fn(async () => ({ count: 1 })) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const db: any = {
    purchaseApplication: { findFirst: vi.fn(async ({ where }: any) => where.creatorId === ownerId ? application : null) },
    $transaction: vi.fn(async (work: any) => work(tx)),
  };
  return { controller: new ApplicationsController(db as PrismaService), tx };
}

describe('ApplicationsController complete draft writes', () => {
  it('atomically creates items, rounded amounts, audit and idempotent response', async () => {
    const h = createHarness();
    const first = await h.controller.create(principal, 'create-key', body, 'request-1');
    const replay = await h.controller.create(principal, 'create-key', body, 'request-2');
    expect(replay).toEqual(first);
    expect(h.created()).toBe(1);
    expect(h.tx.purchaseApplication.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: principal.tenantId, creatorId: principal.userId, totalAmountCents: 253n, items: { create: [expect.objectContaining({ lineAmountCents: 253n })] } }) }));
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it.each(['TENANT_ADMIN', 'EMPLOYEE', 'DEPT_MANAGER', 'FINANCE', 'TENANT_OWNER', 'AUDITOR'])('allows active %s users to create their own draft', async role => {
    const h = createHarness();
    await expect(h.controller.create({ ...principal, role }, `key-${role}`, body, 'request')).resolves.toMatchObject({ status: 'DRAFT', permissions: { canEdit: true, canDelete: true, canSubmit: true } });
    expect(h.created()).toBe(1);
  });

  it('rejects unknown roles before touching the database', async () => {
    const h = createHarness();
    await expect(h.controller.create({ ...principal, role: 'UNKNOWN' }, 'key', body, 'request')).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 403);
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it.each(['TENANT_ADMIN', 'EMPLOYEE', 'DEPT_MANAGER', 'FINANCE', 'TENANT_OWNER', 'AUDITOR'])('allows a %s author to edit their own draft', async role => {
    const h = updateHarness();
    await expect(h.controller.update({ ...principal, role }, row().id, { ...body, version: 1 }, 'request')).resolves.toMatchObject({ version: 2, permissions: { canEdit: true, canDelete: true, canSubmit: true } });
    expect(h.tx.purchaseApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ creatorId: principal.userId, status: 'DRAFT', version: 1 }) }));
  });

  it('does not allow a user to edit another author draft', async () => {
    const h = updateHarness('00000000-0000-4000-8000-000000000099');
    await expect(h.controller.update(principal, row().id, { ...body, version: 1 }, 'request')).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 404);
    expect(h.tx.purchaseApplication.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a total that cannot be represented safely in the API response', async () => {
    const h = createHarness();
    await expect(h.controller.create(principal, 'key', { ...body, items: [
      { name: 'A', quantity: '1', unitPriceCents: Number.MAX_SAFE_INTEGER },
      { name: 'B', quantity: '1', unitPriceCents: 1 },
    ] }, 'request')).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 400);
  });
});
