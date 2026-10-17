/**
 * The parts of automatic updates that don't need Electron, shared by electron/updater.cjs (which checks release
 * stamps) and scripts/release.mjs (which makes them). The Mac app isn't signed with an Apple Developer ID, so
 * macOS's own updater won't take it. Instead every release file is stamped with Studio's Ed25519 key, and the app
 * installs only files with a valid stamp: whoever controls the website or GitHub still can't push code to it.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Public half of the release key (Ed25519, SPKI DER, base64), printed by `npm run release:key`. */
const PUBLIC_KEY = 'MCowBQYDK2VwAyEA3e0THRqOCWwo6ZuILS8IL8wk5U3MmvGFLB+MOW6Jd8Y=';

const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(String(v));

/** 1 if a is newer than b, -1 if older, 0 if the same. Plain x.y.z versions only (check with isVersion). */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/** What a stamp signs. Naming the version and chip stops an older or wrong file being passed off as this one. */
const stampMessage = (version, arch, sha256) => Buffer.from(`studio-cli-update\n${version}\n${arch}\n${sha256}`);

const signStamp = (privateKey, version, arch, sha256) => crypto.sign(null, stampMessage(version, arch, sha256), privateKey).toString('base64');

function verifyStamp(version, arch, sha256, stamp, publicKey = PUBLIC_KEY) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, stampMessage(version, arch, sha256), key, Buffer.from(String(stamp), 'base64'));
  } catch {
    return false;
  }
}

/** The public half of a private key, in the form PUBLIC_KEY uses. */
const publicKeyOf = (privateKey) => crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

const canWrite = (p) => {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether the app at bundlePath can replace itself. A copy run straight from the disk image, or from Downloads
 *  (macOS then runs it from a hidden read-only copy), has to be moved to Applications first. */
function updatableLocation(bundlePath, writable = canWrite) {
  if (!bundlePath.endsWith('.app') || bundlePath.includes('/AppTranslocation/') || bundlePath.startsWith('/Volumes/')) return false;
  return writable(path.dirname(bundlePath)) && writable(bundlePath);
}

/** Restart only when nobody will notice: no Claude busy for 2 minutes and nobody typing for 5. */
const QUIET = { busy: 2 * 60_000, input: 5 * 60_000 };
const isQuiet = ({ sinceBusy, sinceInput }, quiet = QUIET) => sinceBusy >= quiet.busy && sinceInput >= quiet.input;

module.exports = { PUBLIC_KEY, isVersion, compareVersions, stampMessage, signStamp, verifyStamp, publicKeyOf, sha256File, updatableLocation, QUIET, isQuiet };
