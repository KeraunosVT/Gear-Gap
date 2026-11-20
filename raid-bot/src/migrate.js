// Applies migrations/*.sql in name order, each once, each in a transaction.
// The bot runs this on start; `npm run migrate` runs it on its own.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'migrations');

async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    // Two instances starting together would otherwise race to apply the same file.
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const { rows } = await client.query('select name from schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        log(`Applied migration ${file}`);
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const { createPool } = require('./db');
  const pool = createPool();
  migrate(pool)
    .then(() => { console.log('Migrations up to date.'); return pool.end(); })
    .catch((err) => { console.error(err.message); process.exitCode = 1; return pool.end(); });
}
