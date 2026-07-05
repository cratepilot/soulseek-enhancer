import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev server proxies API calls to the enhancer server.
      '/api': 'http://127.0.0.1:5271',
    },
  },
  build: {
    outDir: 'dist',
  },
})
