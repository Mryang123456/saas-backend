import { Controller, Get, Logger } from '@nestjs/common';
import { ApiError } from './common';
import { PrismaService } from './prisma.service';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private db: PrismaService) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      this.logger.error('Database readiness probe failed', error instanceof Error ? error.stack : undefined);
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', '数据库尚未就绪');
    }
  }
}
