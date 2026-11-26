import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'sag-v1-db-'));
const runtime = join(work, 'relocated-postgres');
const data = join(work, 'data');
const user = 'sag_desktop';
const password = randomBytes(32).toString('hex');
const ext = process.platform === 'win32' ? '.exe' : '';
const exe = name => join(runtime, 'bin', name + ext);
const env = { ...process.env, PGPASSWORD: password };
function run(name, args, options = {}) {
  const result = spawnSync(name, args, { env, stdio: 'inherit', timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw new Error(name + ' failed: ' + (result.error?.message || result.status));
}
const port = await new Promise((resolvePort, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const port = s.address().port;
    s.close(error => error ? reject(error) : resolvePort(port));
  });
});
const url = 'postgres://' + user + ':' + password + '@127.0.0.1:' + port + '/postgres';
let started = false;
try {
  cpSync(resolve(root, 'postgres-runtime'), runtime, { recursive: true, verbatimSymlinks: true });
  const passwordFile = join(work, 'password.txt');
  writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
  run(exe('initdb'), ['-D', data, '--username=' + user, '--pwfile=' + passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale']);
  rmSync(passwordFile);
  const opts = '-h 127.0.0.1 -p ' + port + (process.platform === 'win32' ? '' : ' -k ""');
  const start = () => {
    run(exe('pg_ctl'), ['start', '-D', data, '-l', join(work, 'postgres.log'), '-o', opts, '-w', '-t', '45']);
    started = true;
  };
  const stop = () => {
    run(exe('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '45']);
    started = false;
  };
  start();
  // Compiled migrate.ts resolves migrations relative to dist/, not the source root.
  cpSync(resolve(root, 'migrations'), resolve(root, 'dist/migrations'), { recursive: true });
  run(process.execPath, ['dist/src/db/migrate.js'], { env: { ...env, DATABASE_URL: url } });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("select extversion from pg_extension where extname = 'vector'");
    if (!rows.length) throw new Error('pgvector not installed by migrations');
    await client.query("create table desktop_smoke (id integer primary key, v vector(1024))");
    await client.query('insert into desktop_smoke values (1, $1::vector)', ['[' + Array(1024).fill(1).join(',') + ']']);
    const result = await client.query('select v <-> v as distance from desktop_smoke');
    if (Number(result.rows[0].distance) !== 0) throw new Error('Vector query failed');
  } finally { await client.end(); }
  stop();
  start();
  const reopened = new pg.Client({ connectionString: url });
  await reopened.connect();
  try {
    const result = await reopened.query('select count(*)::int as n from desktop_smoke');
    if (result.rows[0].n !== 1) throw new Error('Database persistence failed');
  } finally { await reopened.end(); }
  stop();
  console.log('Native PostgreSQL, V1 migrations, vector query and persistence passed.');
} finally {
  if (started) run(exe('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '45']);
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}
