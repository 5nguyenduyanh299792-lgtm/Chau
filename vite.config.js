import { defineConfig } from "vite";

// App là 1 file index.html thuần; Vite chỉ dùng để chạy dev server / build.
export default defineConfig({
  server: { port: 3000, host: "0.0.0.0" },
  preview: { port: 3000, host: "0.0.0.0" },
});
