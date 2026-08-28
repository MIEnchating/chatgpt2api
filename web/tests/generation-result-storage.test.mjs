import assert from "node:assert/strict";
import test from "node:test";

import { persistCreationTaskOutputs } from "../src/services/generation-result-storage.ts";

test("already managed image results keep their durable server URL", async () => {
  const task = {
    id: "task-managed-image",
    status: "success",
    mode: "generate",
    data: [{ url: "/images/2026/08/27/result.png", width: 1024, height: 1024 }],
    output_statuses: ["success"],
  };

  assert.equal(await persistCreationTaskOutputs(task), task);
  assert.equal(task.data[0].url, "/images/2026/08/27/result.png");
  assert.equal(task.data[0].storageKey, undefined);
});
