import { CanActivate, Controller, ExecutionContext, Get, Injectable, Post, Body, Param, Headers, HttpCode, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { ApiError, CurrentUser, Principal, RequestId } from './common';
import { PrismaService } from './prisma.service';
import { LoginDto } from './auth.dto';

const hashToken = (token:string, pepper:string) => createHash('sha256').update(token).update(pepper).digest('hex');
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private db:PrismaService, private cfg:ConfigService) {}
  async canActivate(ctx:ExecutionContext) {
    const req=ctx.switchToHttp().getRequest(), auth=String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ')) throw new ApiError(401,'UNAUTHENTICATED','请先登录');
    const tokenHash=hashToken(auth.slice(7),this.cfg.getOrThrow('SESSION_TOKEN_PEPPER'));
    const session=await this.db.session.findUnique({where:{tokenHash},include:{user:{include:{tenant:true,department:true}}}});
    if (!session || session.revokedAt || session.expiresAt<=new Date() || session.user.status!=='ACTIVE' || session.user.tenant.status!=='ACTIVE') throw new ApiError(401,'UNAUTHENTICATED','会话无效或已过期');
    if (session.user.tenant.slug!==req.params.tenantId) throw new ApiError(403,'TENANT_FORBIDDEN','租户不匹配');
    req.user={tenantId:session.tenantId,tenantSlug:session.user.tenant.slug,userId:session.userId,departmentId:session.user.departmentId,role:session.user.role};
    return true;
  }
}
@Controller('api/v1/tenants/:tenantId/auth')
export class AuthController {
  constructor(private db:PrismaService,private cfg:ConfigService){}
  @Post('login') async login(@Param('tenantId') slug:string,@Body() body:LoginDto,@RequestId() requestId:string){
    const user=await this.db.user.findFirst({where:{tenant:{slug,status:'ACTIVE'},username:{equals:body.username},status:'ACTIVE'},include:{tenant:true,department:true}});
    const ok=user && await argon2.verify(user.passwordHash,body.password+this.cfg.get('PASSWORD_PEPPER',''));
    if(!ok) throw new ApiError(401,'INVALID_CREDENTIALS','用户名或密码错误');
    const token=`sess_${randomBytes(32).toString('base64url')}`, expiresAt=new Date(Date.now()+this.cfg.get<number>('SESSION_TTL_SECONDS',28800)*1000);
    await this.db.$transaction(async tx=>{await tx.session.create({data:{tenantId:user.tenantId,userId:user.id,tokenHash:hashToken(token,this.cfg.getOrThrow('SESSION_TOKEN_PEPPER')),expiresAt}});await tx.auditLog.create({data:{tenantId:user.tenantId,eventType:'AUTH_LOGIN_SUCCESS',actorId:user.id,targetType:'SESSION',result:'SUCCESS',requestId}})});
    return {token,expiresAt:expiresAt.toISOString(),tenant:{id:user.tenant.id,slug:user.tenant.slug,name:user.tenant.name,timezone:user.tenant.timezone},user:summary(user)};
  }
  @Post('logout') @UseGuards(AuthGuard) @HttpCode(204) async logout(@Headers('authorization') auth:string){if(!auth?.startsWith('Bearer '))throw new ApiError(401,'UNAUTHENTICATED','会话无效');const r=await this.db.session.updateMany({where:{tokenHash:hashToken(auth.slice(7),this.cfg.getOrThrow('SESSION_TOKEN_PEPPER')),revokedAt:null},data:{revokedAt:new Date()}});if(!r.count)throw new ApiError(401,'UNAUTHENTICATED','会话无效');}
  @Get('me') @UseGuards(AuthGuard) async me(@CurrentUser() p:Principal){const u=await this.db.user.findFirstOrThrow({where:{id:p.userId,tenantId:p.tenantId},include:{tenant:true,department:true}});return {tenant:{id:u.tenant.id,slug:u.tenant.slug,name:u.tenant.name,timezone:u.tenant.timezone},user:summary(u)};}
}
export function summary(u:any){return{id:u.id,username:u.username,displayName:u.displayName,role:u.role,status:u.status,department:{id:u.department.id,name:u.department.name,status:u.department.status}}}
