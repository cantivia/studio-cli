import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { checkAccess, remoteConfig } from './server/access.ts';

// A second Studio for testing runs on other ports (STUDIO_WEB_PORT / STUDIO_API_PORT) next to the real one.
const WEB_PORT = Number(process.env.STUDIO_WEB_PORT || 4610);
const API_PORT = Number(process.env.STUDIO_API_PORT || 4600);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // Same lock as the API server: remote visitors need a Cloudflare Access login to get the UI too.
      name: 'studio-remote-access',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          checkAccess(req.headers, req.url || '/').then((ok) => {
            if (ok) return next();
            const h = req.headers;
            console.warn(`[access] refused ${req.method} ${req.url} host=${h.host} jwt=${!!h['cf-access-jwt-assertion']} cookie=${/CF_Authorization/.test(h.cookie || '')}`);
            res.statusCode = 403;
            res.end('Forbidden');
          });
        });
      },
    },
  ],
  server: {
    allowedHosts: remoteConfig() ? [remoteConfig()!.host] : [],
    port: WEB_PORT,
    host: '127.0.0.1',
    proxy: {
      // Object form on purpose: the string shorthand sets changeOrigin, which rewrites Host to
      // 127.0.0.1 and makes server/access.ts refuse remote (studio-cli.cantivia.com) API calls.
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
      // Share links (see server/shares.ts) are served by the API server, including their terminal sockets.
      '/share': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false, ws: true },
    },
  },
});
