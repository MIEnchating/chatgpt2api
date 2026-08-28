import assert from "node:assert/strict";
import test from "node:test";

import { isWorkflowImageConversation } from "../src/lib/image-conversation-source.ts";

test("workflow conversations are isolated from the creation workbench", () => {
  assert.equal(isWorkflowImageConversation({ id: "workflow-task-1", turns: [] }), true);
  assert.equal(isWorkflowImageConversation({ id: "legacy", turns: [{ source: "workflow" }] }), true);
  assert.equal(isWorkflowImageConversation({ id: "legacy", turns: [{ workflowTaskId: "task-1" }] }), true);
  assert.equal(isWorkflowImageConversation({ id: "image-conversation-1", turns: [{ source: "image-workbench" }] }), false);
});
