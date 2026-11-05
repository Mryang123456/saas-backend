import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, NestInterceptor, ExecutionContext, CallHandler, createParamDecorator } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { randomUUID } from 'node:crypto';

export class ApiError extends HttpException {
  constructor(status: number, public readonly code: string, message: string, public readonly details?: unknown) { super(message, status); }
}
export type Principal = { tenantId:string; tenantSlug:string; userId:string; departmentId:string; role:string };
export const CurrentUser = createParamDecorator((_d, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().user);
export const RequestId = createParamDecorator((_d, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().requestId);

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    return next.handle().pipe(map((data) => data === undefined ? undefined : ({ data, meta: { requestId: req.requestId } })));
  }
}
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp(), req = ctx.getRequest(), res = ctx.getResponse();
    let status = HttpStatus.INTERNAL_SERVER_ERROR, code = 'INTERNAL_ERROR', message = '服务暂时不可用', details: unknown;
    if (error instanceof ApiError) { status = error.getStatus(); code = error.code; message = error.message; details = error.details; }
    else if (error instanceof HttpException) { status = error.getStatus(); code = status === 404 ? 'RESOURCE_NOT_FOUND' : 'INVALID_REQUEST'; message = error.message; }
    res.status(status).send({ error: { code, message, ...(details === undefined ? {} : { details }) }, meta: { requestId: req.requestId ?? randomUUID() } });
  }
}
