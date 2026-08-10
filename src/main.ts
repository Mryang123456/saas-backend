import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { ApiExceptionFilter, EnvelopeInterceptor } from './common';

// @ts-expect-error Fastify is duplicated through the Nest adapter, but the plugin API is runtime-compatible.
export async function createApp():Promise<NestFastifyApplication>{const adapter=new FastifyAdapter({bodyLimit:1024*1024,trustProxy:process.env.TRUST_PROXY==='true'});const app=await NestFactory.create<NestFastifyApplication>(AppModule,adapter);await app.register(helmet);const origins=(process.env.CORS_ALLOWED_ORIGINS??'http://localhost:5173').split(',');app.enableCors({origin:origins,credentials:false,methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'],allowedHeaders:['Authorization','Content-Type','X-Request-Id','Idempotency-Key']});app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));app.useGlobalInterceptors(new EnvelopeInterceptor());app.useGlobalFilters(new ApiExceptionFilter());adapter.getInstance().addHook('onRequest',(req:any,reply:any,done:any)=>{const requested=String(req.headers['x-request-id']??'');req.requestId=/^[0-9a-f-]{36}$/i.test(requested)?requested:randomUUID();reply.header('X-Request-Id',req.requestId);done()});const doc=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('ProcureFlow API').setVersion('1.0').addBearerAuth().build());SwaggerModule.setup('api/docs',app,doc,{jsonDocumentUrl:'/api/docs-json'});await app.init();return app}
if(require.main===module)createApp().then(app=>app.listen(Number(process.env.PORT??3000),'0.0.0.0'));
