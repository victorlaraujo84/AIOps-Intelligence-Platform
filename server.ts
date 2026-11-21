import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createPostgresApp } from './src/server/postgres-app.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const postgresOnly = process.env.AIOPS_POSTGRES_PILOT_ONLY === 'true';
  if (postgresOnly && process.env.AIOPS_POSTGRES_CONSOLE !== 'true') {
    throw new Error('Habilite o console PostgreSQL neste modo.');
  }
  const app = postgresOnly ? createPostgresApp() : (await import('./src/server/app.ts')).createApp().app;

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[aiops-platform] Servidor ativo na porta ${PORT} (${isProduction ? 'producao' : 'desenvolvimento'})`);
  });
}

startServer().catch((err) => {
  console.error('[aiops-platform] Erro fatal ao iniciar servidor:', err);
  process.exit(1);
});
