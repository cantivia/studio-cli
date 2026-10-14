// Run: node provisioner/worker.test.mjs — exercises the Worker against a pretend Cloudflare and an in-memory KV.
import worker, { cleanup } from './worker.mjs';

const kv = new Map();
const REG = {
  get: async (k, type) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  put: async (k, v) => void kv.set(k, String(v)),
  delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
const cfState = { tunnels: new Map(), dns: new Map(), calls: [], failDns: false, status: 'healthy' };
let n = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const p = u.pathname.replace('/client/v4', ''); const m = init.method || 'GET';
  cfState.calls.push(`${m} ${p}`);
  const ok = (result) => new Response(JSON.stringify({ success: true, result }));
  const no = (msg) => new Response(JSON.stringify({ success: false, errors: [{ message: msg }] }), { status: 400 });
  if (init.headers.authorization !== 'Bearer tok') return no('Authentication error');
  let r;
  if (m === 'POST' && p === '/accounts/A/cfd_tunnel') { const t = { id: `tun-${++n}`, name: JSON.parse(init.body).name }; cfState.tunnels.set(t.id, t); return ok(t); }
  if ((r = p.match(/^\/accounts\/A\/cfd_tunnel\/([\w-]+)\/configurations$/))) { cfState.tunnels.get(r[1]).config = JSON.parse(init.body).config; return ok({}); }
  if ((r = p.match(/^\/accounts\/A\/cfd_tunnel\/([\w-]+)\/token$/))) return cfState.tunnels.has(r[1]) ? ok('TOKEN-' + r[1] + '-' + 'x'.repeat(60)) : no('tunnel not found');
  if ((r = p.match(/^\/accounts\/A\/cfd_tunnel\/([\w-]+)\/connections$/))) return ok({});
  if ((r = p.match(/^\/accounts\/A\/cfd_tunnel\/([\w-]+)$/))) { if (m === 'DELETE') { cfState.tunnels.delete(r[1]); return ok({}); } return ok({ status: cfState.status }); }
  if (m === 'POST' && p === '/zones/Z/dns_records') { if (cfState.failDns) return no('dns boom'); const d = { id: `dns-${++n}`, ...JSON.parse(init.body) }; cfState.dns.set(d.id, d); return ok(d); }
  if ((r = p.match(/^\/zones\/Z\/dns_records\/([\w-]+)$/)) && m === 'DELETE') { cfState.dns.delete(r[1]); return ok({}); }
  return no('no route ' + m + ' ' + p);
};

const env = { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'A', CF_ZONE_ID: 'Z', DOMAIN: 'cantivia.com', REG, PER_IP_PER_DAY: '3', MAX_PER_DAY: '5' };
const call = async (path, body, ip = '1.1.1.1', e = env) => {
  const res = await worker.fetch(new Request('https://x' + path, { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), e);
  return { s: res.status, j: await res.json() };
};
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '  ok  ' : ' FAIL ', m); };
const id = (c) => c.repeat(64);

let r = await call('/v1/register', { installId: id('a') });
ok(r.s === 200 && /^studio-[a-z]+-[a-z]+-\d{4}\.cantivia\.com$/.test(r.j.host), 'new install gets its own address: ' + r.j.host);
ok(r.j.tunnelToken.startsWith('TOKEN-') && r.j.tunnelToken.length > 60, 'and a tunnel token');
const tun = [...cfState.tunnels.values()][0];
ok(tun.config.ingress[0].hostname === r.j.host && tun.config.ingress[0].service === 'http://127.0.0.1:4600', 'tunnel points the address at port 4600 on their computer');
const dns = [...cfState.dns.values()][0];
ok(dns.type === 'CNAME' && dns.proxied && dns.name === r.j.host, 'proxied DNS record created');
ok(![...kv.keys()].some((k) => k.includes(id('a'))), 'the install id itself is never stored (only a hash)');
const first = r.j;
r = await call('/v1/register', { installId: id('a') });
ok(r.j.host === first.host && cfState.tunnels.size === 1 && cfState.dns.size === 1, 'same computer again → same address, nothing duplicated');
r = await call('/v1/register', { installId: id('b') });
ok(r.s === 200 && r.j.host !== first.host && cfState.tunnels.size === 2, 'a different computer gets a different address');

console.log('abuse limits');
r = await call('/v1/register', { installId: id('c') }); ok(r.s === 200, 'third from one network works');
r = await call('/v1/register', { installId: id('d') }); ok(r.s === 429 && /tomorrow/.test(r.j.error), 'fourth new setup from the same network is refused');
r = await call('/v1/register', { installId: id('a') }); ok(r.s === 200, '…but an existing install can still re-fetch its token');
await call('/v1/register', { installId: id('e') }, '2.2.2.2'); await call('/v1/register', { installId: id('f') }, '3.3.3.3');
r = await call('/v1/register', { installId: id('1') }, '4.4.4.4'); ok(r.s === 503, 'a daily cap across everyone stops runaway sign-ups');

console.log('bad requests');
ok((await call('/v1/register', { installId: 'short' })).s === 400, 'bad install id rejected');
ok((await call('/v1/register', {})).s === 400, 'missing install id rejected');
ok((await worker.fetch(new Request('https://x/v1/register'), env)).status === 404, 'GET not allowed');
ok((await worker.fetch(new Request('https://x/v1/health'), env)).status === 200, 'health check works');
ok((await call('/v1/register', { installId: id('4') }, '8.8.8.8', { ...env, CF_API_TOKEN: 'wrong', MAX_PER_DAY: '999' })).s === 502, 'a broken Cloudflare token is a clean 502, not a crash');

console.log('failure cleanup');
const before = cfState.tunnels.size;
cfState.failDns = true;
r = await call('/v1/register', { installId: id('2') }, '9.9.9.9', { ...env, MAX_PER_DAY: '999' });
ok(r.s === 502 && cfState.tunnels.size === before && !JSON.stringify(r.j).includes('boom'), 'if DNS fails, the half-made tunnel is removed and no internal details leak');
cfState.failDns = false;

console.log('giving an address back');
const hostsBefore = cfState.dns.size;
r = await call('/v1/release', { installId: id('b') });
ok(r.j.ok && cfState.dns.size === hostsBefore - 1, 'release removes DNS and tunnel');
r = await call('/v1/register', { installId: id('b') }, '5.5.5.5', { ...env, MAX_PER_DAY: '999' });
ok(r.s === 200, 'a released install can register again');
ok((await call('/v1/release', { installId: id('3') })).j.ok, 'releasing something unknown is harmless');

console.log('daily cleanup');
for (const k of kv.keys()) if (k.startsWith('inst:')) { const v = JSON.parse(kv.get(k)); v.lastSeen = Date.now() - 400 * 86_400_000; kv.set(k, JSON.stringify(v)); }
cfState.status = 'healthy';
const tBefore = cfState.tunnels.size;
await cleanup(env);
ok(cfState.tunnels.size === tBefore, 'old but still-connected installs are kept');
cfState.status = 'inactive';
await cleanup(env);
ok(cfState.tunnels.size === 0 && ![...kv.keys()].some((k) => k.startsWith('inst:')), 'old and unused installs are removed');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
