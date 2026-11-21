// Execute dentro do contêiner Web e redirecione a saída para um arquivo privado.
import Database from 'better-sqlite3';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

async function backup() {
  const source = process.env.SQLITE_DB_PATH;
  if (!source) throw new Error('SQLITE_DB_PATH ausente');

  const directory = await mkdtemp(join(tmpdir(), 'aiops-sqlite-backup-'));
  const snapshot = join(directory, 'aiops.db');
  try {
    const active = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await active.backup(snapshot);
    } finally {
      active.close();
    }
    const copy = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Snapshot inválido');
    } finally {
      copy.close();
    }
    await pipeline(createReadStream(snapshot), process.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await backup();
} catch {
  process.stderr.write('Falha ao criar ou transferir o backup SQLite.\n');
  process.exitCode = 1;
}
