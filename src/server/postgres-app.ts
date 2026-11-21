import { createHttpApp } from './http-app.ts';
import { postgresConsoleRouter } from './postgres-console.ts';

export function createPostgresApp() {
  const app = createHttpApp();
  const siteWrites = process.env.AIOPS_POSTGRES_PILOT_WRITE_SITES === 'true';
  app.get('/api/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const core = await fetch('http://api:8000/ready', { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (core.ok) {
        res.json({ status: 'ok', service: 'aiops-web-api', db: 'connected' });
        return;
      }
    } catch {
      // Core indisponível ou sem conexão com o banco.
    }
    res.status(503).json({ status: 'degraded', db: 'error' });
  });
  app.use('/api/postgres-console', postgresConsoleRouter(true, true, siteWrites));
  app.get('/', (_req, res) => res.redirect(302, '/postgres-inventory'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota indisponível no console PostgreSQL.' }));
  return app;
}
