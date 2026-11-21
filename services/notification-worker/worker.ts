import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import { webhookDispatcher, type WebhookJob } from './webhook.ts';

type Database = {
  query<T>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): void;
};

const CHECK_ACCOUNT = `
  SELECT pg_has_role(current_user, 'aiops_notification_worker', 'USAGE')
     AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
       OR pg_has_role(current_user, 'aiops_weather_worker', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_itsm_worker', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
       OR has_table_privilege(current_user, 'aiops_notifications.webhook_channels', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(current_user, 'aiops_notifications.webhook_deliveries', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(current_user, 'aiops_notifications.webhook_attempts', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
       OR has_any_column_privilege(current_user, 'public.users', 'SELECT')) AS allowed
  FROM pg_roles WHERE rolname = current_user
`;

const ready = '/tmp/aiops-notification-ready';

async function main() {
  await rm(ready, { force: true });
  const connectionString = process.env.AIOPS_NOTIFICATION_DB_DSN;
  if (!connectionString) throw new Error('DSN de notificações ausente.');
  const { Pool } = createRequire(import.meta.url)('pg') as {
    Pool: new (options: { connectionString: string; max: number; connectionTimeoutMillis: number; statement_timeout: number }) => Database;
  };
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  const origins = new Set((process.env.AIOPS_WEBHOOK_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean));
  const dispatch = webhookDispatcher('/run/aiops-webhooks', origins);
  let running = true;
  process.once('SIGTERM', () => { running = false; });
  process.once('SIGINT', () => { running = false; });
  pool.on('error', () => { running = false; process.exitCode = 1; });

  try {
    const account = await pool.query<{ allowed: boolean }>(CHECK_ACCOUNT);
    if (!account.rows[0]?.allowed) throw new Error('Conta de notificações incompatível.');
    await writeFile(ready, 'ready\n');
    while (running) {
      if (process.env.AIOPS_NOTIFICATION_WRITES !== 'true') {
        await setTimeout(2000);
        continue;
      }
      const { rows: [run] } = await pool.query<WebhookJob>('SELECT * FROM aiops_notifications.claim_webhook()');
      if (!run) {
        await setTimeout(2000);
        continue;
      }
      const outcome = await dispatch(run);
      await pool.query(
        'SELECT aiops_notifications.complete_webhook($1, $2, $3, $4, $5, $6)',
        [run.tenant_id, run.delivery_id, run.lease, outcome.result, outcome.status ?? null, outcome.retryAfter ?? null],
      );
      await setTimeout(250);
    }
  } finally {
    await pool.end();
  }
}

void main().catch(async () => {
  await rm(ready, { force: true }).catch(() => {});
  console.error('Worker de notificações interrompido. Confira a conexão e as permissões.');
  process.exitCode = 1;
});
