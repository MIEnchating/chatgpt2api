import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { formatCanvasVideoTime } from "../src/app/canvas/canvas-video-time.ts";

test("canvas video preview formats time like the reference player", () => {
  assert.equal(formatCanvasVideoTime(Number.NaN), "0:00");
  assert.equal(formatCanvasVideoTime(0), "0:00");
  assert.equal(formatCanvasVideoTime(65.9), "1:05");
  assert.equal(formatCanvasVideoTime(3_661), "1:01:01");
});

test("node playback and preview controls keep their clicks outside node dragging", () => {
  const source = ts.createSourceFile("canvas-video-player.tsx", readFileSync(new URL("../src/app/canvas/canvas-video-player.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "CanvasVideoNodePlayer");
  const playback = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "toggleVideoPlayback");
  const code = ts.transpileModule(playback.getText(source) + "\n" + component.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const calls = [];
  const video = { paused: true, play() { calls.push("play"); this.paused = false; }, pause() { calls.push("pause"); this.paused = true; } };
  const dependencies = {
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useRef: () => ({ current: video }), useState: (initial) => [initial, () => {}], useEffect: () => {},
    TooltipButton: "TooltipButton", Slider: "Slider", Badge: "Badge", Play: "Play", Pause: "Pause", Maximize2: "Maximize2", cn: (...values) => values.join(" "),
  };
  const render = new Function(...Object.keys(dependencies), `${code}; return CanvasVideoNodePlayer;`)(...Object.values(dependencies));
  const tree = render({ src: "fixture.webm", title: "Video", selected: true, onOpen: () => calls.push("preview"), onMediaLoad() {} });
  const controls = tree.children.filter((child) => child?.type === "TooltipButton");
  const play = controls.find((control) => control.props["aria-label"] === "播放");
  const preview = controls.find((control) => control.props["aria-label"] === "放大预览");
  for (const control of [play, preview]) assert.ok(Object.hasOwn(control.props, "data-canvas-no-pan"), "node drag must not capture a media control's pointer");
  const click = { stopPropagation() {} };
  play.props.onClick(click);
  play.props.onClick(click);
  preview.props.onClick(click);
  assert.deepEqual(calls, ["play", "pause", "pause", "preview"]);
});

test("video play cancellation is quiet while actual playback failures remain visible", async () => {
  const source = ts.createSourceFile("canvas-video-player.tsx", readFileSync(new URL("../src/app/canvas/canvas-video-player.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helper = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "toggleVideoPlayback");
  const code = ts.transpileModule(helper.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const messages = [];
  const toggle = new Function("toast", `${code}; return toggleVideoPlayback;`)({ error: (message) => messages.push(message) });
  await toggle(null);
  await toggle({ paused: true, play: async () => { throw new DOMException("Interrupted by pause", "AbortError"); } });
  assert.deepEqual(messages, []);
  await toggle({ paused: true, play: async () => { throw new DOMException("Unsupported codec", "NotSupportedError"); } });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /视频播放失败/);
  let pauses = 0;
  await toggle({ paused: false, pause: () => pauses++, play: () => assert.fail("must pause current playback") });
  assert.equal(pauses, 1);
  assert.equal(messages.length, 1);
});
