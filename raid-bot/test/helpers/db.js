// A throwaway schema on TEST_DATABASE_URL for one test file, migrated fresh
// and dropped afterwards. Without TEST_DATABASE_URL the database tests skip.
const { Pool } = require('pg');
const { migrate } = require('../../src/migrate');
const { createStore } = require('../../src/store');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'set TEST_DATABASE_URL to run the database tests';

async function freshStore() {
  const schema = `raidbot_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
  await migrate(pool, { log: () => {} });
  const store = createStore(pool);
  return {
    pool,
    store,
    async close() {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    },
  };
}

module.exports = { skip, freshStore };
