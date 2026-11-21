import express from 'express';

export function createHttpApp() {
  const app = express();
  const proxy = process.env.AIOPS_TRUST_PROXY?.trim();
  if (proxy) app.set('trust proxy', proxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  return app;
}
