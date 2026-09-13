import { expect, test } from "bun:test";
import { nextRelayTokenNameForModel, relayTokenNameForModel } from "../src/lib/relay-token-selection.ts";

test("new tasks rotate only through keys that support the requested model", () => {
 const names = ["text-only", "shared-a", "shared-b"];
 const models = { "text-only": ["chat"], "shared-a": ["image"], "shared-b": ["image", "chat"] };
 let previous = "";
 const chosen = [];
 for (let i = 0; i < 5; i++) {
  previous = nextRelayTokenNameForModel(names, "IMAGE", models, previous);
  chosen.push(previous);
  expect(relayTokenNameForModel(names, "image", models)).toBe("shared-a");
 }
 expect(chosen).toEqual(["shared-a", "shared-b", "shared-a", "shared-b", "shared-a"]);
 expect(nextRelayTokenNameForModel(names, "missing", models, previous)).toBe("");
});

test("rotation handles removed keys, failed model lists, and cleared selection", () => {
 expect(nextRelayTokenNameForModel(["a", "b"], "image", {a:["image"],b:[]}, "a")).toBe("a");
 expect(nextRelayTokenNameForModel(["b", "c"], "image", {b:["image"],c:["image"]}, "a")).toBe("b");
 expect(nextRelayTokenNameForModel([], "image", {}, "a")).toBe("");
});
