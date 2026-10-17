const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./update-core.cjs');

test('compareVersions orders x.y.z numerically', () => {
  assert.equal(core.compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(core.compareVersions('0.1.3', '0.1.3'), 0);
  assert.equal(core.compareVersions('0.2.0', '1.0.0'), -1);
});

test('isVersion accepts only plain x.y.z', () => {
  assert.ok(core.isVersion('0.1.4'));
  for (const v of ['0.1', '0.1.4-beta', '', 'v0.1.4', undefined]) assert.ok(!core.isVersion(v), String(v));
});

test('a stamp verifies only for the same version, chip and file', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = core.publicKeyOf(privateKey);
  const sha = 'a'.repeat(64);
  const stamp = core.signStamp(privateKey, '0.1.5', 'arm64', sha);
  assert.ok(core.verifyStamp('0.1.5', 'arm64', sha, stamp, pub));
  assert.ok(!core.verifyStamp('0.1.6', 'arm64', sha, stamp, pub));
  assert.ok(!core.verifyStamp('0.1.5', 'x64', sha, stamp, pub));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', 'b'.repeat(64), stamp, pub));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', sha, 'not a stamp', pub));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', sha, undefined, pub));
});

test('a stamp from another key is refused', () => {
  const a = crypto.generateKeyPairSync('ed25519');
  const b = crypto.generateKeyPairSync('ed25519');
  const stamp = core.signStamp(a.privateKey, '0.1.5', 'arm64', 'c'.repeat(64));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', 'c'.repeat(64), stamp, core.publicKeyOf(b.privateKey)));
});

test('the built-in public key is an Ed25519 key', () => {
  const key = crypto.createPublicKey({ key: Buffer.from(core.PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
});

test('sha256File hashes the whole file', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')), 'x');
  fs.writeFileSync(f, 'hello');
  assert.equal(await core.sha256File(f), crypto.createHash('sha256').update('hello').digest('hex'));
});

test('updatableLocation refuses disk images, translocated copies and read-only folders', () => {
  const yes = () => true;
  assert.ok(core.updatableLocation('/Applications/Studio CLI.app', yes));
  assert.ok(!core.updatableLocation('/Volumes/Studio CLI/Studio CLI.app', yes));
  assert.ok(!core.updatableLocation('/private/var/folders/x/AppTranslocation/ABC/d/Studio CLI.app', yes));
  assert.ok(!core.updatableLocation('/Applications/Studio CLI.app', () => false));
  assert.ok(!core.updatableLocation('/usr/local/bin/node', yes));
});

test('isQuiet needs both a quiet Claude and quiet hands', () => {
  const q = { busy: 100, input: 200 };
  assert.ok(core.isQuiet({ sinceBusy: 100, sinceInput: 200 }, q));
  assert.ok(!core.isQuiet({ sinceBusy: 99, sinceInput: 999 }, q));
  assert.ok(!core.isQuiet({ sinceBusy: 999, sinceInput: 199 }, q));
});
