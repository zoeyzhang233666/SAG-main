import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, createServer } from 'node:net';
import { createRequire } from 'node:module';

const [target, upgradeProfile] = process.argv.slice(2);
const source = target === '--source';
const exe = source ? createRequire(import.meta.url)('electron') : path.resolve(target ?? '');
const args = source ? [path.resolve('desktop')] : [];
if (!fs.statSync(exe).isFile()) throw Error('Missing executable ' + exe);
const data = upgradeProfile ? path.resolve(upgradeProfile) : fs.mkdtempSync(path.join(os.tmpdir(), 'SAG V1 smoke-'));

function isListening(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
    socket.setTimeout(5000, () => socket.destroy(new Error('Backend shutdown check timed out')));
  });
}

const occupiedPort = createServer();
await new Promise((resolve, reject) => {
  occupiedPort.on('error', reject);
  occupiedPort.listen(0, '127.0.0.1', resolve);
});
const firstDatabasePort = occupiedPort.address().port;
try {
  for (const mode of [upgradeProfile ? 'upgrade' : 'write', 'read']) {
    const marker = path.join(data, 'smoke-' + mode + '.ok');
    fs.rmSync(marker, { force: true });
    const result = spawnSync(exe, [...args, '--desktop-smoke=' + mode], {
      env: { ...process.env, SAG_V1_SMOKE_DATA: data, SAG_V1_SMOKE_PG_PORT: String(firstDatabasePort) },
      stdio: 'inherit',
      timeout: 300000,
      windowsHide: true
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Application smoke ' + mode + ' exited unsuccessfully');
    const origin = new URL(fs.readFileSync(marker, 'utf8').trim());
    assert.ok(!await isListening(Number(origin.port)), 'Backend still running after app quit');
    assert.ok(!fs.existsSync(path.join(data, 'postgres-data', 'postmaster.pid')), 'PostgreSQL still running after app quit');
  }
  const events = fs.readFileSync(path.join(data, 'logs', 'desktop.log'), 'utf8');
  assert.ok(events.includes(`PostgreSQL loopback port ${firstDatabasePort} was occupied; retrying with another port`),
    'Desktop did not exercise PostgreSQL port conflict recovery');
  console.log('Desktop port-conflict recovery, import, graph details, restart persistence and process shutdown passed.');
} catch (error) {
  for (const name of ['desktop.log', 'backend.log', 'postgres-control.log', 'postgres.log']) {
    const file = path.join(data, 'logs', name);
    if (fs.existsSync(file)) console.error(name + '\n' + fs.readFileSync(file, 'utf8').slice(-18000));
  }
  throw error;
} finally {
  occupiedPort.close();
  if (!upgradeProfile && !fs.existsSync(path.join(data, 'postgres-data', 'postmaster.pid'))) {
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}
