const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const { once } = require('node:events');

function spawnLogged(file, args, cwd, env, logFile, ipc = false) {
  const fd = fs.openSync(logFile, 'a');
  try {
    const stdio = ['ignore', fd, fd];
    if (ipc) stdio.push('ipc');
    return spawn(file, args, { cwd, env, stdio, windowsHide: true });
  } finally {
    fs.closeSync(fd);
  }
}

function availablePort(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const boundPort = server.address().port;
      server.close(error => error ? reject(error) : resolve(boundPort));
    });
  });
}

function waitForBackend(child, logFile) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Backend startup timed out; see ' + logFile)), 60000);
    const onExit = (code, signal) => finish(new Error(`Backend exited (${code ?? signal}); see ${logFile}`));
    const onMessage = message => {
      if (message?.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
        finish(null, message.port);
      }
    };
    function finish(error, port) {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', finish);
      if (error) reject(error);
      else resolve(port);
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', finish);
  });
}

async function stopBackend(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill('SIGKILL'); });
    else child.kill('SIGKILL');
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function startRuntime({ resources, profile, logs, smoke, log, firstDatabasePort }) {
  const backend = path.join(resources, 'backend');
  const data = path.join(profile, 'postgres-data');
  const passwordFile = path.join(profile, 'postgres-password');
  const seed = path.join(profile, 'seed-complete');
  const pgLog = path.join(logs, 'postgres.log');
  const pgCtlLog = path.join(logs, 'postgres-control.log');
  const apiLog = path.join(logs, 'backend.log');
  const pgExe = name => path.join(resources, 'postgres', 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (/^(PG[A-Z_]+|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DATABASE_URL|PUBLIC_SHARE_TOKEN|ADMIN_SHARE_TOKEN|SAG_DESKTOP_ACCESS_TOKEN|HTTP_HOST|HTTP_PORT|AUTH_MODE|DEFAULT_TENANT_ID|DOTENV_CONFIG_.*)$/i.test(key)) delete base[key];
  }

  async function run(file, args, env = base, logFile = pgCtlLog) {
    const child = spawnLogged(file, args, backend, env, logFile);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    try {
      const [code, signal] = await once(child, 'exit');
      if (code !== 0) throw new Error(`${path.basename(file)} exited ${code ?? signal}; see ${logFile}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const pgCtl = (command, ...args) => run(pgExe('pg_ctl'), [command, '-D', data, ...args]);
  const pgStatus = () => {
    const result = spawnSync(pgExe('pg_ctl'), ['status', '-D', data], {
      env: base, cwd: backend, windowsHide: true, timeout: 10000
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 3) throw new Error('Unexpected pg_ctl status ' + result.status);
    return result.status === 0;
  };
  const stopDatabase = () => pgCtl('stop', '-m', 'fast', '-w', '-t', '45');

  let child, databaseStarted = false;
  const stop = async () => {
    try {
      await stopBackend(child);
    } finally {
      if (databaseStarted) {
        await stopDatabase();
        databaseStarted = false;
      }
    }
  };

  try {
    if (fs.existsSync(data) && !fs.existsSync(passwordFile)) throw new Error('Existing database password is missing');
    if (!fs.existsSync(passwordFile)) {
      fs.writeFileSync(passwordFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    }
    const password = fs.readFileSync(passwordFile, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(password)) throw new Error('Invalid database password');

    if (!fs.existsSync(data)) {
      const temp = fs.mkdtempSync(path.join(profile, 'pg-init-'));
      try {
        await run(pgExe('initdb'), [
          '-D', temp, '--username=sag_desktop', '--pwfile=' + passwordFile,
          '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale'
        ]);
        fs.renameSync(temp, data);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
    if (fs.readFileSync(path.join(data, 'PG_VERSION'), 'utf8').trim() !== '16') {
      throw new Error('SAG V1 requires a PostgreSQL 16 data directory');
    }
    if (pgStatus()) await stopDatabase();

    let pgPort;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      pgPort = attempt === 1 && firstDatabasePort ? firstDatabasePort : await availablePort();
      const options = `-h 127.0.0.1 -p ${pgPort}${process.platform === 'win32' ? '' : ' -k ""'}`;
      try {
        await pgCtl('start', '-l', pgLog, '-o', options, '-w', '-t', '45');
        databaseStarted = true;
        break;
      } catch (error) {
        databaseStarted = pgStatus();
        if (databaseStarted || attempt === 3) throw error;
        const portInUse = await availablePort(pgPort).then(() => false, error => error.code === 'EADDRINUSE');
        if (!portInUse) throw error;
        log(`PostgreSQL loopback port ${pgPort} was occupied; retrying with another port`);
      }
    }

    const token = randomBytes(32).toString('hex');
    const env = {
      ...base,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      DATABASE_URL: `postgres://sag_desktop:${password}@127.0.0.1:${pgPort}/postgres`,
      AUTH_MODE: 'none',
      DEFAULT_TENANT_ID: 'default',
      SAG_DESKTOP_ACCESS_TOKEN: token
    };
    if (smoke) Object.assign(env, { EMBEDDING_API_KEY: '', LLM_API_KEY: '', RERANK_API_KEY: '' });
    const runNode = script => run(process.execPath, [path.join(backend, script)], env, apiLog);
    await runNode('dist/src/db/migrate.js');
    if (!fs.existsSync(seed)) {
      await runNode('dist/src/db/seed.js');
      fs.writeFileSync(seed, 'ok\n', { mode: 0o600 });
    }
    child = spawnLogged(process.execPath, [path.join(backend, 'desktop-backend.mjs')], backend, env, apiLog, true);
    child.on('error', log);
    const port = await waitForBackend(child, apiLog);
    return { origin: `http://127.0.0.1:${port}`, token, stop };
  } catch (error) {
    await stop().catch(log);
    throw error;
  }
}

module.exports = { startRuntime };
