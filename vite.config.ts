import { defineConfig } from 'vite';

// Ứng dụng nằm gọn trong index.html (HTML + CSS + JS thuần).
// Vite chỉ dùng làm dev server / build để chạy được trên Google AI Studio.
export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    // AI Studio tắt HMR bằng biến môi trường DISABLE_HMR=true.
    hmr: process.env.DISABLE_HMR !== 'true',
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
  },
});
