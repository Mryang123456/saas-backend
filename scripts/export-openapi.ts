import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';

async function exportOpenApi(){const app=await NestFactory.create<NestFastifyApplication>(AppModule,new FastifyAdapter(),{logger:false});try{const document=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('ProcureFlow API').setVersion('1.0').addBearerAuth().build());const output=resolve(process.argv[2]??'openapi.json');await writeFile(output,`${JSON.stringify(document,null,2)}\n`,'utf8');process.stdout.write(`OpenAPI document written to ${output}\n`)}finally{await app.close()}}
void exportOpenApi();
