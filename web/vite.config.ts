import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import compression from "compression";
import { defineConfig } from "vite";
import type { Connect, Plugin } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const backendTarget = process.env.VITE_BACKEND_URL || "http://127.0.0.1:8090";
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
  // Preserve the browser-facing host for the backend's origin validation.
  backendProxyPaths.map((path) => [path, { target: backendTarget, changeOrigin: false }]),
);

function compressDevelopmentAssets(): Plugin {
  return {
    name: "compress-development-assets",
    apply: "serve",
    configureServer(server) {
      const compress = compression() as Connect.NextHandleFunction;
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        if (backendProxyPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
          next();
          return;
        }
        compress(request, response, next);
      });
    },
  };
}

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
  plugins: [rejectLocalV1Routes(), compressDevelopmentAssets(), react()],
  resolve: {
    alias: {
      "@": path.resolve(webRoot, "src"),
    },
  },
  optimizeDeps: {
    include: ["@videojs/react/i18n", "@videojs/react/video"],
  },
  server: {
    host: "0.0.0.0",
    port: 8002,
    strictPort: true,
    watch: {
      ignored: (filePath) => {
        const relative = path.relative(webRoot, filePath);
        return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
      },
    },
    warmup: {
      clientFiles: ["./src/main.tsx", "./src/app/image/page.tsx", "./src/app/profile/page.tsx"],
    },
    proxy: backendProxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 8002,
    strictPort: true,
    proxy: backendProxy,
  },
  build: {
    outDir: "../internal/web/dist",
    emptyOutDir: true,
  },
});
