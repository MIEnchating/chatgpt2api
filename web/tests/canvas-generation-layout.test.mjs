import assert from "node:assert/strict";
import test from "node:test";

import { canvasGenerationActiveNodeID, placeCanvasGenerationResultNodes, setCanvasConfigGenerationStatus } from "../src/app/canvas/canvas-generation-layout.ts";

test("specialized image tools select their result while ordinary generation keeps the source active", () => {
  assert.equal(canvasGenerationActiveNodeID("source", "result", true, false), "source");
  assert.equal(canvasGenerationActiveNodeID("source", "result", true, true), "result");
  assert.equal(canvasGenerationActiveNodeID("source", "source", false, true), "source");
});

function node(id, type = "image", values = {}) {
  return { id, type, x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, ...values };
}

test("a blank image is replaced in place and batch children are appended", () => {
  const source = node("source", "text");
  const blank = node("blank");
  const tail = node("tail", "text");
  const root = node("blank", "image", { generation_status: "loading", batch_child_ids: ["child"] });
  const child = node("child", "image", { batch_root_id: "blank" });

  assert.deepEqual(
    placeCanvasGenerationResultNodes([source, blank, tail], blank.id, [root, child]).map((item) => item.id),
    ["source", "blank", "tail", "child"],
  );
});

test("downstream generation results are appended without moving the source node", () => {
  const source = node("config", "config");
  const tail = node("tail", "text");
  const result = node("result");
  assert.deepEqual(
    placeCanvasGenerationResultNodes([source, tail], source.id, [result]).map((item) => item.id),
    ["config", "tail", "result"],
  );
});

test("replacing a failed batch removes stale children while preserving root order", () => {
  const root = node("root", "image", { batch_child_ids: ["old-a", "old-b"] });
  const nextRoot = node("root", "image", { generation_status: "loading" });
  const nodes = [node("before", "text"), root, node("old-a"), node("between", "text"), node("old-b")];
  assert.deepEqual(
    placeCanvasGenerationResultNodes(nodes, root.id, [nextRoot], new Set(["old-a", "old-b"])).map((item) => item.id),
    ["before", "root", "between"],
  );
});

test("only configuration nodes receive generation lifecycle status", () => {
  const config = node("config", "config");
  const image = node("image");
  const loading = setCanvasConfigGenerationStatus([config, image], "config", "loading", "", "task-1");
  assert.deepEqual(loading[0], { ...config, generation_status: "loading", generation_error: "", task_id: "task-1" });
  assert.equal(loading[1], image);

  const failed = setCanvasConfigGenerationStatus(loading, "config", "error", "生成失败", "task-1");
  assert.equal(failed[0].generation_status, "error");
  assert.equal(failed[0].generation_error, "生成失败");
});

test("script production arrangement pairs shots, keeps materials as inputs, and isolates unrelated nodes", async () => {
 const {arrangeCanvasAgentNodes}=await import("../src/app/canvas/agent/canvas-agent-generation.ts");
 const nodes=[node("script","script",{script_project:{assets:[{image_node_id:"hero"}],shots:[{image_node_id:"f1",video_node_id:"v1"},{image_node_id:"f2",video_node_id:"v2"}],merged_video_node_id:"movie"}}),node("hero"),node("f1"),node("v1","video"),node("f2"),node("v2","video"),node("movie","video"),node("unrelated","text",{x:9000,y:9000})];
 const result=arrangeCanvasAgentNodes(nodes,nodes.slice(0,-1).map(node=>node.id)).nodes;
 const byID=new Map(result.map(node=>[node.id,node]));
 assert.ok(byID.get("hero").x<byID.get("script").x);
 for(const [frame,video] of [["f1","v1"],["f2","v2"]]){assert.equal(byID.get(frame).y,byID.get(video).y);assert.ok(byID.get(frame).x<byID.get(video).x);}
 assert.ok(byID.get("movie").x>byID.get("v1").x);
 assert.deepEqual(byID.get("unrelated"),nodes.at(-1));
 for(let i=0;i<result.length-1;i++)for(let j=i+1;j<result.length-1;j++){const a=result[i],b=result[j];assert.ok(!(a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y),`${a.id} overlaps ${b.id}`);}
});
