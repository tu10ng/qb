import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // SPA 挂在 dsh 的 /qb 前缀下，资源路径必须带这个基准
  base: '/qb/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // 开发时前端单独跑，API 与 WS 转发到 dsh 进程
    proxy: {
      '/qb/api': 'http://127.0.0.1:3080',
      '/qb/ws': { target: 'ws://127.0.0.1:3080', ws: true },
    },
  },
})
