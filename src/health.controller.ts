import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fail, ok } from './core/envelope';
import { db } from './db/mongo';

@Controller()
export class HealthController {
  // GET /healthz and /health: database ping. Use /health on Cloud Run, which reserves /healthz.
  @Get(['healthz', 'health'])
  async health(@Res() res: Response) {
    try {
      const s = await db();
      await s.client.db('admin').command({ ping: 1 }, { timeoutMS: 2000 });
    } catch {
      throw fail(503, 'DB_UNAVAILABLE', 'Database is not reachable.');
    }
    ok(res, 200, { status: 'ok' });
  }
}
