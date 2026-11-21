import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import { getOpenMeteoCurrent } from '../../src/server/open-meteo-current.ts';

type Database = {
  query<T>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): void;
};

type Run = {
  tenant_id: string;
  connector_id: string;
  run_id: string;
  lease: string;
  latitude: number;
  longitude: number;
};

const CHECK_ACCOUNT = `
  SELECT pg_has_role(current_user, 'aiops_weather_worker', 'USAGE')
     AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
       OR pg_has_role(current_user, 'aiops_notification_worker', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_itsm_worker', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
       OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
       OR has_table_privilege(current_user, 'public.open_meteo_scopes', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(current_user, 'public.connector_sync_runs', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(current_user, 'public.metric_samples', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
       OR has_any_column_privilege(current_user, 'public.users', 'SELECT')) AS allowed
  FROM pg_roles WHERE rolname = current_user
`;

const ready = '/tmp/aiops-weather-ready';

async function main() {
  await rm(ready, { force: true });
  const connectionString = process.env.AIOPS_WEATHER_DB_DSN;
  if (!connectionString) throw new Error('DSN do worker climático ausente.');
  const { Pool } = createRequire(import.meta.url)('pg') as {
    Pool: new (options: { connectionString: string; max: number; connectionTimeoutMillis: number; statement_timeout: number }) => Database;
  };
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  let running = true;
  process.once('SIGTERM', () => { running = false; });
  process.once('SIGINT', () => { running = false; });
  pool.on('error', () => { running = false; process.exitCode = 1; });

  try {
    const account = await pool.query<{ allowed: boolean }>(CHECK_ACCOUNT);
    if (!account.rows[0]?.allowed) throw new Error('Conta do worker climático incompatível.');
    await writeFile(ready, 'ready\n');
    while (running) {
      if (process.env.AIOPS_WEATHER_WRITES !== 'true') {
        await setTimeout(2000);
        continue;
      }
      const { rows: [run] } = await pool.query<Run>('SELECT * FROM aiops_weather.claim_due()');
      if (!run) {
        await setTimeout(2000);
        continue;
      }
      const result = await getOpenMeteoCurrent(run.latitude, run.longitude);
      const failed = 'failure' in result;
      await pool.query(
        'SELECT * FROM aiops_weather.complete_due($1, $2, $3, $4, $5, $6::jsonb, $7)',
        [run.tenant_id, run.connector_id, run.run_id, run.lease, failed ? null : result.observed_at,
          failed ? null : JSON.stringify(result.readings), failed ? result.failure : null],
      );
    }
  } finally {
    await pool.end();
  }
}

void main().catch(async () => {
  await rm(ready, { force: true }).catch(() => {});
  console.error('Worker climático interrompido. Confira a conexão e as permissões.');
  process.exitCode = 1;
});
