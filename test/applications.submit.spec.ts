import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import type { Principal } from '../src/common/common';
import { ApiError } from '../src/common/common';
import { ApplicationsController } from '../src/modules/applications/applications';

const principal: Principal = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'acme',
  userId: '00000000-0000-4000-8000-000000000002',
  departmentId: '00000000-0000-4000-8000-000000000003',
  role: 'EMPLOYEE',
};
const applicationId = '00000000-0000-4000-8000-000000000004';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(onWait?: () => void) {
    if (this.locked) {
      onWait?.();
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}

function user(id: string, role: string) {
  return { id, username: role.toLowerCase(), displayName: role, role, status: 'ACTIVE', department: { id: principal.departmentId, name: 'Engineering', status: 'ACTIVE' } };
}

type HarnessOptions = {
  transactionFailures?: unknown[];
  status?: string;
  version?: number;
  interleaveDifferentKeys?: boolean;
  workflowUniqueMeta?: Record<string, unknown>;
  applicationUpdateError?: unknown;
};

function knownError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: '6.19.3', meta });
}

function harness(options: HarnessOptions = {}) {
  const creator = user(principal.userId, 'EMPLOYEE');
  const row: any = {
    id: applicationId,
    tenantId: principal.tenantId,
    applicationNo: null,
    creatorId: principal.userId,
    departmentId: principal.departmentId,
    title: 'MySQL concurrency test',
    reason: 'Verify idempotent submission',
    costCenter: 'QA',
    currency: 'CNY',
    totalAmountCents: 100n,
    status: options.status ?? 'DRAFT',
    currentApprovalNode: null,
    submittedAt: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    version: options.version ?? 1,
    creator,
    department: { id: principal.departmentId, name: 'Engineering', status: 'ACTIVE', managerUserId: '00000000-0000-4000-8000-000000000005' },
    items: [{ id: 'item-1', lineNo: 1, name: 'Test item', quantity: { toFixed: () => '1.0000' }, unitPriceCents: 100n, lineAmountCents: 100n, note: null }],
    approvals: [],
    events: [],
  };
  const audits: any[] = [];
  const storedKeys = new Map<string, any>();
  const keyLocks = new Map<string, Mutex>();
  const applicationLock = new Mutex();
  const sequenceLock = new Mutex();
  const trace: string[] = [];
  const transactionOptions: any[] = [];
  const firstApplicationLocked = deferred();
  const releaseFirstApplication = deferred();
  const secondApplicationWaiting = deferred();
  const actors: Record<string, any> = {
    DEPT_MANAGER: user('00000000-0000-4000-8000-000000000005', 'DEPT_MANAGER'),
    FINANCE: user('00000000-0000-4000-8000-000000000006', 'FINANCE'),
    TENANT_OWNER: user('00000000-0000-4000-8000-000000000007', 'TENANT_OWNER'),
  };
  const compositeKey = (value: { tenantId: string; actorId: string; operation: string; key: string }) => `${value.tenantId}:${value.actorId}:${value.operation}:${value.key}`;
  const transactionFailures = [...(options.transactionFailures ?? [])];
  let sequenceNext = 1;
  let workflowUniqueMeta = options.workflowUniqueMeta;
  let applicationUpdateError = options.applicationUpdateError;

  const transaction = vi.fn(async (work: (value: any) => Promise<any>, txOptions?: unknown) => {
    transactionOptions.push(txOptions);
    const transactionFailure = transactionFailures.shift();
    if (transactionFailure) throw transactionFailure;

    let txKey = '';
    let localKey: any = null;
    let localRow: any = null;
    let localSequence: number | null = null;
    const localAudits: any[] = [];
    const releases: Array<() => void> = [];

    const tx: any = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = Array.from(strings).join('?');
        if (sql.includes('INSERT INTO idempotency_keys')) {
          const unique = { tenantId: values[1], actorId: values[2], operation: values[3], key: values[4] };
          const mapKey = compositeKey(unique);
          txKey = unique.key;
          const mutex = keyLocks.get(mapKey) ?? new Mutex();
          keyLocks.set(mapKey, mutex);
          releases.push(await mutex.acquire(() => trace.push(`${txKey}:idempotency-wait`)));
          const committed = storedKeys.get(mapKey);
          localKey = committed ? structuredClone(committed) : { id: values[0], ...unique, requestHash: values[5], responseStatus: null, responseBody: null, resourceId: values[6], expiresAt: values[7], createdAt: values[8] };
          trace.push(`${txKey}:idempotency-lock`);
        } else if (sql.includes('INSERT INTO tenant_sequences')) {
          releases.push(await sequenceLock.acquire());
          localSequence = sequenceNext;
          trace.push(`${txKey}:sequence-lock`);
        } else if (sql.includes('UPDATE tenant_sequences')) {
          localSequence = (localSequence ?? sequenceNext) + 1;
        }
        return 1;
      }),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const sql = Array.from(strings).join('?');
        if (sql.includes('FROM idempotency_keys')) return [{ id: localKey?.id }];
        if (sql.includes('FROM purchase_applications')) {
          releases.push(await applicationLock.acquire(() => {
            trace.push(`${txKey}:application-wait`);
            if (options.interleaveDifferentKeys && txKey === 'key-b') secondApplicationWaiting.resolve();
          }));
          localRow = { ...row, events: [...row.events], approvals: [...row.approvals], items: [...row.items] };
          trace.push(`${txKey}:application-lock`);
          if (options.interleaveDifferentKeys && txKey === 'key-a') {
            firstApplicationLocked.resolve();
            await releaseFirstApplication.promise;
          }
          return [{ id: localRow.id, status: localRow.status, version: localRow.version, creator_id: localRow.creatorId }];
        }
        if (sql.includes('FROM tenant_sequences')) return [{ next_value: localSequence ?? sequenceNext }];
        return [];
      }),
      idempotencyKey: {
        findUnique: vi.fn(async () => {
          trace.push(`${txKey}:idempotency-read`);
          return localKey;
        }),
        update: vi.fn(async ({ data }: any) => {
          if (!localKey) throw new Error('IDEMPOTENCY_ROW_NOT_FOUND');
          Object.assign(localKey, data, data.responseBody === Prisma.DbNull ? { responseBody: null } : {});
          return localKey;
        }),
      },
      purchaseApplication: {
        findFirst: vi.fn(async () => localRow),
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (applicationUpdateError) {
            const error = applicationUpdateError;
            applicationUpdateError = undefined;
            throw error;
          }
          if (!localRow || localRow.status !== where.status || localRow.version !== where.version || localRow.creatorId !== where.creatorId) return { count: 0 };
          Object.assign(localRow, { applicationNo: data.applicationNo, status: data.status, currentApprovalNode: data.currentApprovalNode, submittedAt: data.submittedAt, version: localRow.version + 1 });
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => localRow),
      },
      tenant: { findUniqueOrThrow: vi.fn(async () => ({ timezone: 'Asia/Shanghai' })) },
      user: { findFirst: vi.fn(async ({ where }: any) => actors[where.role] ?? null) },
      workflowEvent: {
        create: vi.fn(async ({ data }: any) => {
          if (workflowUniqueMeta !== undefined) {
            const meta = workflowUniqueMeta;
            workflowUniqueMeta = undefined;
            throw knownError('P2002', meta);
          }
          const event = { ...data, createdAt: new Date() };
          localRow.events.push(event);
          return event;
        }),
      },
      auditLog: { create: vi.fn(async ({ data }: any) => { localAudits.push(data); return data; }) },
    };

    try {
      const result = await work(tx);
      if (localRow) Object.assign(row, localRow);
      if (localKey) storedKeys.set(compositeKey(localKey), structuredClone(localKey));
      if (localSequence !== null) sequenceNext = localSequence;
      audits.push(...localAudits);
      trace.push(`${txKey}:commit`);
      return result;
    } finally {
      for (const release of releases.reverse()) release();
    }
  });

  const db = { $transaction: transaction } as unknown as PrismaService;
  return {
    controller: new ApplicationsController(db),
    row,
    audits,
    storedKeys,
    trace,
    transaction,
    transactionOptions,
    firstApplicationLocked: firstApplicationLocked.promise,
    releaseFirstApplication: releaseFirstApplication.resolve,
    secondApplicationWaiting: secondApplicationWaiting.promise,
  };
}

const submit = (controller: ApplicationsController, key: string, version = 1) => controller.submit(principal, applicationId, key, { version }, `request-${key}`);

describe('ApplicationsController MySQL submit idempotency and state transitions', () => {
  it.each(['TENANT_ADMIN', 'EMPLOYEE', 'DEPT_MANAGER', 'FINANCE', 'TENANT_OWNER', 'AUDITOR'])('allows a %s author to submit their own complete draft', async role => {
    const h = harness();
    await expect(h.controller.submit({ ...principal, role }, applicationId, `role-${role}`, { version: 1 }, `request-${role}`)).resolves.toMatchObject({ status: 'PENDING_DEPT_MANAGER' });
  });

  it('does not allow a different user to submit another author draft', async () => {
    const h = harness();
    await expect(h.controller.submit({ ...principal, userId: '00000000-0000-4000-8000-000000000099', role: 'TENANT_ADMIN' }, applicationId, 'other-author', { version: 1 }, 'request-other')).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 409 && error.code === 'APPLICATION_STATE_CHANGED');
  });

  it('uses ReadCommitted and advances a draft once', async () => {
    const h = harness();
    const response = await submit(h.controller, 'single');
    expect(h.transactionOptions).toEqual([{ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }]);
    expect(response).toMatchObject({ status: 'PENDING_DEPT_MANAGER', applicationNo: expect.stringMatching(/^PF-\d{8}-0001$/) });
    expect(h.row.events).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.row.version).toBe(2);
  });

  it('locks idempotency, application, then tenant sequence', async () => {
    const h = harness();
    await submit(h.controller, 'lock-order');
    expect(h.trace.indexOf('lock-order:idempotency-lock')).toBeLessThan(h.trace.indexOf('lock-order:application-lock'));
    expect(h.trace.indexOf('lock-order:application-lock')).toBeLessThan(h.trace.indexOf('lock-order:sequence-lock'));
  });

  it('returns detail permissions that remove draft actions after submit', async () => {
    const response = await submit(harness().controller, 'permissions');
    expect(response.permissions).toMatchObject({ canEdit: false, canDelete: false, canSubmit: false });
  });

  it('replays a committed response for the same key and payload', async () => {
    const h = harness();
    const first = await submit(h.controller, 'same-key');
    const retry = await submit(h.controller, 'same-key');
    expect(retry).toEqual(first);
    expect(h.row.events).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it('coalesces truly concurrent transactions carrying the same key', async () => {
    const h = harness();
    const results = await Promise.allSettled([submit(h.controller, 'concurrent-key'), submit(h.controller, 'concurrent-key')]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    if (results[0].status === 'fulfilled' && results[1].status === 'fulfilled') expect(results[1].value).toEqual(results[0].value);
    expect(h.trace).toContain('concurrent-key:idempotency-wait');
    expect(h.row.events).toHaveLength(1);
    expect(h.storedKeys.size).toBe(1);
  });

  it('makes key-b read idempotency, wait for key-a application lock, then observe key-a commit', async () => {
    const h = harness({ interleaveDifferentKeys: true });
    const first = submit(h.controller, 'key-a');
    await h.firstApplicationLocked;
    const second = submit(h.controller, 'key-b');
    await h.secondApplicationWaiting;
    h.releaseFirstApplication();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ code: 'APPLICATION_STATE_CHANGED' }) });
    expect(h.trace.indexOf('key-b:idempotency-read')).toBeLessThan(h.trace.indexOf('key-b:application-wait'));
    expect(h.trace.indexOf('key-a:commit')).toBeLessThan(h.trace.indexOf('key-b:application-lock'));
    expect(h.row.events).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.storedKeys.size).toBe(1);
  });

  it('does not retry an ordinary non-retryable error and allows a later client retry', async () => {
    const h = harness({ transactionFailures: [new Error('TRANSIENT_FAILURE')] });
    await expect(submit(h.controller, 'retry-after-failure')).rejects.toThrow('TRANSIENT_FAILURE');
    expect(h.transaction).toHaveBeenCalledTimes(1);
    await expect(submit(h.controller, 'retry-after-failure')).resolves.toMatchObject({ status: 'PENDING_DEPT_MANAGER' });
  });

  it('retries Prisma P2034 write conflicts', async () => {
    const h = harness({ transactionFailures: [knownError('P2034')] });
    await expect(submit(h.controller, 'deadlock-retry')).resolves.toMatchObject({ status: 'PENDING_DEPT_MANAGER' });
    expect(h.transaction).toHaveBeenCalledTimes(2);
  });

  it.each(['1205', 1213, '40001'])('retries MySQL P2010 driver error %s', async driverCode => {
    const h = harness({ transactionFailures: [knownError('P2010', { code: driverCode })] });
    await expect(submit(h.controller, `mysql-${driverCode}`)).resolves.toMatchObject({ status: 'PENDING_DEPT_MANAGER' });
    expect(h.transaction).toHaveBeenCalledTimes(2);
  });

  it('returns a dedicated conflict after three retryable transaction failures', async () => {
    const h = harness({ transactionFailures: [knownError('P2034'), knownError('P2010', { code: 1213 }), knownError('P2010', { code: '40001' })] });
    await expect(submit(h.controller, 'retry-exhausted')).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 409 && error.code === 'CONCURRENT_OPERATION_RETRY_EXHAUSTED');
    expect(h.transaction).toHaveBeenCalledTimes(3);
  });

  it('rejects submission when status or version has changed and rolls back its key claim', async () => {
    const h = harness({ status: 'PENDING_DEPT_MANAGER', version: 2 });
    await expect(submit(h.controller, 'changed', 1)).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 409 && error.code === 'APPLICATION_STATE_CHANGED');
    expect(h.row.events).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(h.storedKeys.size).toBe(0);
  });

  it.each([
    { target: 'workflow_events_application_id_event_type_key' },
    { target: ['application_id', 'event_type'] },
    { target: ['event_type', 'application_id'] },
    { target: ['applicationId', 'eventType'] },
    { target: 'application_id,event_type' },
    { constraint: 'workflow_events_application_id_event_type_key' },
    { index: '`workflow_events_application_id_event_type_key`' },
  ])('maps a confirmed SUBMITTED workflow unique race to APPLICATION_STATE_CHANGED', async meta => {
    const h = harness({ workflowUniqueMeta: meta });
    await expect(submit(h.controller, 'workflow-unique-race')).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 409 && error.code === 'APPLICATION_STATE_CHANGED');
    expect(h.row.status).toBe('DRAFT');
    expect(h.row.events).toHaveLength(0);
    expect(h.storedKeys.size).toBe(0);
  });

  it('does not remap an application number P2002', async () => {
    const error = knownError('P2002', { target: 'purchase_applications_tenant_id_application_no_key' });
    const h = harness({ applicationUpdateError: error });
    await expect(submit(h.controller, 'application-number-race')).rejects.toBe(error);
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not remap an unconfirmed P2002 thrown by workflow creation', async () => {
    const h = harness({ workflowUniqueMeta: { target: 'some_other_unique_key' } });
    await expect(submit(h.controller, 'unknown-workflow-race')).rejects.toSatisfy((error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    { target: ['application_id', 'event_type', 'archived_at'] },
    { target: ['application_id', 'application_id'] },
    { target: 'application_id,application_id' },
    { target: 'unrelated_application_id_event_type_shadow_key' },
    { target: 'prefix_workflow_events_application_id_event_type_key' },
    { target: 'workflow_events_application_id_event_type_key_suffix' },
  ])('does not remap an approximate or non-exact workflow P2002 target', async meta => {
    const h = harness({ workflowUniqueMeta: meta });
    await expect(submit(h.controller, 'approximate-workflow-race')).rejects.toSatisfy((error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a different payload that reuses a committed key', async () => {
    const h = harness();
    await submit(h.controller, 'conflicting-key', 1);
    await expect(submit(h.controller, 'conflicting-key', 2)).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.getStatus() === 409 && error.code === 'IDEMPOTENCY_KEY_CONFLICT');
    expect(h.row.events).toHaveLength(1);
    expect(h.storedKeys.size).toBe(1);
  });
});
