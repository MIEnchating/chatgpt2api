import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(webRoot, "src/desktop"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": path.join(webRoot, "src") } },
  css: { postcss: webRoot },
  build: {
    outDir: path.join(webRoot, "../desktop/renderer"),
    emptyOutDir: true,
  },
});
