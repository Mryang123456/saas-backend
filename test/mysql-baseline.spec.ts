import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('MySQL V1 baseline', () => {
  it('uses MySQL-compatible Prisma native types and migration metadata', () => {
    const schema = read('prisma/schema.prisma');
    const lock = read('prisma/migrations/migration_lock.toml');
    expect(schema).toContain('provider = "mysql"');
    expect(schema).toContain('@db.Char(36)');
    expect(schema).toContain('responseBody   Json?');
    expect(schema).not.toContain('@db.Uuid');
    expect(lock).toContain('provider = "mysql"');
  });

  it('keeps database-level uniqueness and financial invariants in the MySQL migration', () => {
    const migration = read('prisma/migrations/202608080001_init_mysql/migration.sql');
    expect(migration).toContain('workflow_events_application_id_event_type_key');
    expect(migration).toContain('idempotency_keys_tenant_id_actor_id_operation_key_key');
    expect(migration).toContain('approval_records_application_id_node_key');
    expect(migration).toContain('GENERATED ALWAYS AS');
    expect(migration).toContain('`users_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT');
    expect(migration).toContain('`users_tenant_id_department_id_fkey` FOREIGN KEY (`tenant_id`, `department_id`) REFERENCES `departments` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT');
    expect(migration).toContain('CONSTRAINT `amount_safe` CHECK');
    expect(migration).toContain('`key` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    expect(migration.match(/^CREATE TABLE/gm)).toHaveLength(11);
    expect(migration.match(/ENGINE=InnoDB/g)).toHaveLength(11);
    expect(migration).not.toMatch(/::uuid|ON CONFLICT|pg_advisory|JSONB|CREATE TYPE/i);
  });

  it('contains no PostgreSQL-only SQL in submission or approval transactions', () => {
    const sources = `${read('src/modules/applications/applications.ts')}\n${read('src/modules/operations/operations.ts')}`;
    expect(sources).toContain('ON DUPLICATE KEY UPDATE');
    expect(sources).toContain('FOR UPDATE');
    expect(sources).not.toMatch(/::uuid|ON CONFLICT|pg_advisory|hashtextextended/i);
  });
});
