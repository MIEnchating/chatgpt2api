import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const backendTarget = process.env.VITE_BACKEND_URL || "http://127.0.0.1:8001";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(webRoot, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 8000,
    strictPort: true,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/auth": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/v1": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/images": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/image-references": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/image-thumbnails": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/login-page-images": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/site-icons": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/health": {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../internal/web/dist",
    emptyOutDir: true,
  },
});
