import assert from "node:assert/strict";
import test from "node:test";
import { spyOn } from "bun:test";
import * as mediaStorage from "../src/services/file-storage.ts";
import { createZip, readZip } from "../src/lib/zip.ts";
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

test("canvas import preserves independent thumbnails and empty thumbnail fields", async () => {
  const upload = spyOn(mediaStorage, "uploadMediaBlob").mockImplementation(async (_blob, name) => ({
    storageKey: `server:new-${name}`, url: `/api/files/new-${name}/content`, mimeType: "video/mp4", bytes: 3,
  }));
  try {
    const input = { ...project, nodes: [
      { id: "video", storage_key: "server:old", url: "/api/files/old/content", thumbnail_url: "/api/files/poster/content" },
      { id: "without-poster", storage_key: "server:old", url: "/api/files/old/content", thumbnail_url: "" },
    ] };
    const poster = { storageKey: "server:poster", path: "poster.bin", mimeType: "video/mp4", bytes: 3 };
    const [result] = await readCanvasProjectArchive(await archive([{ project: input, files: [media, poster] }], [
      { name: "media.bin", data: "abc" }, { name: "poster.bin", data: "def" },
    ]));
    assert.equal(result.nodes[0].url, "/api/files/new-media.bin/content");
    assert.equal(result.nodes[0].thumbnail_url, "/api/files/new-poster.bin/content");
    assert.equal(result.nodes[1].thumbnail_url, "");
  } finally { upload.mockRestore(); }
});

test("canvas import rejects conflicting content for a shared storage key before uploading", async () => {
  const upload = spyOn(mediaStorage, "uploadMediaBlob");
  try {
    const file = await archive([{ project, files: [media, { ...media, path: "other.bin" }] }], [
      { name: "media.bin", data: "abc" }, { name: "other.bin", data: "def" },
    ]);
    await assert.rejects(readCanvasProjectArchive(file), /冲突的媒体引用/);
    assert.equal(upload.mock.calls.length, 0);
  } finally { upload.mockRestore(); }
});

test("canvas export shares media across projects without normalized filename collisions", async () => {
  const read = spyOn(mediaStorage, "getMediaBlob").mockImplementation(async (key) => new Blob([key], { type: "audio/mpeg" }));
  try {
    const first = { ...project, nodes: [{ storage_key: "server:a/b" }, { storage_key: "server:a_b" }] };
    const blob = await createCanvasProjectArchive([first, { ...first, id: "second" }]);
    const contents = await readZip(blob);
    const manifest = JSON.parse(await contents.get("projects.json").text());
    assert.equal(read.mock.calls.length, 2);
    assert.equal(contents.size, 3);
    assert.equal(new Set(manifest.projects[0].files.map((file) => file.path)).size, 2);
    for (const item of manifest.projects) for (const file of item.files) {
      assert.equal(await contents.get(file.path).text(), file.storageKey);
    }
  } finally { read.mockRestore(); }
});

test("canvas project transfers bound concurrent media requests", async () => {
  let inFlight = 0;
  let peak = 0;
  const track = async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
  };
  const read = spyOn(mediaStorage, "getMediaBlob").mockImplementation(async (key) => { await track(); return new Blob([key], { type: "audio/mpeg" }); });
  const upload = spyOn(mediaStorage, "uploadMediaBlob").mockImplementation(async (_blob, name) => {
    await track();
    return { storageKey: `server:${name}`, url: `/api/files/${name}/content`, bytes: 12, mimeType: "audio/mpeg" };
  });
  try {
    const input = { ...project, nodes: Array.from({ length: 12 }, (_, index) => ({ storage_key: `server:key-${index}` })) };
    const blob = await createCanvasProjectArchive([input]);
    assert.ok(peak > 1 && peak <= 4, `Unexpected export concurrency ${peak}`);
    peak = 0;
    await readCanvasProjectArchive(blob);
    assert.ok(peak > 1 && peak <= 4, `Unexpected import concurrency ${peak}`);
  } finally { read.mockRestore(); upload.mockRestore(); }
});
