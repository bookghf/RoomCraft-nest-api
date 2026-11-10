import 'reflect-metadata';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { config } from './config';
import { ApiErrorFilter } from './core/error.filter';
import { auth, cors, logging, rateLimit, rawBody } from './core/http';

/**
 * Builds the Express app with the API's middleware and Nest's routes. Used by the local
 * server (main.ts) and the Vercel function (vercel.ts).
 */
export async function createApp(): Promise<express.Express> {
  config(); // fail fast on missing settings
  const server = express();
  server.disable('x-powered-by');
  server.set('etag', false);
  server.use(logging, cors, auth, rateLimit, rawBody);

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  app.useGlobalFilters(new ApiErrorFilter());
  await app.init();
  return server;
}
