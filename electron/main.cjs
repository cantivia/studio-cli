/**
 * Studio CLI for Mac: a normal app around the same Studio server.
 *
 * It starts the bundled server (on Electron's own Node, so nothing needs installing), shows Studio in a
 * window, keeps the Cloudflare tunnel running for phone access, and keeps the Mac awake while remote
 * access is on. Closing the window hides it; Studio keeps running until you quit (⌘Q).
 */
const { app, BrowserWindow, Menu, dialog, powerSaveBlocker, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.STUDIO_PORT || 4600);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP_DIR = app.getAppPath();

let server = null;
let win = null;
let quitting = false;
let blocker = null;
// STUDIO_HIDDEN=1 (used by automated tests): no window, no Dock icon, nothing appears on screen.
const HIDDEN = process.env.STUDIO_HIDDEN === '1';

const get = (route) =>
  new Promise((resolve) => {
    const req = http.get(ORIGIN + route, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => (req.destroy(), resolve(null)));
  });

async function portInUse() {
  return !!(await get('/api/state'));
}

function startServer() {
  const cloudflared = path.join(process.resourcesPath || '', 'cloudflared');
  server = spawn(process.execPath, [path.join(APP_DIR, 'server.mjs')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // run the server on Electron's built-in Node
      NODE_ENV: 'production',
      PORT: String(PORT),
      STUDIO_BUNDLED: '1',
      STUDIO_ROOT: APP_DIR,
      STUDIO_MANAGE_TUNNEL: '1',
      ...(fs.existsSync(cloudflared) ? { STUDIO_CLOUDFLARED: cloudflared } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dataDir = process.env.STUDIO_DATA_DIR || path.join(require('node:os').homedir(), '.studio-cli');
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.createWriteStream(path.join(dataDir, 'app-server.log'), { flags: 'a' });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on('exit', (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox('Studio stopped', `The Studio server stopped unexpectedly (code ${code}). Details are in ${path.join(dataDir, 'app-server.log')}.`);
      app.quit();
    }
  });
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    if (await portInUse()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'Studio CLI',
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 14 },
    show: !HIDDEN,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: !HIDDEN },
  });
  // Pages opened from Studio: share links (they hand a conversation back to this window) open here;
  // any other web address opens in your normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (u.origin === ORIGIN || /^\/share\/[\w-]+\/?$/.test(u.pathname)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.loadURL(ORIGIN);
}

function show() {
  if (HIDDEN) return;
  if (!win) createWindow();
  else win.show();
}

function buildMenu() {
  const loginOn = () => app.getLoginItemSettings().openAtLogin;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Studio CLI',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Open at login',
            type: 'checkbox',
            checked: loginOn(),
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

// Remote access needs this computer awake: hold off idle sleep while it's connected.
async function watchPower() {
  const r = await get('/api/remote');
  let configured = false;
  try {
    configured = !!JSON.parse(r?.body || '{}').configured;
  } catch {}
  if (configured && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!configured && blocker !== null) (powerSaveBlocker.stop(blocker), (blocker = null));
}

async function askAboutLogin() {
  const flag = path.join(app.getPath('userData'), 'asked-login');
  if (fs.existsSync(flag)) return;
  fs.mkdirSync(path.dirname(flag), { recursive: true });
  fs.writeFileSync(flag, '1');
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Yes, open at login', 'No thanks'],
    defaultId: 0,
    message: 'Keep Studio running?',
    detail: 'If you open Studio at login, your phone or iPad can always reach this computer. You can change this later in the Studio CLI menu.',
  });
  if (response === 0) app.setLoginItemSettings({ openAtLogin: true });
  buildMenu();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    if (HIDDEN) app.dock?.hide();
    buildMenu();
    if (await portInUse()) {
      dialog.showErrorBox('Studio is already running', `Something is already serving Studio on port ${PORT} on this computer, so this app can't start another. Quit the other one first.`);
      return app.quit();
    }
    startServer();
    if (!(await waitForServer())) {
      dialog.showErrorBox('Studio didn’t start', 'The Studio server didn’t come up in time. Try opening the app again.');
      return app.quit();
    }
    createWindow();
    setInterval(watchPower, 15000);
    watchPower();
    if (process.env.STUDIO_NO_LOGIN_PROMPT !== '1') setTimeout(askAboutLogin, 4000);
  });
}
