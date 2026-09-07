import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const apiTarget = process.env.LOCAL_MINIDRAMA_API_TARGET || 'http://127.0.0.1:5679'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // The workspace may be exposed through a Windows junction (C: -> H:).
    // Keep Vite/Rollup asset names relative to the logical project root so
    // builds behave the same from either path instead of emitting an absolute
    // junction target as an asset filename.
    preserveSymlinks: true,
    // Keep Vue and vue-router as singletons across the main bundle and
    // lazy-loaded route chunks.  Without this, duplicated injection symbols
    // make useRoute()/useRouter() return undefined at runtime.
    dedupe: ['vue', 'vue-router'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0',
    port: 3013,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        proxyTimeout: 600000,
        timeout: 600000
      },
      '/static': {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
})
