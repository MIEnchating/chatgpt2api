import assert from "node:assert/strict";
import test from "node:test";
import { contentStableNodes } from "../src/app/canvas/use-content-stable-nodes.ts";

test("canvas content indexes reuse the node snapshot across geometry-only changes", () => {
  const original = [{ id: "node", type: "image", x: 10, y: 20, width: 300, height: 200, title: "Poster", url: "/poster.png" }];
  const moved = [{ ...original[0], x: 100, y: 120 }];
  assert.equal(contentStableNodes(original, moved), original);
  assert.equal(contentStableNodes(original, [{ ...moved[0], title: "New poster" }])[0].title, "New poster");
  assert.notEqual(contentStableNodes(original, [{ ...moved[0], title: "New poster" }]), original);
});
