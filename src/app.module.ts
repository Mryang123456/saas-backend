import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController, AuthGuard } from './modules/auth/auth';
import { OrganizationController } from './modules/organization/organization';
import { ApplicationsController } from './modules/applications/applications';
import { OperationsController } from './modules/operations/operations';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { HealthController } from './modules/health/health';
import { validateConfig } from './config/config';
@Module({imports:[ConfigModule.forRoot({isGlobal:true,validate:validateConfig})],controllers:[AuthController,OrganizationController,ApplicationsController,OperationsController,HealthController],providers:[PrismaService,AuthGuard]})
export class AppModule {}
