import test from "node:test";
import assert from "node:assert/strict";

import {
  canStartImageConversationQueueRunner,
  canDispatchImageTurn,
  effectiveTaskSlotStatus,
  effectiveTaskOutputStatus,
  effectiveStoredImageLoadingPhase,
  hasFinalTaskOutput,
  mergeImageConversationLists,
  mergeImageConversationSnapshot,
  mergeCreationTaskList,
  mergeCreationTaskSnapshot,
  mergeTaskData,
  nextImageConversationRevision,
  rebaseImageConversationSnapshot,
  taskSnapshotIsOlder,
} from "../src/app/image/image-task-state.ts";

test("conversation queue runners are bounded and deduplicated", () => {
  const active = new Set(["conversation-1", "conversation-2", "conversation-3"]);
  assert.equal(canStartImageConversationQueueRunner(active, "conversation-1"), false);
  assert.equal(canStartImageConversationQueueRunner(active, "conversation-4"), false);
  active.delete("conversation-3");
  assert.equal(canStartImageConversationQueueRunner(active, "conversation-4"), true);
});

function task(overrides = {}) {
  return {
    id: "task-1",
    status: "running",
    mode: "generate",
    created_at: "2026-07-19 10:00:00",
    updated_at: "2026-07-19 10:00:02",
    ...overrides,
  };
}

function conversation(image, overrides = {}) {
  return {
    id: "conversation-1",
    revision: 1,
    title: "test",
    createdAt: "2026-07-19T10:00:00Z",
    updatedAt: "2026-07-19T10:00:01Z",
    turns: [{
      id: "turn-1",
      prompt: "draw",
      model: "gpt-image-2",
      mode: "generate",
      referenceImages: [],
      count: 1,
      size: "1024x1024",
      images: [image],
      createdAt: "2026-07-19T10:00:00Z",
      status: image.status === "loading" ? "generating" : image.status,
    }],
    ...overrides,
  };
}

test("terminal task cannot be reopened by a late active snapshot", () => {
  const terminal = task({ status: "success", revision: 5, data: [{ url: "https://example.test/a.png" }] });
  const lateRunning = task({ status: "running", revision: 6, updated_at: "2026-07-19 10:00:03", data: [] });
  assert.equal(taskSnapshotIsOlder(terminal, lateRunning), true);
  assert.equal(mergeCreationTaskSnapshot(terminal, lateRunning).status, "success");
});

test("task dispatch requires the current page, session, conversation, and task ids", () => {
  const active = conversation({
    id: "image-1",
    taskId: "task-1",
    taskStatus: "queued",
    status: "loading",
  });
  active.turns[0].status = "queued";
  const base = {
    pageActive: true,
    sessionCurrent: true,
    conversationDeleted: false,
    turnCancelled: false,
    conversation: active,
    turnId: "turn-1",
    taskIds: ["task-1"],
  };

  assert.equal(canDispatchImageTurn(base), true);
  assert.equal(canDispatchImageTurn({ ...base, pageActive: false }), false);
  assert.equal(canDispatchImageTurn({ ...base, sessionCurrent: false }), false);
  assert.equal(canDispatchImageTurn({ ...base, conversationDeleted: true }), false);
  assert.equal(canDispatchImageTurn({ ...base, turnCancelled: true }), false);
  assert.equal(canDispatchImageTurn({ ...base, taskIds: ["task-replaced"] }), false);
  assert.equal(canDispatchImageTurn({ ...base, conversation: null }), false);

  const completed = conversation({
    id: "image-1",
    taskId: "task-1",
    taskStatus: "success",
    status: "success",
    url: "https://example.test/final.png",
  });
  assert.equal(canDispatchImageTurn({ ...base, conversation: completed }), false);
});

test("conversation revision allocation advances past in-flight reservations", () => {
  assert.equal(nextImageConversationRevision(4, 4, 5), 6);
  assert.equal(nextImageConversationRevision(8, 4, 5), 9);
  assert.equal(nextImageConversationRevision(undefined, "7", Number.NaN), 8);
});

test("older revision cannot replace a completed task", () => {
  const completed = task({ status: "success", revision: 3, data: [{ url: "https://example.test/a.png" }] });
  const staleRunning = task({ status: "running", revision: 2, data: [] });
  assert.equal(taskSnapshotIsOlder(completed, staleRunning), true);
  const merged = mergeCreationTaskSnapshot(completed, staleRunning);
  assert.equal(merged.status, "success");
  assert.equal(merged.data?.[0]?.url, "https://example.test/a.png");
});

test("success evidence wins over a later error snapshot", () => {
  const completed = task({ status: "success", revision: 4, data: [{ url: "https://example.test/a.png" }] });
  const failed = task({ status: "error", revision: 5, error: "late transport error", data: [] });
  assert.equal(taskSnapshotIsOlder(completed, failed), true);
  assert.equal(mergeCreationTaskSnapshot(completed, failed).status, "success");
});

test("terminal snapshot wins over active snapshot even when timestamps are equal", () => {
  const active = task({ status: "running", revision: 9 });
  const terminal = task({ status: "success", revision: 9, data: [{ url: "https://example.test/a.png" }] });
  assert.equal(taskSnapshotIsOlder(active, terminal), false);
  assert.equal(mergeCreationTaskSnapshot(active, terminal).status, "success");
});

test("sparse partial data cannot erase an earlier preview slot", () => {
  const previous = [{ url: "https://example.test/a.png" }, { url: "https://example.test/b.png" }];
  const incoming = [{}, {}];
  assert.deepEqual(mergeTaskData(previous, incoming), previous);
});

test("final output clears an earlier preview marker and preview bytes", () => {
  const merged = mergeTaskData(
    [{ b64_json: "preview", preview: true }],
    [{ url: "https://example.test/final.png" }],
  );
  assert.deepEqual(merged, [{ url: "https://example.test/final.png" }]);
  assert.equal(hasFinalTaskOutput(merged?.[0]), true);
});

test("late preview data cannot replace a completed output slot", () => {
  const final = { url: "https://example.test/final.png" };
  const merged = mergeTaskData([final], [{ b64_json: "late-preview", preview: true }]);
  assert.deepEqual(merged, [final]);
});

test("duplicate task snapshots merge by task id and keep output data", () => {
  const merged = mergeCreationTaskList([
    task({ revision: 1, data: [{ url: "https://example.test/a.png" }], output_statuses: ["success"] }),
    task({ revision: 2, data: [], output_statuses: ["running"] }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].revision, 2);
  assert.equal(merged[0].data?.[0]?.url, "https://example.test/a.png");
  assert.equal(merged[0].output_statuses?.[0], "success");
});

test("a single running task reconciles a stale queued output status", () => {
  assert.equal(effectiveTaskOutputStatus("running", "queued", 1), "running");
  assert.equal(effectiveTaskOutputStatus("running", "queued", 2), "queued");
  assert.equal(effectiveTaskOutputStatus("running"), "running");
  assert.equal(effectiveTaskOutputStatus("running", "running"), "running");
  assert.equal(effectiveTaskOutputStatus("running", "success"), "success");
});

test("an active task exposes a completed output slot immediately", () => {
  const finalImage = { url: "https://example.test/final.png" };
  assert.equal(hasFinalTaskOutput(finalImage), true);
  assert.equal(effectiveTaskSlotStatus("running", "success", finalImage, 2), "success");
});

test("partial image data remains active even with a premature success status", () => {
  const preview = { b64_json: "partial", preview: true };
  assert.equal(hasFinalTaskOutput(preview), false);
  assert.equal(effectiveTaskSlotStatus("running", "success", preview, 2), "running");
});

test("active task output failures and cancellation are terminal per slot", () => {
  assert.equal(effectiveTaskSlotStatus("running", "error", undefined, 2), "error");
  assert.equal(effectiveTaskSlotStatus("running", "cancelled", undefined, 2), "cancelled");
});

test("queued and running output slots stay active without final data", () => {
  assert.equal(effectiveTaskSlotStatus("queued", "running", undefined, 2), "running");
  assert.equal(effectiveTaskSlotStatus("running", "queued", undefined, 2), "queued");
  assert.equal(effectiveTaskSlotStatus("running", "running", undefined, 2), "running");
  assert.equal(effectiveTaskSlotStatus("running", "success", undefined, 2), "running");
});

test("a persisted single-image generating turn cannot render as queued", () => {
  const image = { id: "image-1", status: "loading", taskStatus: "queued" };
  const context = { status: "generating", images: [image] };
  assert.equal(effectiveStoredImageLoadingPhase(image, context), "running");
});

test("a multi-image generating turn preserves queued slots", () => {
  const running = { id: "image-1", status: "loading", taskStatus: "running" };
  const queued = { id: "image-2", status: "loading", taskStatus: "queued" };
  const context = { status: "generating", images: [running, queued] };
  assert.equal(effectiveStoredImageLoadingPhase(running, context), "running");
  assert.equal(effectiveStoredImageLoadingPhase(queued, context), "queued");

  const completed = { id: "image-1", status: "success", taskStatus: "success" };
  assert.equal(
    effectiveStoredImageLoadingPhase(queued, { status: "generating", images: [completed, queued] }),
    "queued",
  );
});

test("terminal task replaces partial base64 data and output status", () => {
  const partial = task({
    revision: 3,
    data: [{ b64_json: "partial" }, { b64_json: "discarded-preview" }],
    output_statuses: ["success", "success"],
  });
  const terminal = task({
    status: "error",
    revision: 4,
    data: [{ url: "https://example.test/final.png" }],
    output_statuses: ["success", "error"],
    error: "second output failed",
  });
  const merged = mergeCreationTaskSnapshot(partial, terminal);
  assert.deepEqual(merged.data, [{ url: "https://example.test/final.png" }]);
  assert.deepEqual(merged.output_statuses, ["success", "error"]);
});

test("remote running history cannot reopen a completed image from the same task", () => {
  const completed = conversation({
    id: "image-1",
    taskId: "task-1",
    taskRevision: 5,
    taskStatus: "success",
    status: "success",
    url: "https://example.test/final.png",
  }, { revision: 5, updatedAt: "2026-07-19T10:00:05Z" });
  const staleRunning = conversation({
    id: "image-1",
    taskId: "task-1",
    taskRevision: 6,
    taskStatus: "running",
    status: "loading",
  }, { revision: 6, updatedAt: "2026-07-19T10:00:06Z" });

  const merged = mergeImageConversationSnapshot(completed, staleRunning);
  assert.equal(merged.turns[0].status, "success");
  assert.equal(merged.turns[0].images[0].status, "success");
  assert.equal(merged.turns[0].images[0].url, "https://example.test/final.png");
});

test("newer active data cannot erase a completed slot while another slot is running", () => {
  const previous = conversation({
    id: "image-1",
    taskId: "task-1",
    taskRevision: 5,
    taskStatus: "success",
    status: "success",
    url: "https://example.test/first.png",
  }, {
    revision: 5,
    turns: [{
      ...conversation({ id: "unused", status: "success" }).turns[0],
      count: 2,
      status: "success",
      images: [
        { id: "image-1", taskId: "task-1", taskRevision: 5, taskStatus: "success", status: "success", url: "https://example.test/first.png" },
        { id: "image-2", taskId: "task-2", taskRevision: 2, taskStatus: "running", status: "loading" },
      ],
    }],
  });
  const incoming = {
    ...previous,
    revision: 6,
    updatedAt: "2026-07-19T10:00:06Z",
    turns: [{
      ...previous.turns[0],
      status: "generating",
      images: [
        { id: "image-1", taskId: "task-1", taskRevision: 6, taskStatus: "running", status: "loading" },
        { id: "image-2", taskId: "task-2", taskRevision: 3, taskStatus: "running", status: "loading" },
      ],
    }],
  };

  const merged = mergeImageConversationSnapshot(previous, incoming);
  assert.equal(merged.turns[0].status, "generating");
  assert.equal(merged.turns[0].images[0].status, "success");
  assert.equal(merged.turns[0].images[1].status, "loading");
});

test("an explicit regeneration with a different task id may enter queued again", () => {
  const completed = conversation({
    id: "image-1",
    taskId: "task-old",
    taskRevision: 5,
    taskStatus: "success",
    taskCreatedAt: "2026-07-19T10:00:00Z",
    status: "success",
    url: "https://example.test/old.png",
  }, { revision: 5 });
  const regenerated = conversation({
    id: "image-1",
    taskId: "task-new",
    taskRevision: 1,
    taskStatus: "queued",
    taskCreatedAt: "2026-07-19T10:01:00Z",
    status: "loading",
  }, { revision: 6, updatedAt: "2026-07-19T10:01:00Z" });

  const merged = mergeImageConversationSnapshot(completed, regenerated);
  assert.equal(merged.turns[0].status, "queued");
  assert.equal(merged.turns[0].images[0].taskId, "task-new");
  assert.equal(merged.turns[0].images[0].status, "loading");
});

test("full-turn regeneration replaces old image ids instead of resurrecting them", () => {
  const completed = conversation({
    id: "image-old",
    taskId: "task-old",
    taskRevision: 5,
    taskStatus: "success",
    status: "success",
    url: "https://example.test/old.png",
  }, { revision: 5 });
  const regenerated = {
    ...completed,
    revision: 6,
    updatedAt: "2026-07-19T10:01:00Z",
    turns: [{
      ...completed.turns[0],
      status: "queued",
      images: [{
        id: "image-new",
        taskId: "task-new",
        taskStatus: "queued",
        status: "loading",
      }],
    }],
  };

  const merged = mergeImageConversationSnapshot(completed, regenerated);
  assert.deepEqual(merged.turns[0].images.map((image) => image.id), ["image-new"]);
  assert.equal(merged.turns[0].status, "queued");
});

test("durable append keeps a concurrently completed older turn", () => {
  const completed = conversation({
    id: "image-1",
    taskId: "task-1",
    taskRevision: 8,
    taskStatus: "success",
    status: "success",
    url: "https://example.test/final.png",
  }, { revision: 8, updatedAt: "2026-07-19T10:00:08Z" });
  const staleExistingTurn = {
    ...completed.turns[0],
    status: "generating",
    images: [{
      id: "image-1",
      taskId: "task-1",
      taskRevision: 7,
      taskStatus: "running",
      status: "loading",
    }],
  };
  const queuedTurn = {
    ...completed.turns[0],
    id: "turn-2",
    createdAt: "2026-07-19T10:00:07Z",
    status: "queued",
    images: [{
      id: "image-2",
      taskId: "task-2",
      taskStatus: "queued",
      status: "loading",
    }],
  };
  const staleAppend = {
    ...completed,
    revision: 7,
    updatedAt: "2026-07-19T10:00:07Z",
    turns: [staleExistingTurn, queuedTurn],
  };

  const merged = mergeImageConversationSnapshot(completed, staleAppend);
  assert.deepEqual(merged.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
  assert.equal(merged.turns[0].status, "success");
  assert.equal(merged.turns[0].images[0].url, "https://example.test/final.png");
  assert.equal(merged.turns[1].status, "queued");
});

test("rebasing a rev8 pending branch on remote rev8 keeps both appended turns at rev9", () => {
  const base = conversation({
    id: "image-rebase",
    taskId: "task-base",
    taskStatus: "success",
    status: "success",
    url: "https://example.test/base.png",
  }, {
    id: "image-rebase",
    revision: 7,
    updatedAt: "2026-07-19T10:00:07Z",
  });
  const remote = {
    ...base,
    revision: 8,
    updatedAt: "2026-07-19T10:00:08Z",
    turns: [
      ...base.turns,
      {
        ...base.turns[0],
        id: "turn-a",
        createdAt: "2026-07-19T10:00:08Z",
        images: [{ id: "image-a", taskId: "task-a", taskStatus: "success", status: "success", url: "https://example.test/a.png" }],
      },
    ],
  };
  const pending = {
    ...base,
    revision: 8,
    updatedAt: "2026-07-19T10:00:08.100Z",
    turns: [
      ...base.turns,
      {
        ...base.turns[0],
        id: "turn-b",
        createdAt: "2026-07-19T10:00:08.100Z",
        images: [{ id: "image-b", taskId: "task-b", taskStatus: "success", status: "success", url: "https://example.test/b.png" }],
      },
    ],
  };

  const merged = rebaseImageConversationSnapshot(remote, pending, "2026-07-19T10:00:09Z");
  assert.equal(merged.revision, 9);
  assert.deepEqual(new Set(merged.turns.map((turn) => turn.id)), new Set(["turn-1", "turn-a", "turn-b"]));
});

test("full active/detail snapshots always win over same-revision summary rows", () => {
  const full = conversation({
    id: "image-summary",
    taskId: "task-summary",
    taskStatus: "success",
    status: "success",
    url: "https://example.test/full.png",
  }, {
    id: "image-summary",
    revision: 4,
    historySummaryOnly: undefined,
    updatedAt: "2026-07-19T10:00:04Z",
  });
  const summary = {
    id: full.id,
    revision: 4,
    title: full.title,
    createdAt: full.createdAt,
    updatedAt: "2026-07-19T10:00:05Z",
    turns: [],
    historySummaryOnly: true,
    historySummary: { turnCount: 1, queued: 0, running: 0 },
  };

  for (const [left, right] of [[summary, full], [full, summary]]) {
    const merged = mergeImageConversationSnapshot(left, right);
    assert.notEqual(merged.historySummaryOnly, true);
    assert.equal(merged.turns.length, 1);
    assert.equal(merged.turns[0].id, "turn-1");
  }
});

test("a newer summary invalidates an older full snapshot in either merge order", () => {
  const full = conversation({
    id: "image-summary-newer",
    taskId: "task-summary-newer",
    taskStatus: "success",
    status: "success",
    url: "https://example.test/old-full.png",
  }, {
    id: "image-summary-newer",
    revision: 7,
    updatedAt: "2026-07-19T10:00:07Z",
  });
  const summary = {
    id: full.id,
    revision: 8,
    title: full.title,
    createdAt: full.createdAt,
    updatedAt: "2026-07-19T10:00:08Z",
    turns: [],
    historySummaryOnly: true,
    historySummary: { turnCount: 2, queued: 1, running: 0 },
  };

  for (const [left, right] of [[full, summary], [summary, full]]) {
    const merged = mergeImageConversationSnapshot(left, right);
    assert.equal(merged.historySummaryOnly, true);
    assert.deepEqual(merged.turns, []);
    assert.deepEqual(merged.historySummary, { turnCount: 2, queued: 1, running: 0 });
    assert.equal(merged.revision, 8);
  }
});

test("authoritative remote deletion does not preserve unrelated clean local conversations", () => {
  const local = conversation({ id: "image-1", status: "success", taskStatus: "success" });
  assert.deepEqual(mergeImageConversationLists([local], []), []);
  assert.deepEqual(mergeImageConversationLists([local], [], true), [local]);
});

test("a cursor page appends without dropping conversations already loaded", () => {
  const first = conversation({ id: "image-first", status: "success", taskStatus: "success" }, {
    id: "image-first",
    updatedAt: "2026-07-19T10:00:02Z",
  });
  const second = conversation({ id: "image-second", status: "success", taskStatus: "success" }, {
    id: "image-second",
    updatedAt: "2026-07-19T10:00:01Z",
  });
  const appended = mergeImageConversationLists([first], [second], true);
  assert.deepEqual(appended.map((item) => item.id), ["image-first", "image-second"]);
});

test("a page duplicate is merged monotonically instead of regressing a terminal turn", () => {
  const completed = conversation({
    id: "image-page",
    taskId: "task-page",
    taskRevision: 4,
    taskStatus: "success",
    status: "success",
    url: "https://example.test/final.png",
  }, { revision: 4, updatedAt: "2026-07-19T10:00:04Z" });
  const stale = conversation({
    id: "image-page",
    taskId: "task-page",
    taskRevision: 5,
    taskStatus: "running",
    status: "loading",
  }, { revision: 5, updatedAt: "2026-07-19T10:00:05Z" });
  const merged = mergeImageConversationLists([completed], [stale]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].turns[0].status, "success");
  assert.equal(merged[0].turns[0].images[0].url, "https://example.test/final.png");
});

test("equal timestamps use the conversation id as a stable page ordering tie-breaker", () => {
  const left = conversation({ id: "image-a", status: "success", taskStatus: "success" }, {
    id: "image-a",
    updatedAt: "2026-07-19T10:00:00Z",
  });
  const right = conversation({ id: "image-z", status: "success", taskStatus: "success" }, {
    id: "image-z",
    updatedAt: "2026-07-19T10:00:00Z",
  });
  const merged = mergeImageConversationLists([], [left, right]);
  assert.deepEqual(merged.map((item) => item.id), ["image-z", "image-a"]);
});
