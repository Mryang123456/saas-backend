import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertSupportedMySqlVersion } from './config';
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    try {
      const rows = await this.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
      assertSupportedMySqlVersion(rows[0]?.version ?? 'unknown');
    } catch (error) {
      await this.$disconnect();
      throw error;
    }
  }
  async onModuleDestroy() { await this.$disconnect(); }
}
