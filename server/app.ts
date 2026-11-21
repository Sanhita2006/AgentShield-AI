import express from 'express';
import cookieParser from 'cookie-parser';
import bankRoutes from './routes/bankRoutes.ts';
import gatewayRoutes from './routes/gatewayRoutes.ts';
import appRoutes from './routes/appRoutes.ts';
import { sameOriginGuard } from './auth.ts';
import { isDemoMode, isProd } from './config.ts';

/** Builds the API app without listening, so tests can drive it with supertest. */
export function createApp() {
  const app = express();

  if (process.env.TRUST_PROXY) {
    // e.g. TRUST_PROXY=1 behind a single load balancer so req.ip is the real client address
    app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  }
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (isProd()) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      // Vite dev needs inline/eval scripts, so the strict policy is production-only
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
          "base-uri 'self'; form-action 'self'; object-src 'none'"
      );
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  // API responses carry account data and decisions: never cache them in browsers or proxies
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', sameOriginGuard);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'AgentShield Gateway', ...(isDemoMode() ? { demoMode: true } : {}), timestamp: Date.now() });
  });

  // Clearly separated architectural API namespaces
  app.use('/api/bank', bankRoutes);
  app.use('/api/gateway', gatewayRoutes);
  app.use('/api', appRoutes);

  // Last-resort handler: never leak internals, never let a thrown error take the process down
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[agentshield] unhandled route error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
