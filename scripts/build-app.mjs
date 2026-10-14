#!/usr/bin/env node
/**
 * Builds the Mac app and its installers: `npm run app` (DMGs in release/out) or `npm run app -- --dir`
 * (just the .app, faster, for testing). `--arch arm64` or `--arch x64` builds one chip.
 *
 * What goes in the app: the built web app, the server and pty host bundled into two files, node-pty
 * (the one native piece), and the cloudflared program for the phone tunnel. Electron supplies Node.
 *
 * Signing: with an Apple Developer ID the app signs and notarizes itself (set CSC_LINK / CSC_KEY_PASSWORD or have the
 * certificate in your keychain, plus APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID). Without one it is only
 * ad-hoc signed, and people must approve it once in System Settings → Privacy & Security.
 */
import { build as esbuild } from 'esbuild';
import { build as packager, Platform } from 'electron-builder';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REL = path.join(ROOT, 'release');
const STAGE = path.join(REL, 'stage');
const CACHE = path.join(REL, 'cache');
const args = process.argv.slice(2);
const DIR_ONLY = args.includes('--dir');
const archArg = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : null;
const ARCHS = archArg ? [archArg] : DIR_ONLY ? [process.arch === 'arm64' ? 'arm64' : 'x64'] : ['arm64', 'x64'];
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit', ...opts });
const log = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

log('1/5 Building the web app');
run('npx', ['vite', 'build']);

log('2/5 Bundling the server');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
const banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
for (const [entry, out] of [['server/index.ts', 'server.mjs'], ['server/pty-host.ts', 'pty-host.mjs']]) {
  await esbuild({
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(STAGE, out),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node-pty', 'bufferutil', 'utf-8-validate'],
    banner: { js: banner },
    logLevel: 'warning',
  });
}
fs.cpSync(path.join(ROOT, 'dist'), path.join(STAGE, 'dist'), { recursive: true });
fs.mkdirSync(path.join(STAGE, 'electron'));
fs.copyFileSync(path.join(ROOT, 'electron/main.cjs'), path.join(STAGE, 'electron/main.cjs'));
const layout = 'vendor/pixel-agents/webview-ui/public/assets/default-layout-1.json';
fs.mkdirSync(path.dirname(path.join(STAGE, layout)), { recursive: true });
fs.copyFileSync(path.join(ROOT, layout), path.join(STAGE, layout));
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify(
    { name: 'studio-cli', productName: 'Studio CLI', version: pkg.version, description: 'Terminals and Claude sessions in one place', author: 'Cantivia', main: 'electron/main.cjs', dependencies: { 'node-pty': pkg.dependencies['node-pty'] } },
    null,
    2,
  ),
);

log('3/5 Installing node-pty into the app');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: STAGE });
// Only macOS builds ship: drop the Windows binaries node-pty carries.
for (const w of ['win32-arm64', 'win32-x64']) fs.rmSync(path.join(STAGE, 'node_modules/node-pty/prebuilds', w), { recursive: true, force: true });
for (const a of ['arm64', 'x64']) {
  const helper = path.join(STAGE, `node_modules/node-pty/prebuilds/darwin-${a}/spawn-helper`);
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
// The guest page of a share link serves xterm from the app itself.
const xt = path.join(STAGE, 'node_modules/@xterm/xterm');
fs.mkdirSync(path.join(xt, 'lib'), { recursive: true });
fs.mkdirSync(path.join(xt, 'css'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'node_modules/@xterm/xterm/lib/xterm.js'), path.join(xt, 'lib/xterm.js'));
fs.copyFileSync(path.join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css'), path.join(xt, 'css/xterm.css'));

log('4/5 Getting cloudflared (the phone tunnel)');
fs.mkdirSync(CACHE, { recursive: true });
for (const a of ARCHS) {
  const out = path.join(CACHE, `cloudflared-${a}`);
  if (fs.existsSync(out)) continue;
  const name = a === 'arm64' ? 'arm64' : 'amd64';
  const tgz = path.join(CACHE, `cloudflared-${name}.tgz`);
  const r = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${name}.tgz`, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Couldn't download cloudflared for ${a} (${r.status})`);
  fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
  run('tar', ['-xzf', tgz, '-C', CACHE]);
  fs.renameSync(path.join(CACHE, 'cloudflared'), out);
  fs.chmodSync(out, 0o755);
  fs.rmSync(tgz);
}

log(`5/5 Packaging the app (${ARCHS.join(', ')})`);
const notarize = !!process.env.APPLE_TEAM_ID;
await packager({
  targets: Platform.MAC.createTarget(),
  config: {
    appId: 'com.cantivia.studio-cli',
    productName: 'Studio CLI',
    directories: { app: STAGE, output: path.join(REL, 'out') },
    asar: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    artifactName: '${productName}-${version}-${arch}.${ext}',
    extraResources: [{ from: path.join(CACHE, 'cloudflared-${arch}'), to: 'cloudflared' }],
    mac: {
      category: 'public.app-category.developer-tools',
      icon: path.join(ROOT, 'build/icon.icns'),
      target: [{ target: DIR_ONLY ? 'dir' : 'dmg', arch: ARCHS }],
      hardenedRuntime: !!process.env.CSC_LINK || notarize,
      notarize,
      extendInfo: { LSUIElement: false },
    },
    dmg: { title: 'Studio CLI', contents: [{ x: 130, y: 190 }, { x: 410, y: 190, type: 'link', path: '/Applications' }] },
    afterPack: async (ctx) => {
      // Without a Developer ID, apple-silicon Macs still refuse unsigned apps: sign ad-hoc so the app at least launches.
      if (process.env.CSC_LINK) return;
      const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
      execFileSync('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'inherit' });
    },
  },
});
console.log(`\n\x1b[32mDone.\x1b[0m ${path.join(REL, 'out')}`);
