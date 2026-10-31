import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const httpCalls = [];
const fetchCalls = [];
let fetchImpl = async () => {
  throw new Error("fetch stub not configured");
};

function loadSource(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports,
    require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    ...globals,
  }, { filename: path });
  return exports;
}

const api = loadSource("../src/lib/api.ts", {
  "@/lib/request": {
    httpRequest: async (path, options) => {
      httpCalls.push({ path, options });
      return { id: "task" };
    },
    httpRequestEventStream: async () => {},
  },
}, {
  fetch: (url, init) => {
    fetchCalls.push({ url, signal: init?.signal });
    return fetchImpl(url, init);
  },
  FormData,
  File,
  Blob,
  URLSearchParams,
});

const UNUSED_OPTIONAL_ARGS = Array.from({ length: 11 }, () => undefined);

function createEditTask(toolOptions, requestOptions) {
  return api.createImageEditTask(
    "task",
    [new File(["x"], "a.png", { type: "image/png" })],
    "prompt",
    ...UNUSED_OPTIONAL_ARGS,
    toolOptions,
    undefined,
    undefined,
    undefined,
    undefined,
    requestOptions,
  );
}

test("image edit mask download is cancelled together with the task request", async () => {
  httpCalls.length = 0;
  fetchCalls.length = 0;
  fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const controller = new AbortController();
  const pending = createEditTask({ inputImageMask: "blob:mask" }, { signal: controller.signal });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].signal, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(httpCalls.length, 0);
});

test("image edit uploads the mask and submits the task when it is not cancelled", async () => {
  httpCalls.length = 0;
  fetchCalls.length = 0;
  fetchImpl = async () => new Response(new Blob(["mask"], { type: "image/png" }));
  await createEditTask({ inputImageMask: "blob:mask" }, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].signal, undefined);
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].path, "/api/creation-tasks/image-edits");
  assert.ok(httpCalls[0].options.body.get("mask"));
});
