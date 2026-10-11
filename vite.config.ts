import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { checkAccess, remoteConfig } from './server/access.ts';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // Same lock as the API server: remote visitors need a Cloudflare Access login to get the UI too.
      name: 'studio-remote-access',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          checkAccess(req.headers).then((ok) => {
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
    port: 4610,
    host: '127.0.0.1',
    proxy: {
      // Object form on purpose: the string shorthand sets changeOrigin, which rewrites Host to
      // 127.0.0.1 and makes server/access.ts refuse remote (studio-cli.cantivia.com) API calls.
      '/api': { target: 'http://127.0.0.1:4600', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:4600', ws: true },
    },
  },
});
