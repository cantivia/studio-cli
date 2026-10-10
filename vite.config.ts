import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4610,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:4600',
      '/ws': { target: 'ws://127.0.0.1:4600', ws: true },
    },
  },
});
