import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const backendTarget = process.env.VITE_BACKEND_URL || "http://127.0.0.1:8001";
const backendProxyPaths = [
  "/api",
  "/auth",
  "/images",
  "/videos",
  "/audios",
  "/image-references",
  "/image-thumbnails",
  "/conversation-assets",
  "/video-image-references",
  "/video-references",
  "/audio-references",
  "/login-page-images",
  "/site-icons",
  "/health",
] as const;
const backendProxy = Object.fromEntries(
  backendProxyPaths.map((path) => [path, { target: backendTarget, changeOrigin: true }]),
);

function rejectLocalV1Routes(): Plugin {
  return {
    name: "reject-local-v1-routes",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        if (pathname === "/v1" || pathname.startsWith("/v1/")) {
          response.statusCode = 404;
          response.end("Not Found");
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [rejectLocalV1Routes(), react()],
  resolve: {
    alias: {
      "@": path.resolve(webRoot, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 8000,
    strictPort: true,
    proxy: backendProxy,
  },
  build: {
    outDir: "../internal/web/dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/]react(?:-dom)?|node_modules[\\/]react-router-dom/,
              priority: 30,
              minSize: 0,
            },
            {
              name: "motion-vendor",
              test: /node_modules[\\/]motion[\\/]/,
              priority: 25,
              minSize: 0,
            },
            {
              name: "ui-vendor",
              test: /node_modules[\\/](?:lucide-react|sonner|@radix-ui)[\\/]/,
              priority: 20,
              minSize: 0,
            },
            {
              name: "data-vendor",
              test: /node_modules[\\/](?:axios|zustand|date-fns)[\\/]/,
              priority: 15,
              minSize: 0,
            },
            {
              name: "media-vendor",
              test: /node_modules[\\/]xgplayer[\\/]/,
              priority: 10,
              minSize: 0,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
              priority: 1,
              minSize: 0,
              maxSize: 300 * 1024,
            },
          ],
        },
      },
    },
  },
});
