import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController, AuthGuard } from './auth';
import { OrganizationController } from './organization';
import { ApplicationsController } from './applications';
import { OperationsController } from './operations';
import { PrismaService } from './prisma.service';
import { HealthController } from './health';
import { validateConfig } from './config';
@Module({imports:[ConfigModule.forRoot({isGlobal:true,validate:validateConfig})],controllers:[AuthController,OrganizationController,ApplicationsController,OperationsController,HealthController],providers:[PrismaService,AuthGuard]})
export class AppModule {}
