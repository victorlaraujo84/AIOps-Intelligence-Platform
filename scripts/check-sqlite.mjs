import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Prova que o binário distribuído funciona sem criar um banco operacional.
const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE install_probe (value INTEGER NOT NULL)');
  db.prepare('INSERT INTO install_probe (value) VALUES (?)').run(1);
  assert.equal(db.prepare('SELECT value FROM install_probe').get().value, 1);
  console.log(`SQLite nativo verificado (${process.platform}/${process.arch}, Node ${process.version}).`);
} finally {
  db.close();
}
