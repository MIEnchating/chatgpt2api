import assert from "node:assert/strict";
import test from "node:test";

import { isCanvasExportFile } from "../src/app/canvas/canvas-project-transfer-types.ts";

const project = {
  version: 1,
  id: "project",
  revision: 1,
  title: "画布",
  background: "dots",
  nodes: [],
  connections: [],
  viewport: { zoom: 1, x: 0, y: 0 },
};

test("accepts the reference project version 3 canvas manifest", () => {
  assert.equal(isCanvasExportFile({
    app: "infinite-canvas",
    version: 3,
    exportedAt: "2026-08-26T00:00:00.000Z",
    projects: [{ project, files: [{ storageKey: "image:key", path: "projects/project/files/image_key.png", mimeType: "image/png", bytes: 3 }] }],
  }), true);
});

test("rejects legacy or incomplete canvas manifests", () => {
  assert.equal(isCanvasExportFile({ app: "yunmian-canvas", version: 1, projects: [project] }), false);
  assert.equal(isCanvasExportFile({ app: "infinite-canvas", version: 3, projects: [{ project, files: [{ storageKey: "image:key" }] }] }), false);
});
