import { ArgumentsHost, Catch, ExceptionFilter, HttpException, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, fail, sendError } from './envelope';

/**
 * Turns every thrown error into the SmartWorld envelope. ApiError keeps its status and code;
 * an unknown route is 404 "Endpoint not found."; anything else is logged and becomes 500 INTERNAL.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    if (res.headersSent) return;
    if (exception instanceof ApiError) return sendError(res, exception);
    if (exception instanceof NotFoundException) return sendError(res, fail(404, 'NOT_FOUND', 'Endpoint not found.'));
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      return sendError(res, fail(exception.getStatus(), 'BAD_REQUEST', exception.message));
    }
    console.error(JSON.stringify({
      time: new Date().toISOString(), level: 'ERROR', msg: 'request failed',
      method: req.method, path: req.path, err: exception instanceof Error ? exception.stack ?? exception.message : String(exception),
    }));
    sendError(res, fail(500, 'INTERNAL', 'Something went wrong.'));
  }
}
