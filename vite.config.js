import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  base: process.env.GITHUB_ACTIONS
    ? (process.env.VITE_PUBLIC_BASE || '/index-options-mentor-pwa/')
    : '/',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    }
  }
}));
