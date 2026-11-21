import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import { ticketDispatcher, type TicketOperation } from './operation.ts';

type Database = {
  query<T>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): void;
};

const CHECK_ACCOUNT = `
  SELECT pg_has_role(current_user, 'aiops_itsm_worker', 'USAGE')
     AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
       OR pg_has_role(current_user, 'aiops_notification_worker', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
       OR has_table_privilege(current_user, 'aiops_notifications.itsm_integrations', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(current_user, 'aiops_notifications.itsm_ticket_creations', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
       OR has_any_column_privilege(current_user, 'public.users', 'SELECT')) AS allowed
  FROM pg_roles WHERE rolname = current_user
`;

async function main() {
  const readyFile = '/tmp/aiops-itsm-ready';
  await rm(readyFile, { force: true });
  const connectionString = process.env.AIOPS_ITSM_DB_DSN;
  if (!connectionString) throw new Error('DSN ITSM ausente.');
  const { Pool } = createRequire(import.meta.url)('pg') as {
    Pool: new (options: { connectionString: string; max: number; connectionTimeoutMillis: number; statement_timeout: number }) => Database;
  };
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  const dispatch = ticketDispatcher(process.env.AIOPS_ITSM_CONFIG_DIR ?? '/run/aiops-itsm');
  let running = true;
  process.once('SIGTERM', () => { running = false; });
  process.once('SIGINT', () => { running = false; });
  pool.on('error', () => { running = false; process.exitCode = 1; });

  try {
    const account = await pool.query<{ allowed: boolean }>(CHECK_ACCOUNT);
    if (!account.rows[0]?.allowed) throw new Error('Conta do worker ITSM incompatível.');
    await writeFile(readyFile, 'ready\n');
    while (running) {
      const { rows: [job] } = await pool.query<TicketOperation>('SELECT * FROM aiops_notifications.claim_itsm_creation()');
      if (!job) {
        await setTimeout(2000);
        continue;
      }
      const result = await dispatch(job);
      await pool.query(
        'SELECT aiops_notifications.complete_itsm_creation($1, $2, $3, $4, $5, $6)',
        [job.operation_id, job.lease_token, result.code, result.externalId, result.reference, result.retryAfterSeconds ?? null],
      );
    }
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error('Worker ITSM interrompido. Confira a conexão e as permissões.');
  process.exitCode = 1;
});
