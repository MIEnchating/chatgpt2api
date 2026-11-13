import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasScriptNavigation } from "../src/app/canvas/canvas-script-navigation.tsx";
import { scriptMediaStatus } from "../src/app/canvas/canvas-script.ts";

test("script navigation uses current shot order and bindings, disables missing or wrong media, and identifies outdated results", () => {
  const project = { assets: [], shots: [
    { id: "second-authored-shot", seconds: 15, image_node_id: "current-image", video_node_id: "current-video", video_outdated: true },
    { id: "first-authored-shot", seconds: 10, image_node_id: "missing", video_node_id: "wrong-type" },
  ], merged_video_node_id: "movie", merged_video_outdated: true };
  const script = { id: "script", title: "当前短剧", type: "script", script_project: project };
  const nodes = [script,
    { id: "current-image", type: "image", url: "/current.png", generation_status: "success" },
    { id: "current-video", type: "video", url: "/current.mp4", generation_status: "success" },
    { id: "wrong-type", type: "image" },
    { id: "old-image", type: "image", url: "/history.png" },
    { id: "old-video", type: "video", url: "/history.mp4" },
    { id: "movie", type: "video", url: "/movie.mp4" },
  ];
  const before = structuredClone(nodes);
  const html = renderToStaticMarkup(createElement(CanvasScriptNavigation, { scripts: [script], nodes, onFitScript() {}, onFocusNode() {} }));
  assert.match(html, /aria-label="当前制作导航"/);
  assert.match(html, /第 1 镜 · 15 秒/);
  assert.match(html, /第 2 镜 · 10 秒/);
  assert.deepEqual([...html.matchAll(/data-canvas-navigation-node="([^"]+)"/g)].map(match => match[1]), ["current-image", "current-video", "movie"]);
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  for (const label of ["定位当前短剧：第 2 镜分镜", "定位当前短剧：第 2 镜视频"]) {
    const button = buttons.find(value => value.includes(`aria-label="${label}"`));
    assert.match(button, /disabled=""/);
    assert.match(button, /未关联/);
  }
  assert.match(buttons.find(value => value.includes('data-canvas-navigation-node="current-video"')), /待更新/);
  assert.match(buttons.find(value => value.includes('data-canvas-navigation-node="movie"')), /待更新/);
  assert.doesNotMatch(html, /old-image|old-video|history\.png|history\.mp4/);
  assert.deepEqual(nodes, before);
});

test("navigation and media dialog share task status semantics without treating unresolved tasks as complete", () => {
  assert.equal(scriptMediaStatus(undefined), "未关联");
  assert.equal(scriptMediaStatus(undefined, true), "未关联");
  assert.equal(scriptMediaStatus({ generation_status: "loading", generation_progress: 60 }), "生成中");
  assert.equal(scriptMediaStatus({ generation_status: "error", generation_error: "Upstream failed" }), "生成失败");
  assert.equal(scriptMediaStatus({ task_id: "accepted", generation_status: "idle" }), "待同步");
  assert.equal(scriptMediaStatus({ generation_status: "success" }), "待生成");
  assert.equal(scriptMediaStatus({ url: "/result.png", generation_status: "success" }), "已完成");
  assert.equal(scriptMediaStatus({ url: "/result.png", generation_status: "success" }, true), "待更新");
});
