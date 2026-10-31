import assert from "node:assert/strict";
import test from "node:test";
import { createCreationTaskEventClient } from "../src/lib/creation-task-events.ts";

function fixture() {
  const connections = [];
  const client = createCreationTaskEventClient(({ signal, onData }) => new Promise((resolve) => {
    connections.push({ emit: (event) => onData(JSON.stringify(event)) });
    signal.addEventListener("abort", resolve, { once: true });
  }));
  return { client, connections };
}

const event = (items, type = "tasks") => ({ type, items, deleted_ids: [] });
const task = (revision, text) => ({ id: "one", revision, status: "running", data: [{ text_response: text }] });

test("string revisions are compared numerically so a stale event cannot overwrite a newer task", () => {
  const { client, connections } = fixture();
  const snapshots = [];
  const stop = client.watch({ onUpdate: (value) => snapshots.push(value), onError: assert.fail });
  try {
    connections[0].emit(event([task("10", "latest")], "snapshot"));
    connections[0].emit(event([task("9", "stale")]));
    assert.equal(snapshots.at(-1).items[0].data[0].text_response, "latest");
    connections[0].emit(event([task("11", "newer")]));
    assert.equal(snapshots.at(-1).items[0].data[0].text_response, "newer");
  } finally {
    stop();
    client.reset();
  }
});

test("mixed numeric and string revisions keep the highest revision", () => {
  const { client, connections } = fixture();
  const snapshots = [];
  const stop = client.watch({ onUpdate: (value) => snapshots.push(value), onError: assert.fail });
  try {
    connections[0].emit(event([task(12, "latest")], "snapshot"));
    connections[0].emit(event([task("3", "stale")]));
    assert.equal(snapshots.at(-1).items[0].data[0].text_response, "latest");
  } finally {
    stop();
    client.reset();
  }
});
