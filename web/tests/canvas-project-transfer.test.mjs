import assert from "node:assert/strict";
import test from "node:test";
import { spyOn } from "bun:test";
import * as mediaStorage from "../src/services/file-storage.ts";
import { createZip } from "../src/lib/zip.ts";
import { createCanvasProjectArchive, readCanvasProjectArchive } from "../src/app/canvas/canvas-project-transfer.ts";

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

async function archive(projects, files = [{ name: "media.bin", data: "abc" }]) {
  return createZip([{ name: "projects.json", data: JSON.stringify({ app: "infinite-canvas", version: 3, projects }) }, ...files]);
}

const media = { storageKey: "server:old", path: "media.bin", mimeType: "audio/mpeg", bytes: 3 };

test("canvas import uploads shared media once and rewrites nested references", async () => {
  const upload = spyOn(mediaStorage, "uploadMediaBlob").mockResolvedValue({ storageKey: "server:new", url: "/api/files/new/content", mimeType: "audio/mpeg", bytes: 3 });
  try {
    const input = { ...project, nodes: [{ id: "media", storage_key: "server:old", url: "https://media.example/old" }, { id: "config", generation_video_reference_audio: ["https://media.example/old", "/api/files/old/content"] }] };
    const result = await readCanvasProjectArchive(await archive([{ project: input, files: [media] }, { project: { ...input, id: "second" }, files: [media] }]));
    assert.equal(upload.mock.calls.length, 1);
    assert.equal(result[0].nodes[0].storage_key, "server:new");
    assert.deepEqual(result[0].nodes[1].generation_video_reference_audio, ["/api/files/new/content", "/api/files/new/content"]);
  } finally { upload.mockRestore(); }
});

test("canvas import validates all media and project limits before uploading", async () => {
  const upload = spyOn(mediaStorage, "uploadMediaBlob");
  try {
    const items = [{ project, files: [media, { ...media, storageKey: "server:missing", path: "missing.bin" }] }];
    await assert.rejects(readCanvasProjectArchive(await archive(items)), /媒体缺失/);
    await assert.rejects(readCanvasProjectArchive(await archive([{ project, files: [media] }, { project, files: [media] }]), 1), /1-1/);
    assert.equal(upload.mock.calls.length, 0);
  } finally { upload.mockRestore(); }
});

test("canvas import cleans successful uploads when another upload fails", async () => {
  const upload = spyOn(mediaStorage, "uploadMediaBlob")
    .mockResolvedValueOnce({ storageKey: "server:new", url: "/api/files/new/content", mimeType: "audio/mpeg", bytes: 3 })
    .mockRejectedValueOnce(new Error("upload failed"));
  const cleanup = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
  try {
    const file = await archive([{ project, files: [media, { ...media, storageKey: "server:second" }] }]);
    await assert.rejects(readCanvasProjectArchive(file), /upload failed/);
    assert.deepEqual(cleanup.mock.calls[0][0], ["server:new"]);
  } finally { upload.mockRestore(); cleanup.mockRestore(); }
});

test("canvas export rejects missing media instead of silently producing an incomplete archive", async () => {
  const read = spyOn(mediaStorage, "getMediaBlob").mockResolvedValue(null);
  try {
    await assert.rejects(createCanvasProjectArchive([{ ...project, nodes: [{ id: "media", storage_key: "server:missing" }] }]), /无法读取/);
  } finally { read.mockRestore(); }
});
