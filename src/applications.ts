import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { ApplicationStatus, Prisma, UserRole } from '@prisma/client';
import Decimal from 'decimal.js';
import { ApiError, CurrentUser, Principal, RequestId } from './common';
import { AuthGuard, summary } from './auth';
import { PrismaService } from './prisma.service';
import { ApplicationListQueryDto, CreateApplicationDto, SubmitApplicationDto, UpdateApplicationDto } from './applications.dto';

const scope = (p: Principal): any => p.role === 'EMPLOYEE' ? { creatorId: p.userId } : p.role === 'DEPT_MANAGER' ? { departmentId: p.departmentId } : {};
const draftAuthorRoles = new Set<string>(Object.values(UserRole));
const SUBMIT_OPERATION = 'APPLICATION_SUBMIT';
const CREATE_OPERATION = 'APPLICATION_CREATE';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SUBMIT_TRANSACTION_ATTEMPTS = 3;
const include = {
  creator: { include: { department: true } },
  department: true,
  items: { orderBy: { lineNo: 'asc' as const } },
  approvals: { include: { approver: { include: { department: true } } }, orderBy: { createdAt: 'asc' as const } },
  events: { orderBy: { createdAt: 'asc' as const } },
};

function requireKey(key?: string) {
  if (!key || key.length > 64) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必填');
}

function submitRequestHash(applicationId: string, version: number) {
  return createHash('sha256').update(JSON.stringify({ applicationId, version })).digest('hex');
}

function createRequestHash(body: CreateApplicationDto) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function canCreateDraft(p: Principal) {
  return draftAuthorRoles.has(p.role);
}

function isOwnDraft(p: Principal, application: { creatorId: string; status: ApplicationStatus }) {
  return application.status === ApplicationStatus.DRAFT && application.creatorId === p.userId;
}

function isRetryableMySqlTransactionError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const driverCode = String(error.meta?.code ?? error.meta?.errno ?? '');
  return error.code === 'P2034' || (error.code === 'P2010' && ['1205', '1213', '40001'].includes(driverCode));
}

function isSubmittedWorkflowUniqueRace(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const constraintName = 'workflow_events_application_id_event_type_key';
  const stripOuterQuotes = (value: string) => value.trim().replace(/^[`'"]|[`'"]$/g, '');
  const normalizeIdentifier = (value: string) => stripOuterQuotes(value).toLowerCase();
  const normalizeField = (value: string) => stripOuterQuotes(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const isExactFieldPair = (values: unknown[]) => {
    if (values.length !== 2 || values.some(value => typeof value !== 'string')) return false;
    const fields = new Set((values as string[]).map(normalizeField));
    return fields.size === 2 && fields.has('application_id') && fields.has('event_type');
  };

  if (Array.isArray(meta.target)) return isExactFieldPair(meta.target);
  if (typeof meta.target === 'string') {
    const target = normalizeIdentifier(meta.target);
    if (target === constraintName) return true;
    if (target.includes(',')) return isExactFieldPair(target.split(','));
  }
  return [meta.constraint, meta.constraint_name, meta.index]
    .some(value => typeof value === 'string' && normalizeIdentifier(value) === constraintName);
}

function applicationStateChanged() {
  return new ApiError(409, 'APPLICATION_STATE_CHANGED', '申请状态已变化');
}

function concurrentOperationRetryExhausted() {
  return new ApiError(409, 'CONCURRENT_OPERATION_RETRY_EXHAUSTED', '并发操作重试次数已耗尽，请稍后重试');
}

function draftValues(tenantId: string, body: CreateApplicationDto) {
  const items = body.items.map((item, index) => {
    const quantity = new Decimal(item.quantity);
    if (!quantity.isPositive()) throw new ApiError(400, 'VALIDATION_ERROR', '明细数量不合法');
    const amount = quantity.mul(item.unitPriceCents).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
    if (!Number.isSafeInteger(amount)) throw new ApiError(400, 'VALIDATION_ERROR', '金额超出范围');
    return {
      tenantId,
      lineNo: index + 1,
      name: item.name.trim(),
      quantity: item.quantity,
      unitPriceCents: BigInt(item.unitPriceCents),
      lineAmountCents: BigInt(amount),
      note: item.note?.trim() || null,
    };
  });
  const total = items.reduce((sum, item) => sum + item.lineAmountCents, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(400, 'VALIDATION_ERROR', '总金额超出安全范围');
  return { items, total };
}

function dto(a: any) {
  return {
    id: a.id,
    applicationNo: a.applicationNo,
    title: a.title,
    reason: a.reason,
    costCenter: a.costCenter,
    currency: a.currency,
    totalAmountCents: Number(a.totalAmountCents),
    status: a.status,
    currentApprovalNode: a.currentApprovalNode,
    creator: summary(a.creator),
    department: { id: a.department.id, name: a.department.name, status: a.department.status },
    itemCount: a.items.length,
    items: a.items.map((item: any) => ({
      id: item.id,
      lineNo: item.lineNo,
      name: item.name,
      quantity: item.quantity.toFixed(4),
      unitPriceCents: Number(item.unitPriceCents),
      lineAmountCents: Number(item.lineAmountCents),
      note: item.note,
    })),
    version: a.version,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    history: [
      ...a.events.map((event: any) => ({
        type: 'SUBMITTED',
        actor: summary(a.creator),
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        createdAt: event.createdAt.toISOString(),
      })),
      ...a.approvals.map((record: any) => ({
        type: 'APPROVAL',
        id: record.id,
        node: record.node,
        action: record.action,
        approver: summary(record.approver),
        comment: record.comment,
        fromStatus: record.fromStatus,
        toStatus: record.toStatus,
        createdAt: record.createdAt.toISOString(),
      })),
    ].sort((x: any, y: any) => x.createdAt.localeCompare(y.createdAt)),
  };
}

type ApplicationDetailDto = ReturnType<typeof dto> & {
  permissions: {
    canEdit: boolean;
    canDelete: boolean;
    canSubmit: boolean;
    canApprove: boolean;
    canReject: boolean;
  };
};

@Controller('api/v1/tenants/:tenantId')
@UseGuards(AuthGuard)
export class ApplicationsController {
  constructor(private db: PrismaService) {}

  private async find(p: Principal, id: string) {
    const application = await this.db.purchaseApplication.findFirst({ where: { id, tenantId: p.tenantId, ...scope(p) }, include });
    if (!application) throw new ApiError(404, 'RESOURCE_NOT_FOUND', '资源不存在');
    return application;
  }

  private detailDto(p: Principal, application: any): ApplicationDetailDto {
    return {
      ...dto(application),
      permissions: {
        canEdit: isOwnDraft(p, application),
        canDelete: isOwnDraft(p, application),
        canSubmit: isOwnDraft(p, application),
        canApprove: this.canApprove(p, application),
        canReject: this.canApprove(p, application),
      },
    };
  }

  @Get('applications')
  async list(@CurrentUser() p: Principal, @Query() q: ApplicationListQueryDto) {
    const where: any = { tenantId: p.tenantId, ...scope(p) };
    const statuses = q.validStatuses();
    if (q.status && !statuses?.length) throw new ApiError(400, 'VALIDATION_ERROR', '申请状态不合法');
    if (statuses?.length) where.status = { in: statuses };
    if (q.creatorId) where.creatorId = q.creatorId;
    if (q.departmentId) where.departmentId = q.departmentId;
    if (q.search) where.OR = [{ title: { contains: q.search.trim() } }, { applicationNo: { contains: q.search.trim() } }];
    const page = q.page;
    const take = q.pageSize;
    const [rows, total] = await this.db.$transaction([
      this.db.purchaseApplication.findMany({ where, include, skip: (page - 1) * take, take, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] }),
      this.db.purchaseApplication.count({ where }),
    ]);
    return { items: rows.map(dto), page, pageSize: take, total, totalPages: Math.ceil(total / take) };
  }

  @Get('applications/:id')
  async detail(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.detailDto(p, await this.find(p, id));
  }

  @Post('applications')
  @ApiOperation({ summary: '创建包含明细的完整草稿', description: '所有有效租户角色均可创建自己的草稿。' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', maxLength: 64 } })
  @ApiBody({ type: CreateApplicationDto })
  @ApiResponse({ status: 201, description: '草稿已创建，重放同一幂等请求时返回同一响应' })
  async create(@CurrentUser() p: Principal, @Headers('idempotency-key') key: string, @Body() b: CreateApplicationDto, @RequestId() rid: string) {
    requireKey(key);
    if (!canCreateDraft(p)) throw new ApiError(403, 'FORBIDDEN', '无创建权限');
    if (!b.title.trim()) throw new ApiError(400, 'VALIDATION_ERROR', '申请标题必填');
    const { items, total } = draftValues(p.tenantId, b);
    const hash = createRequestHash(b);
    return this.db.$transaction(async tx => {
      const unique = { tenantId: p.tenantId, actorId: p.userId, operation: CREATE_OPERATION, key };
      const now = new Date();
      const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
      await tx.$executeRaw`INSERT INTO idempotency_keys (id, tenant_id, actor_id, operation, \`key\`, request_hash, response_status, response_body, resource_id, expires_at, created_at) VALUES (${randomUUID()}, ${p.tenantId}, ${p.userId}, ${CREATE_OPERATION}, ${key}, ${hash}, NULL, NULL, NULL, ${expiresAt}, ${now}) ON DUPLICATE KEY UPDATE id = idempotency_keys.id`;
      await tx.$queryRaw`SELECT id FROM idempotency_keys WHERE tenant_id=${p.tenantId} AND actor_id=${p.userId} AND operation=${CREATE_OPERATION} AND \`key\`=${key} FOR UPDATE`;
      let stored = await tx.idempotencyKey.findUnique({ where: { tenantId_actorId_operation_key: unique } });
      if (!stored) throw new ApiError(500, 'IDEMPOTENCY_CLAIM_FAILED', '幂等请求占位失败');
      if (stored.expiresAt <= now) {
        stored = await tx.idempotencyKey.update({ where: { id: stored.id }, data: { requestHash: hash, responseStatus: null, responseBody: Prisma.DbNull, resourceId: null, expiresAt } });
      }
      if (stored.requestHash !== hash) throw new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于其他请求');
      if (stored.responseStatus !== null && stored.responseBody !== null) return stored.responseBody;
      const row = await tx.purchaseApplication.create({
        data: {
          tenantId: p.tenantId,
          creatorId: p.userId,
          departmentId: p.departmentId,
          title: b.title.trim(),
          reason: b.reason?.trim() || null,
          costCenter: b.costCenter?.trim() || null,
          totalAmountCents: total,
          items: { create: items.map(item => ({
            lineNo: item.lineNo,
            name: item.name,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            lineAmountCents: item.lineAmountCents,
            note: item.note,
          })) },
        },
        include,
      });
      await tx.auditLog.create({ data: { tenantId: p.tenantId, eventType: 'APPLICATION_CREATED', actorId: p.userId, targetType: 'APPLICATION', targetId: row.id, result: 'SUCCESS', requestId: rid } });
      const response = this.detailDto(p, row);
      await tx.idempotencyKey.update({ where: { tenantId_actorId_operation_key: unique }, data: { responseStatus: 201, responseBody: response, resourceId: row.id, expiresAt } });
      return response;
    });
  }

  @Post('applications/:id')
  @HttpCode(200)
  @ApiOperation({ summary: '编辑草稿（POST 新路由）', description: '仅可编辑当前用户自己创建且仍为 DRAFT 的申请。' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: UpdateApplicationDto })
  @ApiResponse({ status: 200, description: '草稿已更新' })
  async update(@CurrentUser() p: Principal, @Param('id') id: string, @Body() b: UpdateApplicationDto, @RequestId() rid: string) {
    return this.updateDraft(p, id, b, rid);
  }

  @Put('applications/:id')
  @HttpCode(200)
  @ApiOperation({ summary: '编辑草稿（兼容旧 PUT 路由）', deprecated: true })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: UpdateApplicationDto })
  @ApiResponse({ status: 200, description: '草稿已更新' })
  async updateLegacy(@CurrentUser() p: Principal, @Param('id') id: string, @Body() b: UpdateApplicationDto, @RequestId() rid: string) {
    return this.updateDraft(p, id, b, rid);
  }

  private async updateDraft(p: Principal, id: string, b: UpdateApplicationDto, rid: string) {
    const old = await this.db.purchaseApplication.findFirst({ where: { id, tenantId: p.tenantId, creatorId: p.userId, status: 'DRAFT' } });
    if (!old) throw new ApiError(404, 'RESOURCE_NOT_FOUND', '资源不存在');
    if (!b.title.trim()) throw new ApiError(400, 'VALIDATION_ERROR', '申请标题必填');
    const items = b.items.map((item, index) => {
      const quantity = new Decimal(item.quantity);
      if (!quantity.isPositive()) throw new ApiError(400, 'VALIDATION_ERROR', '明细数量不合法');
      const amount = quantity.mul(item.unitPriceCents).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
      if (!Number.isSafeInteger(amount)) throw new ApiError(400, 'VALIDATION_ERROR', '金额超出范围');
      return { tenantId: p.tenantId, lineNo: index + 1, name: item.name.trim(), quantity: item.quantity, unitPriceCents: BigInt(item.unitPriceCents), lineAmountCents: BigInt(amount), note: item.note?.trim() || null };
    });
    const total = items.reduce((sum, item) => sum + item.lineAmountCents, 0n);
    const result = await this.db.$transaction(async tx => {
      const changed = await tx.purchaseApplication.updateMany({ where: { id, tenantId: p.tenantId, creatorId: p.userId, status: 'DRAFT', version: b.version }, data: { title: b.title.trim(), reason: b.reason?.trim() || null, costCenter: b.costCenter?.trim() || null, totalAmountCents: total, version: { increment: 1 } } });
      if (!changed.count) throw new ApiError(409, 'VERSION_CONFLICT', '草稿已更新，请刷新');
      await tx.purchaseApplicationItem.deleteMany({ where: { tenantId: p.tenantId, applicationId: id } });
      if (items.length) await tx.purchaseApplicationItem.createMany({ data: items.map(item => ({ ...item, applicationId: id })) });
      await tx.auditLog.create({ data: { tenantId: p.tenantId, eventType: 'APPLICATION_UPDATED', actorId: p.userId, targetType: 'APPLICATION', targetId: id, result: 'SUCCESS', requestId: rid } });
      return tx.purchaseApplication.findUniqueOrThrow({ where: { id }, include });
    });
    return this.detailDto(p, result);
  }

  @Delete('applications/:id')
  @HttpCode(204)
  async remove(@CurrentUser() p: Principal, @Param('id') id: string, @Query('version') version: string) {
    const result = await this.db.purchaseApplication.deleteMany({ where: { id, tenantId: p.tenantId, creatorId: p.userId, status: 'DRAFT', version: +version } });
    if (!result.count) throw new ApiError(409, 'VERSION_CONFLICT', '草稿不存在或已更新');
  }

  @Post('applications/:id/submit')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', maxLength: 64 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: SubmitApplicationDto })
  async submit(@CurrentUser() p: Principal, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() b: SubmitApplicationDto, @RequestId() rid: string): Promise<ApplicationDetailDto> {
    requireKey(key);
    const hash = submitRequestHash(id, b.version);
    for (let attempt = 0; attempt < SUBMIT_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.db.$transaction(async tx => {
      const unique = { tenantId: p.tenantId, actorId: p.userId, operation: SUBMIT_OPERATION, key };
      const now = new Date();
      const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
      await tx.$executeRaw`INSERT INTO idempotency_keys (id, tenant_id, actor_id, operation, \`key\`, request_hash, response_status, response_body, resource_id, expires_at, created_at) VALUES (${randomUUID()}, ${p.tenantId}, ${p.userId}, ${SUBMIT_OPERATION}, ${key}, ${hash}, NULL, NULL, ${id}, ${expiresAt}, ${now}) ON DUPLICATE KEY UPDATE id = idempotency_keys.id`;
      await tx.$queryRaw`SELECT id FROM idempotency_keys WHERE tenant_id=${p.tenantId} AND actor_id=${p.userId} AND operation=${SUBMIT_OPERATION} AND \`key\`=${key} FOR UPDATE`;
      let stored = await tx.idempotencyKey.findUnique({ where: { tenantId_actorId_operation_key: unique } });
      if (!stored) throw new ApiError(500, 'IDEMPOTENCY_CLAIM_FAILED', '幂等请求占位失败');
      if (stored && stored.expiresAt <= new Date()) {
        stored = await tx.idempotencyKey.update({ where: { id: stored.id }, data: { requestHash: hash, responseStatus: null, responseBody: Prisma.DbNull, resourceId: id, expiresAt } });
      }
      if (stored) {
        if (stored.requestHash !== hash) throw new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于其他请求');
        if (stored.responseStatus !== null && stored.responseBody !== null) return stored.responseBody as unknown as ApplicationDetailDto;
      }

      const locked: { id: string; status: ApplicationStatus; version: number; creator_id: string }[] = await tx.$queryRaw`SELECT id, status, version, creator_id FROM purchase_applications WHERE id=${id} AND tenant_id=${p.tenantId} FOR UPDATE`;
      if (!locked.length || locked[0].creator_id !== p.userId || locked[0].status !== ApplicationStatus.DRAFT || locked[0].version !== b.version) throw applicationStateChanged();
      const application = await tx.purchaseApplication.findFirst({ where: { id, tenantId: p.tenantId, creatorId: p.userId }, include: { items: true, department: true } });
      if (!application) throw applicationStateChanged();

      const manager = await tx.user.findFirst({ where: { id: application.department.managerUserId ?? '', tenantId: p.tenantId, role: 'DEPT_MANAGER', status: 'ACTIVE' } });
      const finance = await tx.user.findFirst({ where: { tenantId: p.tenantId, role: 'FINANCE', status: 'ACTIVE' } });
      const owner = await tx.user.findFirst({ where: { tenantId: p.tenantId, role: 'TENANT_OWNER', status: 'ACTIVE' } });
      const missing = [];
      if (!manager) missing.push('DEPT_MANAGER');
      if (!finance) missing.push('FINANCE');
      if (!owner) missing.push('TENANT_OWNER');
      if (!application.reason || !application.costCenter || !application.items.length || missing.length) throw new ApiError(409, 'APPROVAL_CONFIGURATION_INCOMPLETE', '审批配置或申请信息不完整', { missing });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId }, select: { timezone: true } });
      const sequenceDate = new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      await tx.$executeRaw`INSERT INTO tenant_sequences (tenant_id, sequence_date, next_value) VALUES (${p.tenantId}, ${sequenceDate}, 1) ON DUPLICATE KEY UPDATE next_value = tenant_sequences.next_value`;
      const sequence: any[] = await tx.$queryRaw`SELECT next_value FROM tenant_sequences WHERE tenant_id=${p.tenantId} AND sequence_date=${sequenceDate} FOR UPDATE`;
      if (!sequence.length) throw new ApiError(500, 'SEQUENCE_ALLOCATION_FAILED', '申请编号分配失败');
      const nextValue = Number(sequence[0].next_value);
      await tx.$executeRaw`UPDATE tenant_sequences SET next_value=next_value+1 WHERE tenant_id=${p.tenantId} AND sequence_date=${sequenceDate}`;
      const applicationNo = `PF-${sequenceDate.replaceAll('-', '')}-${String(nextValue).padStart(4, '0')}`;
      const changed = await tx.purchaseApplication.updateMany({ where: { id, tenantId: p.tenantId, creatorId: p.userId, status: ApplicationStatus.DRAFT, version: b.version }, data: { applicationNo, status: ApplicationStatus.PENDING_DEPT_MANAGER, currentApprovalNode: 'DEPT_MANAGER', submittedAt: new Date(), version: { increment: 1 } } });
      if (!changed.count) throw applicationStateChanged();
      try {
        await tx.workflowEvent.create({ data: { tenantId: p.tenantId, applicationId: id, eventType: 'SUBMITTED', actorId: p.userId, fromStatus: 'DRAFT', toStatus: 'PENDING_DEPT_MANAGER' } });
      } catch (error) {
        if (isSubmittedWorkflowUniqueRace(error)) throw applicationStateChanged();
        throw error;
      }
      await tx.auditLog.create({ data: { tenantId: p.tenantId, eventType: 'APPLICATION_SUBMITTED', actorId: p.userId, targetType: 'APPLICATION', targetId: id, result: 'SUCCESS', requestId: rid } });

      const updated = await tx.purchaseApplication.findUniqueOrThrow({ where: { id }, include });
      const response = this.detailDto(p, updated);
      await tx.idempotencyKey.update({ where: { tenantId_actorId_operation_key: unique }, data: { responseStatus: 200, responseBody: response, resourceId: id, expiresAt } });
      return response;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      } catch (error) {
        if (isRetryableMySqlTransactionError(error) && attempt + 1 < SUBMIT_TRANSACTION_ATTEMPTS) continue;
        if (isRetryableMySqlTransactionError(error)) throw concurrentOperationRetryExhausted();
        throw error;
      }
    }
    throw applicationStateChanged();
  }

  private canApprove(p: Principal, application: any) {
    return application.creatorId !== p.userId && ((application.status === 'PENDING_DEPT_MANAGER' && p.role === 'DEPT_MANAGER' && application.departmentId === p.departmentId) || (application.status === 'PENDING_FINANCE' && p.role === 'FINANCE') || (application.status === 'PENDING_TENANT_OWNER' && p.role === 'TENANT_OWNER'));
  }
}
