import assert from "node:assert/strict";
import test from "node:test";
import { imageSourceToFile } from "../src/lib/image-source-file.ts";

const unusedLoader = async () => {
  throw new Error("loader must not be called for data URLs");
};

test("base64 data URLs decode into a file with the embedded mime type", async () => {
  const file = await imageSourceToFile("data:image/png;base64,aGk=", "a.png", undefined, unusedLoader);
  assert.equal(file.name, "a.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 2);
});

test("malformed base64 data URLs report an invalid reference instead of a raw decoder error", async () => {
  await assert.rejects(
    imageSourceToFile("data:image/png;base64,@@@", "a.png", undefined, unusedLoader),
    { message: "参考图数据无效" },
  );
});

test("non-base64 data URLs report an invalid reference", async () => {
  await assert.rejects(
    imageSourceToFile("data:image/svg+xml,%3Csvg%3E", "a.svg", undefined, unusedLoader),
    { message: "参考图数据无效" },
  );
});

test("remote sources are loaded through the injected loader", async () => {
  const file = await imageSourceToFile(" /images/a.png ", "a.png", "image/png", async (source) => {
    assert.equal(source, "/images/a.png");
    return new Blob(["x"], { type: "image/webp" });
  });
  assert.equal(file.type, "image/webp");
});
