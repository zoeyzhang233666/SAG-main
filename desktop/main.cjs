const { app, BrowserWindow, dialog, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startRuntime } = require('./runtime.cjs');
const { productName } = require('./package.json');

const scheme = 'sag-v1';
const home = `${scheme}://app/`;
protocol.registerSchemesAsPrivileged([
  { scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const smokeMode = process.env.SAG_V1_SMOKE_DATA &&
  process.argv.find(arg => /^--desktop-smoke=(write|read|upgrade)$/.test(arg))?.split('=')[1];
app.setName(productName);
const profile = smokeMode
  ? path.resolve(process.env.SAG_V1_SMOKE_DATA)
  : path.join(app.getPath('appData'), app.isPackaged ? 'SAG-V1' : 'SAG-V1-Development');
const logs = path.join(profile, 'logs');
fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build', 'resources');

let window, runtime, startup, shutdown, exiting = false;

function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === scheme + ':' && url.host === 'app' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function rendererSession() {
  const isolatedSession = session.fromPartition('persist:sag-v1');
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.protocol.handle(scheme, async request => {
    if (!isAppUrl(request.url)) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const header of ['connection', 'content-length', 'host', 'transfer-encoding']) {
      headers.delete(header);
    }
    headers.set('X-SAG-Desktop-Token', runtime.token);
    const options = { method: request.method, headers, signal: request.signal, redirect: 'manual' };
    if (request.body) Object.assign(options, { body: request.body, duplex: 'half' });
    try {
      return await fetch(runtime.origin + url.pathname + url.search, options);
    } catch (error) {
      if (!request.signal.aborted) log(error);
      return new Response(`${productName} 本地服务暂不可用`, { status: 502 });
    }
  });
  return isolatedSession;
}

async function openWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: productName,
    icon: path.join(resources, 'backend', 'web', 'dist', 'app-icon.png'),
    minWidth: 800,
    minHeight: 600,
    show: !smokeMode,
    webPreferences: {
      session: rendererSession(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  });
  const blockExternal = (event, details) => {
    const url = typeof details === 'string' ? details : details?.url ?? event.url;
    if (!isAppUrl(url)) event.preventDefault();
  };
  window.webContents.on('will-navigate', blockExternal);
  window.webContents.on('will-frame-navigate', blockExternal);
  window.webContents.on('will-redirect', blockExternal);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(log);
    return { action: 'deny' };
  });
  window.on('closed', () => { window = undefined; });
  await window.loadURL(home);
}

function log(error) {
  fs.appendFileSync(path.join(logs, 'desktop.log'), `${new Date().toISOString()} ${error?.stack || error}\n`);
}

function exit(code) {
  shutdown ??= (async () => {
    try {
      await startup?.catch(() => {});
      await runtime?.stop();
    } catch (error) {
      log(error);
      code = 1;
    }
    exiting = true;
    app.exit(code);
  })();
  return shutdown;
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (exiting) return;
    event.preventDefault();
    void exit(0);
  });
  startup = app.whenReady().then(async () => {
    const smokePort = smokeMode ? Number(process.env.SAG_V1_SMOKE_PG_PORT) : NaN;
    const firstDatabasePort = Number.isInteger(smokePort) && smokePort > 0 && smokePort <= 65535 ? smokePort : undefined;
    runtime = await startRuntime({ resources, profile, logs, smoke: Boolean(smokeMode), log, firstDatabasePort });
    if (shutdown) return;
    await openWindow();
    if (smokeMode) {
      const { smoke } = require('./smoke.cjs');
      await smoke(window.webContents, runtime.origin, profile, smokeMode);
    }
  });
  startup.then(
    () => { if (smokeMode) void exit(0); },
    error => {
      log(error);
      if (!smokeMode && !shutdown) dialog.showErrorBox(`${productName}启动失败`, `${error.message}\n日志：${logs}`);
      void exit(1);
    }
  );
}
