/**
 * The Cloudflare steps shared by `npm run setup` (your own computer) and `npm run invite` (a teammate's).
 * Everything is idempotent: running it again reuses the tunnel, DNS record and Access apps it made before.
 */
export function createCloudflare({ token, api, dry = false, die, say = () => {} }) {
  async function cf(method, route, body) {
    if (dry && method !== 'GET') {
      say(`[dry run] ${method} ${route}${body ? ' ' + JSON.stringify(body).slice(0, 140) : ''}`);
      return { id: 'dry-run-id', aud: 'dry-run-aud', token: 'dry-run-token' };
    }
    let r;
    try {
      r = await fetch(api + route, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      die(`Couldn't reach Cloudflare (${e.message}). Check your internet connection.`);
    }
    const j = await r.json().catch(() => null);
    if (!j?.success) {
      const m = j?.errors?.map((e) => e.message).join('; ') || `${r.status} ${r.statusText}`;
      const hint = /auth|permission|forbidden|unauthori/i.test(m) ? '\n    The token is missing a permission. Re-create it using the list shown above.' : '';
      die(`Cloudflare said no: ${m} (${method} ${route})${hint}`);
    }
    return j.result;
  }

  // What Cloudflare returns for an app includes read-only fields it won't accept back on an update.
  const writable = ({ id, uid, aud, created_at, updated_at, ...rest }) => rest;
  const policyFor = (include, label) => [{ name: label, decision: 'allow', include, precedence: 1 }];

  async function pickAccount(choose) {
    const accounts = await cf('GET', '/accounts?per_page=50');
    if (!accounts.length) die('That token can’t see any Cloudflare account.');
    return accounts.length > 1 ? await choose(accounts) : accounts[0];
  }

  /** The Zero Trust "team" domain, e.g. your-team.cloudflareaccess.com. */
  async function teamDomain(A) {
    const org = await cf('GET', `${A}/access/organizations`).catch(() => null);
    return org?.auth_domain || null;
  }

  /** Finds or creates an Access app by its exact domain, always (re)setting who may enter. */
  async function ensureApp(A, { name, domain, include, label }) {
    const apps = (await cf('GET', `${A}/access/apps?per_page=100`)) || [];
    const hit = apps.find((a) => a.domain === domain);
    const body = { name, domain, type: 'self_hosted', session_duration: '168h', policies: policyFor(include, label) };
    if (hit) return { ...(await cf('PUT', `${A}/access/apps/${hit.id}`, { ...writable(hit), ...body })), aud: hit.aud, reused: true };
    return cf('POST', `${A}/access/apps`, body);
  }

  /** The part of an address Cloudflare manages (company.com for studio-you.company.com). */
  async function findZone(account, host) {
    for (let parts = host.split('.'); parts.length >= 2; parts = parts.slice(1)) {
      const z = (await cf('GET', `/zones?name=${parts.join('.')}&account.id=${account.id}`))?.[0];
      if (z) return z;
    }
    return null;
  }

  /** A tunnel from the internet to port `port` on the computer running it, behind `host`. Returns the token that runs it. */
  async function provisionTunnel(A, { name, host, zone, port }) {
    const tunnels = (await cf('GET', `${A}/cfd_tunnel?name=${name}&is_deleted=false`)) || [];
    const tunnel = tunnels[0] || (await cf('POST', `${A}/cfd_tunnel`, { name, config_src: 'cloudflare' }));
    await cf('PUT', `${A}/cfd_tunnel/${tunnel.id}/configurations`, {
      config: { ingress: [{ hostname: host, service: `http://127.0.0.1:${port}` }, { service: 'http_status:404' }] },
    });
    const tunnelToken = await cf('GET', `${A}/cfd_tunnel/${tunnel.id}/token`);
    const dns = (await cf('GET', `/zones/${zone.id}/dns_records?name=${host}`)) || [];
    const record = { type: 'CNAME', name: host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true };
    if (dns[0]) await cf('PUT', `/zones/${zone.id}/dns_records/${dns[0].id}`, record);
    else await cf('POST', `/zones/${zone.id}/dns_records`, record);
    return tunnelToken;
  }

  /** Both Access apps for one person's address: the whole site for them alone, and /share/* for their company. */
  async function provisionAccess(A, { name, host, email, mailDomain }) {
    const main = await ensureApp(A, { name: `Studio CLI (${name})`, domain: host, include: [{ email: { email } }], label: `Only ${email}` });
    const share = await ensureApp(A, {
      name: `Studio CLI share links (${name})`,
      domain: `${host}/share/*`,
      include: [{ email_domain: { domain: mailDomain } }],
      label: `Anyone at @${mailDomain}`,
    });
    return { aud: main.aud, shareAud: share.aud };
  }

  return { cf, writable, policyFor, pickAccount, teamDomain, ensureApp, findZone, provisionTunnel, provisionAccess };
}

export const TOKEN_HELP = `  I need a Cloudflare API token, used once and never saved. Make one at:
    https://dash.cloudflare.com/profile/api-tokens → Create Token → Create Custom Token, with these permissions:
      • Account · Cloudflare Tunnel · Edit
      • Account · Access: Apps and Policies · Edit
      • Account · Access: Organizations, Identity Providers, and Groups · Read
      • Account · Account Settings · Read
      • Zone · DNS · Edit`;
