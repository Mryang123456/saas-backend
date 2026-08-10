# ProcureFlow Backend

NestJS、Fastify、Prisma 与 MySQL 8.0.16+ 构建的多租户采购审批模块化单体。当前 Docker 开发基线为 MySQL 8.4；服务启动时会读取 `SELECT VERSION()` 并拒绝 MySQL 5.7、低于 8.0.16 的版本及 MariaDB。

## 本地启动

要求 Node.js 22 与 Docker Desktop。先复制环境变量示例，并为本机设置独立的数据库、root、seed 与 session pepper 值：

```powershell
Copy-Item .env.example .env
docker compose up -d mysql
docker compose ps
npm.cmd install
npm.cmd run prisma:generate
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run start:dev
```

不要把 `.env` 提交到版本库，也不要在共享或生产环境使用示例密码。如果密码包含 URL 保留字符，`DATABASE_URL` 中的密码部分必须进行 URL 编码。

数据库就绪检查：

```powershell
docker compose exec mysql mysqladmin ping -h 127.0.0.1 -u procureflow -p
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

Swagger UI 位于 `http://localhost:3000/api/docs`。演示租户为 `acme`，seed 用户密码来自本机 `.env` 的 `SEED_PASSWORD`；生产环境禁止执行 seed。

## MySQL 一致性设计

- UUID 由 Prisma 生成并保存为 `CHAR(36)`，所有复合外键使用一致的字符类型和排序规则。
- 数据库采用 `utf8mb4_unicode_ci`，用户名、租户 slug、部门名及文本筛选默认不区分大小写。
- 所有业务表显式使用 InnoDB。提交审批交互事务使用 `READ COMMITTED`，先以 `(tenant, actor, operation, key)` 占位并锁定幂等记录，再通过 `SELECT ... FOR UPDATE` 直接读取并校验最新申请状态，最后以 `DRAFT + version` 条件更新；相同 key 回放首次响应，不同 payload 返回冲突，不同 key 只能有一个事务推进草稿。
- MySQL deadlock、lock timeout 与 Prisma write conflict 最多尝试三次；耗尽后返回 HTTP 409 `CONCURRENT_OPERATION_RETRY_EXHAUSTED`，客户端可以稍后使用原幂等 key 重试。
- 只有能够从 Prisma `meta.target`/constraint 确认为 `workflow_events(application_id,event_type)` 的 P2002 才映射为 `APPLICATION_STATE_CHANGED`；applicationNo 或来源不明的 P2002 保留为内部错误，避免掩盖数据库约束缺陷。
- 审批动作使用申请行锁、状态/version 校验和 `(application_id, node)` 唯一键。
- 提交事件使用 `(application_id, event_type)` 唯一键，防止重复工作流节点。
- 每日申请编号通过 `tenant_sequences` 行锁分配，业务日期由租户 IANA 时区在应用层计算，不依赖 MySQL session 时区。
- 金额、数量及单一有效企业负责人约束由 MySQL 8 CHECK/生成列唯一索引保证。
- JSON 字段使用 MySQL 原生 `JSON`，应用时间戳保存为 UTC `DATETIME(3)`，API 输出 ISO 8601。

## V1 数据库基线

项目尚未正式部署，因此 PostgreSQL 初始 migration 已直接替换为干净的 MySQL V1 初始 migration。这不是线上 PostgreSQL 数据迁移脚本，不能对已有 PostgreSQL 数据库执行。

已有本地 PostgreSQL 数据不会自动复制到 MySQL。如需保留历史开发数据，应另行设计一次性 ETL；不要把 PostgreSQL volume 直接挂载给 MySQL。

## 验证

```powershell
npx.cmd prisma format
npx.cmd prisma validate
npm.cmd run prisma:generate
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

当前自动化测试包含 MySQL 提交锁顺序、同 key 回放、异 payload 冲突、不同 key 竞争、事务回滚重试，以及 workflow/audit/幂等结果唯一性。真实数据库并发验收仍应在本地 MySQL 8.4 上执行。
