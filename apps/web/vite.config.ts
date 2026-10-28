import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const api = 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      // ws: live updates, terminals and the CLI view are WebSockets under /api
      '/api': { target: api, ws: true, configure: (proxy) => void proxy.on('error', () => {}) },
      '/.well-known': api,
    },
  },
})
