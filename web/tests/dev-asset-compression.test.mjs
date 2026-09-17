import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import viteConfig from "../vite.config.ts";

test("development compression only changes frontend resources", async () => {
  const plugin = viteConfig.plugins.find((plugin) => plugin.name === "compress-development-assets");
  let middleware;
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  const body = "export const message = 'frontend resource';\n".repeat(100);
  // A temporary loopback listener tests middleware without touching the dev service.
  const server = createServer((req, res) => middleware(req, res, () => {
    res.setHeader("Content-Type", req.url.includes("events") ? "text/event-stream" : "text/javascript");
    res.end(body);
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [path, encoding, compressed] of [
      ["/src/main.tsx", "gzip", true],
      ["/node_modules/.vite/deps/react.js", "gzip", true],
      ["/src/main.tsx", "identity", false],
      ["/api/creation-tasks/events", "gzip", false],
      ["/api/model-config", "gzip", false],
      ["/auth/session", "gzip", false],
      ["/images/private.png", "gzip", false],
    ]) {
      const response = await new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: server.address().port, path, headers: { "Accept-Encoding": encoding } }, (res) => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(response.headers["content-encoding"], compressed ? "gzip" : undefined, path);
      assert.equal((compressed ? gunzipSync(response.body) : response.body).toString(), body);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
