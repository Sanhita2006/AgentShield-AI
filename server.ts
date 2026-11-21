import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

dotenv.config();

async function startServer() {
  const { assertConfig } = await import('./server/config.ts');
  const { getDb } = await import('./server/db/database.ts');
  const { ensureSeeded } = await import('./server/db/seed.ts');
  const { createApp } = await import('./server/app.ts');

  assertConfig();
  process.on('unhandledRejection', (err) => console.error('[agentshield] unhandled rejection', err));
  const app = createApp();
  const port = 3000;

  ensureSeeded(getDb());

  // Serve Vite dev middleware in development, static dist/ in production
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(process.cwd(), 'dist');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (isProd && !fs.existsSync(distPath)) {
    console.warn('[agentshield] WARNING: dist/ not found. Run `npm run build` first; only the API will be served.');
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`AgentShield server running at http://localhost:${port}`);
  });

  // Expire stale approvals even when nobody is polling, and tell the customer's open session
  const { expirePendingApprovals } = await import('./server/gateway/stage4_escalation.ts');
  const { broadcastSseEvent } = await import('./server/sse.ts');
  const sweep = setInterval(() => {
    try {
      for (const a of expirePendingApprovals(getDb())) {
        broadcastSseEvent('approval:resolved', { approvalId: a.id, customerId: a.customer_id, status: 'expired' });
      }
    } catch (err) {
      console.error('Approval expiry sweep failed:', err);
    }
  }, 30_000);
  sweep.unref();

  // Finish in-flight requests and flush the SQLite WAL on SIGTERM/SIGINT (Docker stop, Ctrl+C)
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    clearInterval(sweep);
    server.close(() => {
      try {
        getDb().close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('Failed to start AgentShield server:', err);
  process.exit(1);
});
