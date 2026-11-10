// Vercel function entry (api/index.js loads this). The Express + Nest app is built once
// per function instance and reused by later requests, together with the MongoDB connection.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { createApp } from './app';

let app: Promise<Express> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  app ??= createApp().catch((err) => {
    app = undefined;
    throw err;
  });
  const server = await app;
  server(req as any, res as any);
}
