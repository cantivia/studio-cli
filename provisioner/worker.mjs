/**
 * Studio connection service: gives each Studio install its own private address (studio-<words>.<domain>) and
 * the Cloudflare Tunnel behind it, so a phone can reach that person's computer. Runs as a Cloudflare Worker on the
 * account that owns the domain. See provisioner/README.md.
 *
 * It only creates the tunnel and the DNS record. It never sees terminals or traffic, which flow from the phone
 * through Cloudflare to the person's own computer, where a paired-device cookie is required (server/devices.ts).
 * An install proves itself with a random 256-bit install id (only its hash is stored here), so only that computer
 * can fetch its tunnel token again or give the address back.
 *
 * Bindings: KV `REG`; secrets/vars: CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, DOMAIN; optional MAX_PER_DAY (300),
 * PER_IP_PER_DAY (3), LOCAL_PORT (4600), STALE_DAYS (180).
 */
const API = 'https://api.cloudflare.com/client/v4';
const ADJ = ['brave', 'calm', 'clever', 'cosy', 'eager', 'gentle', 'happy', 'jolly', 'keen', 'lucky', 'merry', 'noble', 'quick', 'sunny', 'swift', 'witty'];
const NOUN = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'meadow', 'lantern', 'pebble', 'river', 'willow', 'ember', 'fjord', 'grove', 'orbit', 'quartz', 'summit'];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
const digits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');

class CfError extends Error {}
async function cf(env, method, route, body) {
  const r = await fetch(API + route, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!j?.success) throw new CfError(j?.errors?.map((e) => e.message).join('; ') || `Cloudflare ${r.status}`);
  return j.result;
}

async function deleteInstall(env, rec) {
  const acct = `/accounts/${env.CF_ACCOUNT_ID}`;
  if (rec.dnsId) await cf(env, 'DELETE', `/zones/${env.CF_ZONE_ID}/dns_records/${rec.dnsId}`).catch(() => {});
  if (rec.tunnelId) {
    await cf(env, 'DELETE', `${acct}/cfd_tunnel/${rec.tunnelId}/connections`).catch(() => {});
    await cf(env, 'DELETE', `${acct}/cfd_tunnel/${rec.tunnelId}`).catch(() => {});
  }
  await env.REG.delete(`host:${rec.host}`);
}

async function create(env, request) {
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const perIp = Number(env.PER_IP_PER_DAY || 3);
  const perDay = Number(env.MAX_PER_DAY || 300);
  const ipKey = `ip:${ip}:${day}`;
  const dayKey = `day:${day}`;
  const [ipCount, dayCount] = await Promise.all([env.REG.get(ipKey), env.REG.get(dayKey)]).then((a) => a.map(Number));
  if (ipCount >= perIp) return json({ error: 'Too many new setups from this network today. Try again tomorrow.' }, 429);
  if (dayCount >= perDay) return json({ error: 'Studio’s connection service is busy right now. Please try again in a few hours.' }, 503);

  let host = '';
  for (let i = 0; i < 6 && !host; i++) {
    const h = `studio-${pick(ADJ)}-${pick(NOUN)}-${digits()}.${env.DOMAIN}`;
    if (!(await env.REG.get(`host:${h}`))) host = h;
  }
  if (!host) return json({ error: 'Couldn’t pick an address. Try again.' }, 503);
  const name = host.split('.')[0];
  const acct = `/accounts/${env.CF_ACCOUNT_ID}`;
  const rec = { host, tunnelId: '', dnsId: '', createdAt: Date.now(), lastSeen: Date.now() };
  try {
    const tunnel = await cf(env, 'POST', `${acct}/cfd_tunnel`, { name, config_src: 'cloudflare' });
    rec.tunnelId = tunnel.id;
    await cf(env, 'PUT', `${acct}/cfd_tunnel/${tunnel.id}/configurations`, {
      config: { ingress: [{ hostname: host, service: `http://127.0.0.1:${env.LOCAL_PORT || 4600}` }, { service: 'http_status:404' }] },
    });
    const dns = await cf(env, 'POST', `/zones/${env.CF_ZONE_ID}/dns_records`, { type: 'CNAME', name: host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true });
    rec.dnsId = dns.id;
    const tunnelToken = await cf(env, 'GET', `${acct}/cfd_tunnel/${tunnel.id}/token`);
    await env.REG.put(`host:${host}`, '1');
    await Promise.all([
      env.REG.put(ipKey, String(ipCount + 1), { expirationTtl: 172800 }),
      env.REG.put(dayKey, String(dayCount + 1), { expirationTtl: 172800 }),
    ]);
    return { rec, tunnelToken };
  } catch (e) {
    await deleteInstall(env, rec); // don't leave half-made tunnels behind
    return json({ error: 'Couldn’t set up your address just now. Please try again in a minute.' }, 502);
  }
}

async function register(env, request, installId) {
  const key = `inst:${await sha256(installId)}`;
  let rec = await env.REG.get(key, 'json');
  let tunnelToken;
  if (rec) {
    // Same computer again: same address, fresh copy of the token. If the tunnel was removed meanwhile, start over.
    try {
      tunnelToken = await cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${rec.tunnelId}/token`);
    } catch {
      await deleteInstall(env, rec);
      rec = null;
    }
  }
  if (!rec) {
    const made = await create(env, request);
    if (made instanceof Response) return made;
    ({ rec, tunnelToken } = made);
  }
  rec.lastSeen = Date.now();
  await env.REG.put(key, JSON.stringify(rec));
  return json({ host: rec.host, tunnelToken });
}

async function release(env, installId) {
  const key = `inst:${await sha256(installId)}`;
  const rec = await env.REG.get(key, 'json');
  if (rec) {
    await deleteInstall(env, rec);
    await env.REG.delete(key);
  }
  return json({ ok: true });
}

/** Daily: remove addresses nobody has used for a long time, so abandoned installs don't pile up. */
async function cleanup(env) {
  const stale = Date.now() - Number(env.STALE_DAYS || 180) * 86_400_000;
  let cursor;
  do {
    const page = await env.REG.list({ prefix: 'inst:', cursor });
    for (const { name } of page.keys) {
      const rec = await env.REG.get(name, 'json');
      if (!rec || rec.lastSeen > stale) continue;
      const t = await cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${rec.tunnelId}`).catch(() => null);
      if (t && t.status === 'healthy') continue; // still connected: keep
      await deleteInstall(env, rec);
      await env.REG.delete(name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/v1/health') return json({ ok: true });
  if (request.method !== 'POST' || !['/v1/register', '/v1/release'].includes(url.pathname)) return json({ error: 'Not found' }, 404);
  const body = await request.json().catch(() => null);
  const id = body?.installId;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return json({ error: 'Bad request' }, 400);
  return url.pathname === '/v1/register' ? register(env, request, id) : release(env, id);
}

export default {
  fetch: (request, env) => handle(request, env).catch(() => json({ error: 'Something went wrong. Try again in a minute.' }, 500)),
  scheduled: (_event, env, ctx) => ctx.waitUntil(cleanup(env)),
};
export { cleanup };
