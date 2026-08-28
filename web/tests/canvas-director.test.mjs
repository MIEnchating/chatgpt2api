import assert from "node:assert/strict";
import test from "node:test";

import {
  fitDirectorVideoNodeSize,
  getNextDirectorOutputY,
} from "../src/app/canvas/canvas-director-output.ts";

const director = {
  id: "director",
  type: "director",
  x: 100,
  y: 200,
  width: 360,
  height: 320,
  scale_x: 1,
  scale_y: 1,
};

test("director output placement only counts connected image and video nodes", () => {
  const nodes = [
    director,
    { id: "image", type: "image", x: 560, y: 280, width: 300, height: 180, scale_x: 1, scale_y: 1 },
    { id: "video", type: "video", x: 560, y: 500, width: 320, height: 180, scale_x: 1, scale_y: 1 },
    { id: "audio", type: "audio", x: 560, y: 900, width: 340, height: 160, scale_x: 1, scale_y: 1 },
    { id: "unconnected", type: "image", x: 560, y: 1200, width: 300, height: 180, scale_x: 1, scale_y: 1 },
  ];
  const connections = [
    { id: "image-edge", from_node_id: "director", to_node_id: "image" },
    { id: "video-edge", from_node_id: "director", to_node_id: "video" },
    { id: "audio-edge", from_node_id: "director", to_node_id: "audio" },
  ];

  assert.equal(getNextDirectorOutputY(director, nodes, connections), 716);
});

test("director output placement starts at the director top without media outputs", () => {
  assert.equal(getNextDirectorOutputY(director, [director], []), director.y);
});

test("director videos fit their real dimensions within 420 by 420", () => {
  assert.deepEqual(fitDirectorVideoNodeSize(1920, 1080), { width: 420, height: 236.25 });
  assert.deepEqual(fitDirectorVideoNodeSize(1080, 1920), { width: 236.25, height: 420 });
  assert.deepEqual(fitDirectorVideoNodeSize(320, 240), { width: 320, height: 240 });
});
