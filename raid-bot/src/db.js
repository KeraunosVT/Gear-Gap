// The Postgres pool. Any Postgres works; Supabase's connection string is the
// usual one.
//
// TLS: a hosted database's certificate is often signed by the host's own CA
// rather than a public one (Supabase's is), which Node won't trust by default.
// Point DATABASE_CA_FILE at that CA certificate (Supabase: Project Settings →
// Database → SSL Configuration → Download certificate) to connect verified.
// Without it, the connection string's own sslmode decides.
const fs = require('node:fs');
const { Pool } = require('pg');

function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const caFile = process.env.DATABASE_CA_FILE;
  const ssl = caFile ? { ca: fs.readFileSync(caFile, 'utf8'), rejectUnauthorized: true } : undefined;
  // A CA given here overrides any sslmode in the URL, which pg would
  // otherwise apply on top of it.
  const connectionString = ssl ? url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '') : url;
  const pool = new Pool({ connectionString, ssl, max: Number(process.env.DATABASE_POOL_SIZE) || 5 });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  return pool;
}

module.exports = { createPool };
