import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer as createViteServer } from "vite";
import config from "../vite.config.ts";

test("development server binds to loopback by default", () => {
  assert.equal(config.server?.host, "127.0.0.1");
});

test("development watcher ignores external logs while keeping application HMR", () => {
  const ignored = config.server?.watch?.ignored;
  assert.equal(typeof ignored, "function");
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(ignored(path.join(root, "src/app/globals.css")), false);
  assert.equal(ignored(path.join(root, "vite.config.ts")), false);
  assert.equal(ignored(path.resolve(root, "../../../.pm2/pm2.log")), true);
  assert.equal(ignored(path.join(root, "../web-other/log.txt")), true);
});

test("backend proxy preserves Host and Origin and derives forwarding headers from the connection", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "chatgpt2api-vite-proxy-test-"));
  const backend = createHTTPServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      host: request.headers.host,
      origin: request.headers.origin,
      forwardedFor: request.headers["x-forwarded-for"],
      forwardedProto: request.headers["x-forwarded-proto"],
      realIP: request.headers["x-real-ip"],
      forwardedHost: request.headers["x-forwarded-host"],
    }));
  });
  let vite;
  let frontend;
  try {
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const target = `http://127.0.0.1:${backend.address().port}`;
    const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([prefix, options]) => [
      prefix, { ...options, target },
    ]));
    vite = await createViteServer({
      cacheDir,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, proxy },
    });
    frontend = createHTTPServer(vite.middlewares);
    frontend.listen(0, "127.0.0.1");
    await once(frontend, "listening");
    const frontendURL = `http://127.0.0.1:${frontend.address().port}`;
    for (const source of [
      { host: new URL(frontendURL).host, origin: frontendURL, proto: "http" },
      { host: "192.0.2.10:8002", origin: "https://192.0.2.10:8002", proto: "https" },
      { host: "192.0.2.10:8002", origin: "https://evil.example.test", proto: "https" },
      { host: "192.0.2.10:8002", origin: "null", proto: "https" },
    ]) {
      for (const route of ["/api/canvas/agent-runs", "/api/canvas/agent-tools", "/auth/logout"]) {
        const response = await fetch(`${frontendURL}${route}`, {
          method: "POST",
          headers: {
            Host: source.host,
            Origin: source.origin,
            "X-Forwarded-Proto": source.proto,
            "X-Forwarded-For": "192.0.2.20",
            "X-Real-IP": "192.0.2.21",
            "X-Forwarded-Host": "proxy.example.test",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          host: source.host,
          origin: source.origin,
          forwardedFor: "127.0.0.1",
          forwardedProto: "http",
        }, `${route} must preserve the browser origin and forward the real connection details`);
      }
    }
  } finally {
    if (frontend) {
      frontend.closeAllConnections();
      await new Promise((resolve) => frontend.close(resolve));
    }
    await vite?.close();
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    await rm(cacheDir, { recursive: true, force: true });
  }
});
