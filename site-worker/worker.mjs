/**
 * The website's download address. /download/arm64 and /download/x64 serve the installer from Cloudflare's own
 * network cache instead of sending people to GitHub's storage: the first request fetches it from the GitHub
 * release, every later one is served from the cache nearest the visitor. Resumed or partial downloads (Range)
 * work from the cache. Everything else (the page, images, downloads.json) is plain static files.
 *
 * Which file is the latest comes from site/downloads.json ("source" URLs, "version"), so shipping a new version
 * needs no change here. Only GitHub release URLs of this project are ever fetched.
 */
const ALLOWED = /^https:\/\/github\.com\/cantivia\/studio-cli\/releases\//;
const NAMES = { arm64: 'Studio-CLI-arm64.dmg', x64: 'Studio-CLI-x64.dmg' };

async function latest(env, origin) {
  const r = await env.ASSETS.fetch(new Request(`${origin}/downloads.json`));
  return r.json();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const arch = url.pathname.match(/^\/download\/(arm64|x64)$/)?.[1];
    if (!arch || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });

    const d = await latest(env, url.origin);
    const source = d.source?.[arch];
    if (!source || !ALLOWED.test(source)) return new Response('Not available yet', { status: 404 });

    // One cache entry per version: a new release gets a new key, so nobody is ever served an old file.
    const key = new Request(`${url.origin}/download/${arch}?v=${encodeURIComponent(d.version)}`, { headers: request.headers, method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('x-studio-cache', 'HIT');
      return new Response(request.method === 'HEAD' ? null : hit.body, { status: hit.status, headers: h });
    }

    const upstream = await fetch(source, { redirect: 'follow' });
    if (!upstream.ok || !upstream.body) return new Response('The download is temporarily unavailable. Please try again in a minute.', { status: 502 });
    const headers = new Headers({
      'content-type': 'application/x-apple-diskimage',
      'content-disposition': `attachment; filename="${NAMES[arch]}"`,
      'cache-control': 'public, max-age=86400',
      'accept-ranges': 'bytes',
      'x-studio-cache': 'MISS',
    });
    const len = upstream.headers.get('content-length');
    if (len) headers.set('content-length', len);
    const res = new Response(upstream.body, { status: 200, headers });
    // Keep a copy for the next visitor (the clone is read while this one streams to the client).
    if (request.method === 'GET') {
      const store = new Response(res.clone().body, { status: 200, headers });
      ctx.waitUntil(cache.put(new Request(key.url), store).catch(() => {}));
    }
    return request.method === 'HEAD' ? new Response(null, { status: 200, headers }) : res;
  },
};
