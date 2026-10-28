import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const controls = source("app/canvas/canvas-workspace-controls.tsx");
const page = source("app/canvas/page.tsx");
const engine = source("app/canvas/canvas-engine.tsx");
const toolbar = source("app/canvas/canvas-node-toolbar.tsx");
const sidePanel = source("app/canvas/canvas-side-panel.tsx");
const agent = source("app/canvas/canvas-agent-panel.tsx");
const picker = source("app/canvas/canvas-asset-picker.tsx");

test("canvas dock stays centered across the entire workspace", () => {
  assert.match(controls, /CANVAS_DOCK_BREAKPOINT = 560/);
  assert.match(controls, /props\.width < CANVAS_DOCK_BREAKPOINT/);
  assert.match(controls, /bottom-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/);
  assert.match(page, /const controlsWidth = workspaceWidth/);
  assert.doesNotMatch(page, /controlsRightInset|inspectorWidth/);
  assert.doesNotMatch(page, /workspaceWidth < 768 && sidePanel\.open/);
  assert.match(page, /<\/div>\s*\{showWorkspaceControls \? <div data-canvas-workspace-overlay/);
  assert.match(page, /--canvas-dock-clearance/);
  for (const panel of [sidePanel, agent]) {
    assert.match(panel, /bottom: "var\(--canvas-dock-clearance\)"/);
  }
  assert.match(toolbar, /bottom-\[var\(--canvas-dock-clearance\)\]/);
});

test("node editing follows the selected node and keeps the Agent available", () => {
  assert.match(engine, /<CanvasNodeToolbar key=\{actionNode.id\}[^>]*expanded=\{editorOpen\}/);
  assert.match(engine, /<CanvasNodeEditor/);
  assert.doesNotMatch(engine, /data-canvas-node-drawer|nodePanelReturnsToAgent/);
  assert.match(page, /open=\{agentOpen\}/);
  assert.doesNotMatch(page, /agentOpen && !panelNodeID/);
  const activate = page.slice(page.indexOf("function activateNode("), page.indexOf("function toggleCanvasFreeResize("));
  assert.match(activate, /setAgentReferenceNodeClick/);
  assert.doesNotMatch(activate, /if \(agentOpen\)|setAgentOpen\(false\)/);
});

test("the mobile Agent provides an outside target that closes the panel", () => {
  assert.match(agent, /data-canvas-agent-backdrop[\s\S]*?className="[^"\n]*inset-0[^"\n]*md:hidden[^"\n]*"[\s\S]*?aria-label="关闭 Agent"[\s\S]*?onClick=\{onClose\}/);
});

test("canvas node, asset, and prompt search share clearable, keyboard-aware search controls", () => {
  assert.equal((sidePanel.match(/<SearchInput/g) || []).length, 3);
  assert.match(sidePanel, /role="status">\{filteredNodes\.length\} 个结果/);
  assert.match(sidePanel, /aria-pressed=\{selected\}/);
  assert.match(sidePanel, /点击插入，或将素材拖到画布指定位置/);
});

test("asset picker keeps its results scrollable and distinguishes empty filters from an empty library", () => {
  assert.match(picker, /h-\[min\(820px,92dvh\)\]/);
  assert.match(picker, /<SearchInput/);
  assert.match(picker, /aria-pressed=\{kind === item\.value\}/);
  assert.match(picker, /role="status">\{filtered\.length\} 个结果/);
  assert.match(picker, /没有匹配的素材/);
  assert.match(picker, /暂无可用素材/);
  assert.match(picker, /focus-visible:ring-2/);
});

test("a newer pointer or keyboard action cancels delayed node title activation", () => {
  for (const eventName of ["pointerdown", "keydown"]) {
    assert.ok(engine.includes(`window.addEventListener("${eventName}", cancelTitleActivation, true)`));
    assert.ok(engine.includes(`window.removeEventListener("${eventName}", cancelTitleActivation, true)`));
  }
  assert.match(engine, /useEffect\(\(\) => cancelTitleActivation, \[cancelTitleActivation\]\)/);
  assert.match(engine, /window\.setTimeout\(\(\) => \{\s*cancelTitleActivation\(\);\s*onActivate\(node\.id\)/);
});
