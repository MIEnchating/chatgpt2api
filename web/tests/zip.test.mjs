import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { createZip, readZip, MAX_ZIP_BYTES } from "../src/lib/zip.ts";

test("project ZIP worker round trips binary media and Unicode names", async () => {
  const data = new Uint8Array([0, 255, 13, 10]);
  const archive = await createZip([
    { name: "项目/projects.json", data: "{\"version\":3}" },
    { name: "media.bin", data },
  ]);
  const files = await readZip(archive);
  assert.equal(await files.get("项目/projects.json").text(), '{"version":3}');
  assert.deepEqual(new Uint8Array(await files.get("media.bin").arrayBuffer()), data);
});

test("project ZIP worker supports compressed media and rejects malformed archives", async () => {
  const bytes = new TextEncoder().encode("media".repeat(100_000));
  const archive = zipSync({ "media.txt": bytes });
  const files = await readZip(new Blob([archive]));
  assert.equal((await files.get("media.txt").text()).length, bytes.length);
  await assert.rejects(readZip(new Blob(["not a zip"])));
});

test("project ZIP creation rejects duplicate names before overwriting media", async () => {
  await assert.rejects(createZip([
    { name: "media.bin", data: "one" },
    { name: "media.bin", data: "two" },
  ]), /重复文件名/);
});

test("project ZIP import rejects excessive declared output before decompression", async () => {
  const archive = zipSync({ "media.txt": new TextEncoder().encode("small") });
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = 0; offset <= archive.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, MAX_ZIP_BYTES + 1, true);
      break;
    }
  }
  await assert.rejects(readZip(new Blob([archive])), /解压后大小/);
});

test("project ZIP import rejects stored entries with inconsistent size declarations", async () => {
  for (const declaredSize of [1, 101]) {
    const archive = zipSync({ "media.bin": new Uint8Array(100) }, { level: 0 });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const directoryOffset = view.getUint32(archive.byteLength - 6, true);
    assert.equal(view.getUint32(directoryOffset, true), 0x02014b50);
    view.setUint32(directoryOffset + 24, declaredSize, true);
    await assert.rejects(readZip(new Blob([archive])), /媒体大小不符/);
  }
});

test("project ZIP import rejects oversized files before reading their contents", async () => {
  await assert.rejects(readZip({
    size: MAX_ZIP_BYTES + 1,
    arrayBuffer() { assert.fail("oversized archive must not be read"); },
  }), /大小不能超过/);
});
