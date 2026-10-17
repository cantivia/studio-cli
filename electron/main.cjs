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
const { createUpdater } = require('./updater.cjs');

const PORT = Number(process.env.STUDIO_PORT || 4600);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP_DIR = app.getAppPath();

let server = null;
let win = null;
let quitting = false;
let blocker = null;
// STUDIO_HIDDEN=1 (used by automated tests): no window, no Dock icon, nothing appears on screen.
const HIDDEN = process.env.STUDIO_HIDDEN === '1';
// After an automatic update the app restarts with --start-hidden if its window was hidden, so it stays out of the way.
const START_HIDDEN = process.argv.includes('--start-hidden');

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

// The language Terminal.app would give a shell (e.g. en_IE). An app opened from the Dock inherits no LANG at all.
function systemLocale() {
  try {
    const l = require('node:child_process').execFileSync('defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8' }).trim();
    if (/^[a-z]{2,3}(_[A-Za-z0-9]+)?$/.test(l)) return l;
  } catch {}
  return app.getLocale().replace('-', '_');
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
      STUDIO_LOCALE: systemLocale(),
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
      fail('Studio stopped', `The Studio server stopped unexpectedly (code ${code}). Details are in ${path.join(dataDir, 'app-server.log')}.`);
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

// Stops the server and waits until it has let go of the port (an update does this before restarting the app).
function stopServer() {
  quitting = true;
  const s = server;
  if (!s) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => (s.kill('SIGKILL'), resolve()), 5000);
    s.once('exit', () => (clearTimeout(t), resolve()));
    s.kill();
  });
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
    show: !HIDDEN && !START_HIDDEN,
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

// Errors normally show a dialog; in hidden (test) mode nothing may appear on screen, so they go to the log instead.
const fail = (title, message) => {
  if (HIDDEN) console.error(`${title}: ${message}`);
  else dialog.showErrorBox(title, message);
};

// Test copies (they set STUDIO_DATA_DIR) get their own Electron profile, so they never share the installed app's
// single-instance lock, which would bring its window forward.
if (process.env.STUDIO_DATA_DIR) app.setPath('userData', path.join(process.env.STUDIO_DATA_DIR, 'electron'));

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
    const updater = createUpdater({ app, origin: ORIGIN, windowHidden: () => !win || !win.isVisible(), stopServer });
    // Right after an update the old server can take a moment to let go of the port.
    for (let i = updater.justUpdated() ? 60 : 0; i > 0 && (await portInUse()); i--) await new Promise((r) => setTimeout(r, 250));
    if (await portInUse()) {
      fail('Studio is already running', `Something is already serving Studio on port ${PORT} on this computer, so this app can't start another. Quit the other one first.`);
      return app.quit();
    }
    startServer();
    if (!(await waitForServer())) {
      fail('Studio didn’t start', 'The Studio server didn’t come up in time. Try opening the app again.');
      return app.quit();
    }
    createWindow();
    updater.start();
    setInterval(watchPower, 15000);
    watchPower();
    if (process.env.STUDIO_NO_LOGIN_PROMPT !== '1') setTimeout(askAboutLogin, 4000);
  });
}
