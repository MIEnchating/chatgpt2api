import { expect, test } from "bun:test";
import { prepareImageEditReferences } from "../src/lib/image-edit-references.ts";

test("Chat and Responses reuse remote references in mixed input order", async () => {
  for (const mode of ["chat", "responses"]) {
    const fetched = [];
    const refs = await prepareImageEditReferences([
      "https://cdn.example.com/a.png", "/api/files/private/content", "https://cdn.example.com/c.png",
    ], mode, undefined, async (url) => { fetched.push(url); return new Blob(["png"], { type: "image/png" }); });
    expect(fetched).toEqual(["/api/files/private/content"]);
    expect(refs[0]).toBe("https://cdn.example.com/a.png");
    expect(refs[1]).toBeInstanceOf(File);
    expect(refs[2]).toBe("https://cdn.example.com/c.png");
  }
});

test("Images mode uploads every reference; private and authenticated URLs are never forwarded", async () => {
  for (const [mode, urls] of [
    ["images", ["https://cdn.example.com/a.png"]],
    ["responses", ["http://127.0.0.1/a.png", "https://app.example.com/api/files/private/content"]],
  ]) {
    const fetched = [];
    const refs = await prepareImageEditReferences(urls, mode, undefined, async (url) => { fetched.push(url); return new Blob(["png"], { type: "image/png" }); });
    expect(fetched).toEqual(urls);
    expect(refs.every((ref) => ref instanceof File)).toBe(true);
  }
});

test("cancelled preparation cannot submit references", async () => {
  const controller = new AbortController();
  await expect(prepareImageEditReferences(["/api/files/a/content"], "chat", controller.signal, async () => {
    controller.abort();
    return new Blob(["png"], { type: "image/png" });
  })).rejects.toThrow();
});
