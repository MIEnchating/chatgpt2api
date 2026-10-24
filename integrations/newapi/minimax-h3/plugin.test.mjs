import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./minimax-h3-v1.0.1.js", import.meta.url));
const plugin = await import(`data:text/javascript;base64,${source.toString("base64")}`);

for (const method of ["GET", "HEAD"]) {
  test(`${method} content uses the provider task ID and delegates binary streaming to New API`, () => {
    const request = plugin.buildContentRequest({
      baseUrl: "http://provider.example:3000",
      apiKey: "fixture-key",
      taskId: "task_public-id",
      upstreamTaskId: "task_provider-id",
      artifactKey: "video",
      clientRequest: { method, headers: {} },
    });
    assert.deepEqual(request, {
      url: "http://provider.example:3000/v1/videos/task_provider-id/content",
      method,
      headers: { Authorization: "Bearer fixture-key" },
    });
  });
}
