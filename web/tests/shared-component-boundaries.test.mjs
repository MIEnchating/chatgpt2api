import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { ScrollArea } from "../src/components/ui/scroll-area.tsx";
import { LabeledField } from "../src/components/labeled-field.tsx";
import { IMAGE_ASPECT_RATIO_PRESET_OPTIONS } from "../src/lib/image-options.ts";
import * as imageOptions from "../src/lib/image-options.ts";

function hooks() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const react = {
    forwardRef: (render) => render,
    useId: () => `test-${cursor++}`,
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useMemo: (create) => create(),
    useCallback: (callback) => callback,
    useEffect: (effect) => { effects.push(effect); },
    useLayoutEffect: () => {},
    useImperativeHandle: () => {},
    useSyncExternalStore: (_, snapshot) => snapshot(),
  };
  return {
    react,
    get effects() { return effects; },
    render(component, props = {}) {
      cursor = 0;
      effects = [];
      return component(props);
    },
  };
}

function loadSource(path, imports = {}, globals = {}, extra = "") {
  const source = readFileSync(new URL(path, import.meta.url), "utf8") + extra;
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const jsx = (type, props, key) => ({ type, props, key });
  const placeholders = new Proxy({}, { get: (_, name) => String(name) });
  vm.runInNewContext(output, {
    exports,
    require(name) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" "), ...imports[name] };
      return imports[name] ?? placeholders;
    },
    ...globals,
  }, { filename: path });
  return exports;
}

function descendants(node) {
  if (!node || typeof node !== "object") return [];
  const children = node.type === "LabeledField" && typeof node.props?.children === "function"
    ? node.props.children("test-field")
    : node.props?.children;
  return [node, ...[children].flat(Infinity).flatMap(descendants)];
}

function event(target, currentTarget = target, key = "ArrowDown") {
  return { target, currentTarget, key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("reference media attachments separate preview, removal and uploading states", () => {
  for (const kind of ["image", "video", "audio"]) {
    const state = hooks();
    let removed = 0;
    const { ReferenceMediaCard } = loadSource("../src/components/generation/reference-media-card.tsx", { react: state.react });
    const props = { kind, src: "/isolated-media", label: "参考素材", onRemove: () => removed++ };
    const find = (tree, type) => descendants(tree).find(node => node.type === type);
    let tree = state.render(ReferenceMediaCard, props);
    assert.equal(tree.type, "Attachment");
    assert.equal(tree.props.state, "done");
    find(tree, "AttachmentTrigger").props.onClick();
    tree = state.render(ReferenceMediaCard, props);
    assert.equal(find(tree, "Dialog").props.open, true);
    find(tree, "AttachmentAction").props.onClick();
    assert.equal(removed, 1);
    tree = state.render(ReferenceMediaCard, { ...props, removeDisabled: true });
    assert.equal(find(tree, "AttachmentAction").props.disabled, true);
    tree = state.render(ReferenceMediaCard, { ...props, uploading: true });
    assert.equal(tree.props.state, "uploading");
    assert.equal(tree.props["aria-busy"], true);
    assert.equal(find(tree, "AttachmentTrigger").props.disabled, true);
    assert.equal(find(tree, "AttachmentAction"), undefined);
    assert.ok(find(tree, "Spinner"));
  }
});

test("canvas node reference attachments preserve focus and remove only their own link", () => {
  const state = hooks();
  const focused = [], removed = [];
  const { CanvasNodeReferences } = loadSource("../src/app/canvas/canvas-node-references.tsx", {
    react: state.react,
    "./canvas-config-inputs": { canvasConfigInputLabel: input => `图片${input.nodeID}` },
  });
  const tree = state.render(CanvasNodeReferences, {
    inputs: [{ nodeID: "one", type: "image", title: "参考图", url: "/isolated.png" }, { nodeID: "two", type: "text", title: "文案", text: "创作要求" }],
    allInputs: [], onFocus: id => focused.push(id), onRemove: id => removed.push(id),
  });
  assert.equal(tree.type, "AttachmentGroup");
  const triggers = descendants(tree).filter(node => node.type === "AttachmentTrigger");
  const key = event(null, null, "Enter");
  key.stopPropagation = () => {};
  triggers[0].props.onKeyDown(key);
  assert.equal(key.defaultPrevented, true);
  triggers[1].props.onDoubleClick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(focused, ["one", "two"]);
  const remove = descendants(tree).filter(node => node.type === "AttachmentAction")[1];
  remove.props.onClick({ stopPropagation() {} });
  assert.deepEqual(removed, ["two"]);
  assert.deepEqual(focused, ["one", "two"], "removal must not activate the reference");
});

test("reference upload attachments retain file filtering, limits and the pending lock", async () => {
  const state = hooks();
  const notices = [], uploads = [];
  let finish;
  const { ReferenceFileUpload } = loadSource("../src/components/generation/reference-file-upload.tsx", {
    react: state.react,
    sonner: { toast: { error: message => notices.push(message), info: message => notices.push(message) } },
  });
  const props = { label: "上传参考图", hint: "PNG", accept: "image/png,.png", remaining: 1, onFiles: files => { uploads.push(files); return new Promise(resolve => { finish = resolve; }); } };
  const render = overrides => state.render(ReferenceFileUpload, { ...props, ...overrides });
  let tree = render();
  assert.equal(tree.type, "Attachment");
  assert.equal(tree.props.state, "idle");
  const input = descendants(tree).find(node => node.type === "input");
  const target = { files: [{ name: "one.png", type: "image/png" }, { name: "two.png", type: "image/png" }, { name: "bad.txt", type: "text/plain" }], value: "one.png" };
  input.props.onChange({ target });
  input.props.onChange({ target });
  assert.equal(target.value, "");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].length, 1);
  assert.equal(notices.length, 2);
  tree = render();
  assert.equal(tree.props.state, "uploading");
  assert.equal(descendants(tree).find(node => node.type === "AttachmentTrigger").props.disabled, true);
  finish();
  await flush();
  assert.equal(render().props.state, "idle");
  assert.equal(render({ remaining: 0 }), null);
});

test("studio agent answers use shared input and keep drafts through failed single-flight submissions", async () => {
  const state = hooks();
  const requests = [];
  let settle, fail, resumed = 0, refreshed = 0;
  const run = { status: "waiting", events: [], updatedAt: "2026-11-09T00:00:00Z", result: { question: { text: "需要哪种风格？", callId: "question-1" } } };
  const { StudioAgentProcess } = loadSource("../src/app/image/components/studio-agent-process.tsx", {
    react: state.react,
    "@/components/agent/use-agent-execution": { useAgentExecution: () => ({ run, refresh: () => refreshed++ }) },
    "@/lib/request": { httpRequest: (url, options) => {
      requests.push({ url, options });
      return new Promise((resolve, reject) => { settle = resolve; fail = () => reject(new Error("提交失败，请重试")); });
    } },
  }, { Error });
  const render = () => state.render(StudioAgentProcess, { runId: "run/1", needsResult: false, onResume: () => resumed++ });
  const find = (tree, type) => descendants(tree).find(node => node.type === type);
  const submit = tree => find(tree, "form").props.onSubmit({ preventDefault() {} });
  let tree = render();
  assert.ok(find(tree, "PromptInput"));
  assert.ok(find(tree, "PromptInputFooter"));
  assert.equal(find(tree, "InputGroupTextarea").props.maxLength, 12000);
  submit(tree);
  assert.equal(requests.length, 0, "empty answers cannot be submitted even through the form handler");
  find(tree, "InputGroupTextarea").props.onChange({ target: { value: "  水彩风格  " } });
  tree = render();
  submit(tree);
  submit(tree);
  assert.equal(requests.length, 1, "duplicate submissions before a render share the same pending action");
  assert.equal(requests[0].url, "/api/agent-runs?id=run%2F1");
  assert.equal(requests[0].options.body.callId, "question-1");
  assert.equal(requests[0].options.body.answer, "水彩风格");
  tree = render();
  assert.equal(find(tree, "InputGroupTextarea").props.disabled, true);
  assert.equal(find(tree, "PromptInputSubmit").props.disabled, true);
  assert.equal(find(tree, "PromptInputSubmit").props["aria-busy"], true);
  fail();
  await flush();
  tree = render();
  assert.equal(find(tree, "InputGroupTextarea").props.value, "  水彩风格  ");
  assert.equal(find(tree, "PromptInputSubmit").props.disabled, false);
  assert.ok(descendants(tree).some(node => node.type === "AlertDescription" && node.props.children === "提交失败，请重试"));
  assert.equal(resumed, 0);
  submit(tree);
  assert.equal(requests.length, 2);
  settle();
  await flush();
  tree = render();
  assert.equal(find(tree, "InputGroupTextarea").props.value, "");
  assert.equal(resumed, 1);
  assert.equal(refreshed, 1);
});

test("studio agent resume without a question preserves its execution API and pending lock", async () => {
  const state = hooks();
  const calls = [];
  let settle, resumed = 0, refreshed = 0;
  const { StudioAgentProcess } = loadSource("../src/app/image/components/studio-agent-process.tsx", {
    react: state.react,
    "@/components/agent/use-agent-execution": { useAgentExecution: () => ({ run: { status: "interrupted", events: [] }, refresh: () => refreshed++ }) },
    "@/lib/agent-executions": { resumeAgentExecution: id => { calls.push(id); return new Promise(resolve => { settle = resolve; }); } },
  });
  const props = { runId: "interrupted-run", needsResult: false, onResume: () => resumed++ };
  const tree = state.render(StudioAgentProcess, props);
  const resume = descendants(tree).find(node => node.type === "Button" && node.props.children === "继续任务");
  resume.props.onClick();
  resume.props.onClick();
  assert.deepEqual(calls, ["interrupted-run"]);
  settle();
  await flush();
  assert.equal(resumed, 1);
  assert.equal(refreshed, 1);
  assert.ok(!descendants(state.render(StudioAgentProcess, props)).some(node => node.type === "PromptInput"));
});

test("studio process separates progress, assistant text and tool events without inventing completion", () => {
  const state = hooks();
  const run = { status: "running", updatedAt: "2026-11-10T00:00:00Z", events: [
    { stage: "retrying", message: "重试模型请求" },
    { stage: "assistant", message: "根据参考图继续制作" },
    { stage: "tool", tool: "get_history", message: "读取历史", status: "success" },
    { stage: "tool", tool: "set_generation_parameters", message: "调整参数", status: "running", input: { n: 2 } },
    { stage: "tool", tool: "generate_image", message: "生成图片", status: "error", output: "request failed" },
    { stage: "tool", tool: "get_generation_config", message: "查询配置" },
    { stage: "generating", message: "正在处理任务" },
  ] };
  const { StudioAgentProcess } = loadSource("../src/app/image/components/studio-agent-process.tsx", {
    react: state.react,
    "@/components/agent/use-agent-execution": { useAgentExecution: () => ({ run }) },
  });
  const render = () => descendants(state.render(StudioAgentProcess, { runId: "run", needsResult: false, onResume() {} }));
  let nodes = render();
  let tools = nodes.filter(node => node.type === "Tool");
  assert.deepEqual(tools.map(node => node.props.title), ["读取历史", "调整参数", "生成图片", "查询配置"]);
  assert.deepEqual(tools.map(node => node.props.state), ["output-available", "input-available", "output-error", "pending"]);
  assert.ok(nodes.some(node => node.type === "TraceTitle" && node.props.children === "重试模型请求"));
  assert.ok(nodes.some(node => node.type === "Message" && node.props.from === "assistant"));
  assert.ok(nodes.some(node => node.type === "MessageResponse" && node.props.children === "根据参考图继续制作"));
  assert.ok(nodes.some(node => node.type === "ToolDetails" && node.props.input?.n === 2));
  assert.ok(!nodes.some(node => node.props?.children === "正在处理任务"));
  run.status = "waiting";
  tools = render().filter(node => node.type === "Tool");
  assert.equal(tools[1].props.state, "pending");
  run.status = "cancelled";
  tools = render().filter(node => node.type === "Tool");
  assert.equal(tools[1].props.state, "output-denied");
  assert.equal(tools[1].props.statusLabel, "已停止");
});

test("director workspace uses shared modal semantics and keeps the embedded session boundary", () => {
  const state = hooks();
  const { CanvasDirector } = loadSource("../src/app/canvas/canvas-director.tsx", { react: state.react });
  let closed = 0;
  const root = state.render(CanvasDirector, { nodeId: "director", panoramas: [], onClose: () => closed++ });
  assert.equal(root.type, "Dialog");
  root.props.onOpenChange(true);
  assert.equal(closed, 0);
  root.props.onOpenChange(false);
  assert.equal(closed, 1);
  const nodes = descendants(root);
  const content = nodes.find(node => node.type === "DialogContent");
  assert.ok(descendants(content).some(node => node.type === "DialogTitle"));
  assert.ok(descendants(content).some(node => node.type === "DialogDescription"));
  assert.equal(nodes.find(node => node.type === "iframe").props.src, "/director/index.html");
});

test("command dialogs keep their accessible title and description inside the modal content", () => {
  const { CommandDialog } = loadSource("../src/components/ui/command.tsx");
  const root = CommandDialog({ title: "查找操作", description: "输入关键词查找操作", children: "commands" });
  const content = descendants(root).find(node => node.type === "DialogContent");
  assert.ok(descendants(content).some(node => node.type === "DialogTitle" && node.props.children === "查找操作"));
  assert.ok(descendants(content).some(node => node.type === "DialogDescription" && node.props.children === "输入关键词查找操作"));
});

function modelPickerFixture(props = {}) {
  const state = hooks();
  const { ModelPicker } = loadSource("../src/components/model-picker.tsx", {
    react: state.react,
    "@/lib/model-groups": { groupModelsByFamily: options => [{ name: "Models", options }] },
  });
  const changes = [], openings = [];
  const defaults = { label: "图片模型", value: "image-a", options: [" image-a ", "image-a", "", { value: "image-b", label: "模型 B" }], onValueChange: value => changes.push(value), onOpenChange: open => openings.push(open) };
  return { state, changes, openings, render: (next = {}) => state.render(ModelPicker, { ...defaults, ...props, ...next }) };
}

test("shared AI model selection normalizes options without replacing unavailable values", () => {
  const fixture = modelPickerFixture();
  const tree = fixture.render();
  const nodes = descendants(tree);
  assert.equal(tree.type, "ModelSelector");
  assert.deepEqual(nodes.filter(node => node.type === "ModelSelectorItem").map(node => node.props.value), ["image-a", "image-b"]);
  assert.equal(nodes.find(node => node.type === "ModelSelectorItem").props["data-checked"], true);
  assert.equal(nodes.find(node => node.type === "Button").props.disabled, false);
  const empty = descendants(fixture.render({ options: [] }));
  assert.equal(empty.find(node => node.type === "Button").props.disabled, true);
  assert.equal(empty.find(node => node.type === "ModelSelectorName").props.children, "暂无可用模型");
  const missing = descendants(fixture.render({ value: "removed-model" }));
  assert.equal(missing.find(node => node.type === "ModelSelectorName").props.children, "选择模型");
  assert.equal(missing.some(node => node.type === "ModelSelectorItem" && node.props["data-checked"]), false);
  assert.deepEqual(fixture.changes, [], "rendering never silently changes the configured model");
});

test("AI model selection closes after selection and preserves disabled and dismissal boundaries", () => {
  const fixture = modelPickerFixture({ isModelDisabled: value => value === "image-a", renderDescription: value => "报价 " + value });
  let tree = fixture.render();
  tree.props.onOpenChange(true);
  tree = fixture.render();
  assert.equal(tree.props.open, true);
  let items = descendants(tree).filter(node => node.type === "ModelSelectorItem");
  items[0].props.onSelect();
  assert.deepEqual(fixture.changes, []);
  assert.equal(fixture.render().props.open, true);
  items[1].props.onSelect();
  assert.deepEqual(fixture.changes, ["image-b"]);
  assert.equal(fixture.render().props.open, false);
  assert.deepEqual(fixture.openings, [true, false]);
  tree = fixture.render({ disabled: true });
  tree.props.onOpenChange(true);
  items = descendants(tree).filter(node => node.type === "ModelSelectorItem");
  items[1].props.onSelect();
  assert.deepEqual(fixture.changes, ["image-b"]);
  assert.equal(fixture.render({ disabled: true }).props.open, false);
  assert.ok(descendants(fixture.render()).some(node => node.props?.children === "报价 image-b"));
});

test("AI model selector keeps accessible naming and search in the anchored popover", () => {
  const { ModelSelectorContent } = loadSource("../src/components/ai-elements/model-selector.tsx");
  const tree = ModelSelectorContent({ title: "图片模型", children: "search and options" });
  const nodes = descendants(tree);
  assert.equal(tree.type, "PopoverContent");
  assert.equal(tree.props["aria-label"], "图片模型");
  assert.ok(nodes.some(node => node.type === "Command" && node.props.children === "search and options"));
});

test("AI suggestions return the original prompt once and respect disabled state", () => {
  const { Suggestion } = loadSource("../src/components/ai-elements/suggestion.tsx");
  const prompts = [];
  const props = { suggestion: "保留原始提示词", onClick: prompt => prompts.push(prompt) };
  const button = Suggestion(props);
  assert.equal(button.props.type, "button");
  assert.equal(button.props.children, props.suggestion);
  button.props.onClick();
  Suggestion({ ...props, disabled: true }).props.onClick();
  assert.deepEqual(prompts, [props.suggestion]);
});

test("agent asset menu hands focus to the selected action and keeps cancellation focus unchanged", () => {
  for (const action of ["upload", "assets"]) {
    const state = hooks();
    const { CanvasAgentAssetMenu } = loadSource("../src/app/canvas/canvas-agent-composer.tsx", { react: state.react });
    const calls = [];
    const root = state.render(CanvasAgentAssetMenu, { disabled: false, onUpload: () => calls.push("upload"), onOpenAssets: () => calls.push("assets") });
    const nodes = descendants(root);
    const content = nodes.find(node => node.type === "DropdownMenuContent");
    const cancelled = event();
    content.props.onCloseAutoFocus(cancelled);
    assert.equal(cancelled.defaultPrevented, false);
    const items = nodes.filter(node => node.type === "DropdownMenuItem");
    items[action === "upload" ? 0 : 1].props.onSelect();
    const selected = event();
    content.props.onCloseAutoFocus(selected);
    assert.equal(selected.defaultPrevented, true);
    assert.deepEqual(calls, [action]);
    root.props.onOpenChange(true);
    const reopened = event();
    content.props.onCloseAutoFocus(reopened);
    assert.equal(reopened.defaultPrevented, false);
  }
});

test("shared mention picker preserves the caret, rejects duplicate selection and lets outside focus move", () => {
  class Target { contains(target) { return target === this; } }
  const state = hooks();
  const { CanvasMentionMenu } = loadSource("../src/app/canvas/canvas-mention-menu.tsx", {
    react: state.react,
  }, { Node: Target });
  const boundary = {};
  const editor = new Target();
  editor.ownerDocument = { activeElement: editor };
  editor.closest = () => boundary;
  const anchor = { x: 25, y: 50 };
  const items = [{ id: "one" }, { id: "two" }];
  const selected = [], moved = [];
  let closed = 0;
  const root = state.render(CanvasMentionMenu, {
    editor, getAnchorRect: () => anchor, items, activeIndex: 1,
    getKey: item => item.id, renderItem: item => item.id,
    onSelect: item => selected.push(item), onClose: () => closed++,
    onActiveIndexChange: index => moved.push(index),
  });
  const nodes = descendants(root);
  const position = nodes.find(node => node.type === "PopoverAnchor").props.virtualRef.current;
  assert.equal(position.contextElement, editor);
  assert.equal(position.getBoundingClientRect(), anchor);
  const surface = nodes.find(node => node.type === "PopoverContent");
  assert.equal(surface.props.collisionBoundary, boundary);
  const pointer = { ...event(), stopPropagation() {} };
  surface.props.onPointerDown(pointer);
  assert.equal(pointer.defaultPrevented, true, "clicking options must preserve the editor selection");
  const inputInteraction = event(editor);
  surface.props.onInteractOutside(inputInteraction);
  assert.equal(inputInteraction.defaultPrevented, true, "typing in the anchor must not dismiss the picker");
  const outsideInteraction = event(new Target());
  surface.props.onInteractOutside(outsideInteraction);
  assert.equal(outsideInteraction.defaultPrevented, false);
  const closeFocus = event();
  surface.props.onCloseAutoFocus(closeFocus);
  assert.equal(closeFocus.defaultPrevented, true, "dismissal must not steal focus from a clicked outside control");
  const escape = event(editor, editor, "Escape");
  surface.props.onEscapeKeyDown(escape);
  assert.equal(escape.defaultPrevented, true, "the editor handles Escape before Radix can clear its state");
  editor.ownerDocument.activeElement = null;
  const menuEscape = event();
  surface.props.onEscapeKeyDown(menuEscape);
  assert.equal(menuEscape.defaultPrevented, false, "Escape outside the editor retains the primitive's dismissal");
  const command = nodes.find(node => node.type === "Command");
  assert.equal(command.props.shouldFilter, false, "retain the domain's candidate filtering");
  assert.equal(command.props.value, "two");
  command.props.onValueChange("one");
  command.props.onValueChange("missing");
  assert.deepEqual(moved, [0]);
  const option = nodes.filter(node => node.type === "CommandItem")[1];
  let scrolled = 0;
  option.props.ref.current = { scrollIntoView: () => scrolled++ };
  for (const effect of state.effects) effect();
  assert.equal(scrolled, 1, "keyboard selection stays visible without moving editor focus");
  option.props.onSelect();
  option.props.onSelect();
  assert.deepEqual(selected, [items[1]]);
  root.props.onOpenChange(true);
  root.props.onOpenChange(false);
  assert.equal(closed, 1);
});

test("resource mention keyboard navigation stays in the editor and respects IME", () => {
  const state = hooks();
  const { CanvasResourceMentionTextarea } = loadSource("../src/app/canvas/canvas-resource-mention-textarea.tsx", {
    react: state.react,
    "@/app/canvas/canvas-resource-mentions": {
      findCanvasResourceMention: () => ({ start: 0, query: "" }),
      filterCanvasResourceMentions: mention => mention ? [{ id: "reference", active: true }] : [],
    },
  });
  const props = { value: "@", references: [], onChange() {} };
  let input = descendants(state.render(CanvasResourceMentionTextarea, props)).find(node => node.type === "InputGroupTextarea");
  input.props.onChange({ target: { value: "@", selectionStart: 1 } });
  input = descendants(state.render(CanvasResourceMentionTextarea, props)).find(node => node.type === "InputGroupTextarea");
  for (const key of ["ArrowDown", "ArrowUp", "Escape"]) {
    let stopped = false;
    const pressed = { ...event({}, {}, key), nativeEvent: {}, stopPropagation() { stopped = true; } };
    input.props.onKeyDown(pressed);
    assert.equal(pressed.defaultPrevented, true);
    assert.equal(stopped, true, `${key} must not reach the enclosing canvas or dialog`);
  }
  const composing = { ...event({}, {}, "Enter"), nativeEvent: { isComposing: true } };
  input.props.onKeyDown(composing);
  assert.equal(composing.defaultPrevented, false);
});

test("returning to a mention editor cannot be dismissed by an earlier blur", () => {
  const state = hooks();
  const delayed = [];
  const { CanvasResourceMentionTextarea } = loadSource("../src/app/canvas/canvas-resource-mention-textarea.tsx", {
    react: state.react,
    "@/app/canvas/canvas-resource-mentions": {
      findCanvasResourceMention: () => ({ start: 0, query: "" }),
      filterCanvasResourceMentions: mention => mention ? [{ id: "reference", active: true }] : [],
    },
  }, { window: { setTimeout: callback => delayed.push(callback) } });
  const props = { value: "@", references: [], onChange() {} };
  const input = descendants(state.render(CanvasResourceMentionTextarea, props)).find(node => node.type === "InputGroupTextarea");
  input.props.ref({});
  input.props.onBlur({});
  input.props.onChange({ target: { value: "@", selectionStart: 1 } });
  for (const callback of delayed) callback();
  assert.equal(descendants(state.render(CanvasResourceMentionTextarea, props)).some(node => node.type === "CanvasMentionMenu"), true);
});

test("closing a composer mention cancels a pending caret update", () => {
  const state = hooks();
  const frames = new Map();
  let nextFrame = 0;
  const { CanvasConfigComposer } = loadSource("../src/app/canvas/canvas-config-composer.tsx", {
    react: state.react,
    "./use-contenteditable-reference-targets": { useContentEditableReferenceTargets: () => [] },
    "@/app/canvas/canvas-contenteditable": {
      serializeContentEditable: () => "@",
      contentEditableTextBeforeCaret: () => "@",
      getContentEditableMentionKeyAction: key => key === "Escape" ? { type: "close" } : null,
    },
    "@/app/canvas/canvas-config-inputs": { canvasConfigInputLabel: () => "文本1" },
  }, {
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const props = { node: { prompt: "@" }, inputs: [], referenceCandidates: [{ nodeID: "one", title: "测试" }], onComposerChange() {} };
  let nodes = descendants(state.render(CanvasConfigComposer, props));
  let editor = nodes.find(node => node.props?.contentEditable);
  editor.props.ref.current = {};
  editor.props.onInput();
  nodes = descendants(state.render(CanvasConfigComposer, props));
  editor = nodes.find(node => node.props?.contentEditable);
  editor.props.onKeyDown({ ...event({}, {}, "ArrowRight"), nativeEvent: {}, stopPropagation() {} });
  editor.props.onKeyDown({ ...event({}, {}, "Escape"), nativeEvent: {}, stopPropagation() {} });
  for (const callback of frames.values()) callback();
  assert.equal(descendants(state.render(CanvasConfigComposer, props)).some(node => node.type === "CanvasMentionMenu"), false);
});

test("config mention selection inserts a serialized token at the caret before connecting its node", () => {
  const state = hooks();
  const calls = [];
  const input = { nodeID: "image-one", type: "image", title: "参考图片" };
  const editor = { childNodes: [{ textContent: "前缀 " }, { textContent: " 后缀" }], contains: target => target === editor };
  const range = {
    commonAncestorContainer: editor,
    insertNode: fragment => editor.childNodes.splice(1, 0, ...fragment.childNodes),
    setStartAfter(node) { assert.equal(node.textContent, " "); },
    collapse(value) { assert.equal(value, true); },
  };
  const selection = { rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange: next => assert.equal(next, range) };
  const { CanvasConfigComposer } = loadSource("../src/app/canvas/canvas-config-composer.tsx", {
    react: state.react,
    "./use-contenteditable-reference-targets": { useContentEditableReferenceTargets: () => [] },
    "@/app/canvas/canvas-contenteditable": {
      removeActiveContentEditableMention: () => calls.push("remove mention"),
      contentEditableTextBeforeCaret: () => "@图片",
      serializeContentEditable: (node, reference) => node.childNodes.map(child => child.textContent ?? reference(child)).join(""),
    },
    "@/app/canvas/canvas-config-inputs": { canvasConfigInputLabel: () => "图片1" },
  }, {
    window: { getSelection: () => selection },
    document: {
      createElement: () => ({ tagName: "SPAN", dataset: {} }),
      createTextNode: textContent => ({ textContent }),
      createDocumentFragment: () => ({ childNodes: [], append(...nodes) { this.childNodes.push(...nodes); } }),
    },
  });
  const props = { node: { prompt: "前缀 @图片 后缀" }, inputs: [], referenceCandidates: [input], onComposerChange: value => calls.push(value), onReferenceSelect: id => calls.push(id) };
  let tree = state.render(CanvasConfigComposer, props);
  const inputElement = descendants(tree).find(node => node.props?.contentEditable);
  inputElement.props.ref.current = editor;
  inputElement.props.onInput();
  tree = state.render(CanvasConfigComposer, props);
  calls.length = 0;
  descendants(tree).find(node => node.type === "CanvasMentionMenu").props.onSelect(input);
  assert.deepEqual(calls, ["remove mention", "前缀 @[node:image-one]  后缀", "image-one"]);
  assert.equal(editor.childNodes[1].dataset.referenceNodeId, "image-one");
  assert.equal(editor.childNodes[1].contentEditable, "false");
});

test("pending references neither duplicate committed tokens nor revive unavailable nodes", () => {
  const state = hooks();
  const layouts = [];
  const references = [
    { id: "image", nodeID: "image", kind: "image", label: "图片1", active: true },
    { id: "audio", nodeID: "audio", kind: "audio", label: "音频1", active: true },
    { id: "gone", nodeID: "gone", kind: "text", label: "文本1", active: false },
  ];
  const committed = { dataset: { refNodeId: "image" } };
  const nodes = [committed];
  const editor = { querySelectorAll: selector => selector.includes("data-pending-reference") ? [] : nodes };
  const { CanvasAgentPromptChipInput } = loadSource("../src/app/canvas/canvas-agent-prompt-chip-input.tsx", {
    react: { ...state.react, useLayoutEffect: (effect, dependencies) => layouts.push({ effect, dependencies }) },
    "./use-contenteditable-reference-targets": { useContentEditableReferenceTargets: () => [] },
    "@/app/canvas/canvas-contenteditable": { appendContentEditableInline: (_, ...children) => nodes.push(...children.filter(child => child.dataset)) },
  }, {
    document: { createElement: () => ({ dataset: {} }), createTextNode: textContent => ({ textContent }) },
  });
  const tree = state.render(CanvasAgentPromptChipInput, { value: "", references, pendingReferences: references, onChange() {} });
  descendants(tree).find(node => node.props?.contentEditable).props.ref.current = editor;
  layouts.find(item => item.dependencies[0] === references).effect();
  assert.deepEqual(nodes.map(node => node.dataset.refNodeId), ["image", "audio"]);
  assert.equal(nodes[1].dataset.pendingReference, "true");
});

test("reference portals follow editor token changes and release their observer on unmount", () => {
  const state = hooks();
  let update, cleanup, observed, mounted = false, disconnected = 0;
  const first = {}, second = {};
  let targets = [first];
  const editor = { querySelectorAll: selector => { assert.equal(selector, "[data-ref-node-id]"); return targets; } };
  const ref = { current: editor };
  const { useContentEditableReferenceTargets } = loadSource("../src/app/canvas/use-contenteditable-reference-targets.ts", {
    react: { ...state.react, useLayoutEffect: effect => { if (!mounted) { mounted = true; cleanup = effect(); } } },
  }, {
    MutationObserver: class {
      constructor(callback) { update = callback; }
      observe(target, options) { observed = { target, options }; }
      disconnect() { disconnected++; }
    },
  });
  const render = () => state.render(() => useContentEditableReferenceTargets(ref, "[data-ref-node-id]"));
  render();
  assert.equal(observed.target, editor);
  assert.equal(observed.options.childList, true);
  assert.equal(observed.options.subtree, true);
  let result = render();
  assert.equal(result[0], first);
  update();
  assert.equal(render(), result, "rendering controls inside a token must not cause a portal update loop");
  targets = [first, second]; update();
  result = render();
  assert.equal(result[1], second);
  targets = [second]; update();
  result = render();
  assert.equal(result.length, 1);
  assert.equal(result[0], second);
  targets = []; update();
  assert.equal(render().length, 0);
  cleanup();
  assert.equal(disconnected, 1);
});

test("attachment controls keep their keyboard actions out of the prompt submission handler", () => {
  const { CanvasAgentAttachmentChip } = loadSource("../src/app/canvas/canvas-agent-attachments.tsx");
  const calls = [];
  const tree = CanvasAgentAttachmentChip({ attachment: { id: "image", title: "图片1", type: "image", url: "/isolated.png" }, onPreview: url => calls.push(url) });
  let stopped = 0;
  tree.props.onKeyDown({ stopPropagation: () => stopped++ });
  const trigger = descendants(tree).find(node => node.type === "AttachmentTrigger");
  trigger.props.onClick({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 2);
  assert.deepEqual(calls, ["/isolated.png"]);
});

test("shared sliders give every focusable thumb its accessible name, description and value text", () => {
  const { Slider } = loadSource("../src/components/ui/slider.tsx", {
    react: { useMemo: (create) => create() },
    "radix-ui": { Slider: { Root: "SliderRoot", Track: "SliderTrack", Range: "SliderRange", Thumb: "SliderThumb" } },
  });
  for (const value of [[2], [1, 3]]) {
    const root = Slider({ value, "aria-label": "视频时长", "aria-labelledby": "duration-label", "aria-describedby": "duration-hint", "aria-valuetext": "2 秒" });
    const thumbs = descendants(root).filter(node => node.type === "SliderThumb");
    assert.equal(thumbs.length, value.length);
    for (const thumb of thumbs) {
      assert.equal(thumb.props["aria-label"], "视频时长");
      assert.equal(thumb.props["aria-labelledby"], "duration-label");
      assert.equal(thumb.props["aria-describedby"], "duration-hint");
      assert.equal(thumb.props["aria-valuetext"], "2 秒");
    }
    assert.equal(root.props["aria-valuetext"], undefined, "value text belongs to the slider control, not its layout wrapper");
  }
});

test("canvas context actions preserve their focus origin before unmounting the selected menu", () => {
  const state = hooks();
  const calls = [];
  const { CanvasRightClickMenu } = loadSource("../src/app/canvas/page.tsx", {
    react: { ...state.react, lazy: () => null },
  }, {
    document: { getElementById: id => ({ focus: () => calls.push(["focus", id]) }) },
  }, "\nexport { CanvasRightClickMenu };\n");
  for (const type of ["canvas", "node"]) {
    calls.length = 0;
    const tree = state.render(CanvasRightClickMenu, {
      triggerID: "canvas-trigger",
      menu: { type },
      onClear: () => calls.push(["dialog", "clear"]),
      onInfo: () => calls.push(["dialog", "info"]),
      onClose() {},
    });
    const item = descendants(tree).find(node => node.type === "ContextMenuItem" && [node.props.children].flat().includes(type === "canvas" ? "清空当前画布" : "节点详情"));
    assert.ok(item);
    item.props.onSelect();
    assert.deepEqual(calls, [["focus", "canvas-trigger"], ["dialog", type === "canvas" ? "clear" : "info"]]);
  }
});

test("dialogs opened from a menu return focus to the persistent menu trigger", () => {
  class Target {
    isConnected = true;
    calls = 0;
    menu = null;
    closest() { return this.menu; }
    focus() { this.calls++; }
  }
  const state = hooks();
  const trigger = new Target(), item = new Target(), dialog = new Target();
  item.menu = { getAttribute: name => name === "aria-labelledby" ? "menu-trigger" : null };
  dialog.ownerDocument = { activeElement: item, body: {}, getElementById: id => id === "menu-trigger" ? trigger : null };
  const { DialogContent } = loadSource("../src/components/ui/dialog.tsx", {
    react: state.react,
    "@/lib/use-overlay-layer": { useOverlayLayer: () => 200, OverlayLayerProvider: "OverlayLayerProvider" },
    "radix-ui": { Dialog: { Content: "DialogPrimitive.Content", Close: "DialogPrimitive.Close" } },
  }, { HTMLElement: Target });
  const content = descendants(state.render(DialogContent)).find(node => node.type === "DialogPrimitive.Content");
  content.props.onOpenAutoFocus(event(dialog, dialog));
  item.isConnected = false;
  content.props.onCloseAutoFocus(event(dialog, dialog));
  assert.equal(trigger.calls, 1);
  assert.equal(item.calls, 0);
});

test("shared dialogs restore focus for controlled openings and respect caller focus ownership", () => {
  class FocusTarget {
    isConnected = true;
    calls = 0;
    closest() { return null; }
    focus() { this.calls++; }
  }
  for (const closePrevented of [false, true]) {
    for (const sourceKind of ["element", "disconnected", "body"]) {
      const state = hooks();
      const source = new FocusTarget();
      const connected = sourceKind !== "disconnected";
      source.isConnected = connected;
      const target = new FocusTarget();
      target.ownerDocument = { activeElement: source, body: sourceKind === "body" ? source : {} };
      const { DialogContent } = loadSource("../src/components/ui/dialog.tsx", {
        react: state.react,
        "@/lib/use-overlay-layer": { useOverlayLayer: () => 200, OverlayLayerProvider: "OverlayLayerProvider" },
        "radix-ui": { Dialog: { Content: "DialogPrimitive.Content", Close: "DialogPrimitive.Close" } },
      }, { HTMLElement: FocusTarget });
      let closeCalls = 0;
      const nodes = descendants(state.render(DialogContent, {
        onCloseAutoFocus: e => { closeCalls++; if (closePrevented) e.preventDefault(); },
      }));
      const content = nodes.find(node => node.type === "DialogPrimitive.Content");
      content.props.onOpenAutoFocus(event(target, target));
      assert.equal(target.calls, 1, "opening focuses the dialog surface");
      const close = event(target, target);
      content.props.onCloseAutoFocus(close);
      assert.equal(closeCalls, 1);
      const restored = sourceKind === "element" && !closePrevented;
      assert.equal(source.calls, restored ? 1 : 0);
      assert.equal(close.defaultPrevented, closePrevented || sourceKind === "element");
    }
  }
});

test("canvas video preview preserves keyboard activation of its nested controls", () => {
  const state = hooks();
  const { CanvasVideoPreview } = loadSource("../src/app/canvas/canvas-video-player.tsx", {
    react: state.react,
    "@/app/canvas/canvas-video-time": { formatCanvasVideoTime: () => "0:00" },
  });
  const nodes = descendants(state.render(CanvasVideoPreview, { src: "/test.mp4", title: "测试视频", onClose() {}, onDownload() {} }));
  const handlers = nodes.flatMap(node => [node.props?.onKeyDownCapture, node.props?.onKeyDown]).filter(Boolean);
  const button = {};
  for (const handler of handlers) {
    const key = { ...event(button, {}, " "), code: "Space", stopPropagation() {} };
    handler(key);
    assert.equal(key.defaultPrevented, false, "Space on a button or slider must keep its own behavior");
  }
});

test("canvas video preview closes once and keeps playback shortcuts on the media surface", () => {
  const state = hooks();
  const { CanvasVideoPreview } = loadSource("../src/app/canvas/canvas-video-player.tsx", {
    react: state.react,
    "@/app/canvas/canvas-video-time": { formatCanvasVideoTime: () => "0:00" },
  });
  let closed = 0, played = 0, paused = 0, downloaded = 0;
  const tree = state.render(CanvasVideoPreview, { src: "/test.mp4", title: "测试视频", onClose: () => closed++, onDownload: () => downloaded++ });
  const nodes = descendants(tree);
  assert.equal(tree.type, "Dialog");
  tree.props.onOpenChange(true);
  assert.equal(closed, 0);
  tree.props.onOpenChange(false);
  assert.equal(closed, 1);
  const video = { paused: true, play() { played++; }, pause() { paused++; } };
  nodes.find(node => node.type === "video").props.ref.current = video;
  const content = nodes.find(node => node.type === "DialogContent");
  for (const target of [content, video]) {
    const key = { ...event(target, content, " "), code: "Space", stopPropagation() {} };
    content.props.onKeyDown(key);
    assert.equal(key.defaultPrevented, true);
  }
  assert.equal(played, 2);
  video.paused = false;
  content.props.onKeyDown({ ...event(video, content, " "), code: "Space", stopPropagation() {} });
  assert.equal(paused, 1);
  nodes.find(node => node.props?.["aria-label"] === "下载视频").props.onClick();
  assert.equal(downloaded, 1);
});

test("canvas image parameter variants preserve model selection, visibility and count limits", () => {
  const changes = [];
  const { CanvasImageParameterPopover } = loadSource("../src/app/canvas/canvas-image-parameters.tsx", {
    "@/lib/image-options": imageOptions,
    "@/app/canvas/canvas-image-parameter-defaults": { defaultCanvasImageParameters: () => ({ generation_count: 1 }) },
    "@/lib/api": { imageOutputCountLimit: model => model === "limited" ? 1 : 15 },
  });
  const props = { node: { generation_model: " limited ", generation_count: 9 }, imageModel: "base", imageModels: [" limited ", "limited", "base", ""], onChange: patch => changes.push(patch) };
  const tree = CanvasImageParameterPopover(props);
  assert.equal(tree.type, "CanvasParameterPopover");
  const nodes = descendants(tree);
  const models = nodes.find(node => node.type === "ModelPicker");
  assert.equal(models.props.value, "limited");
  assert.deepEqual(Array.from(models.props.options), ["limited", "base"]);
  assert.equal(nodes.find(node => node.type === "ImageSettingsPanel").props.value.count, 1);
  models.props.onValueChange("base");
  assert.equal(changes[0].generation_model, "base");
  const expanded = descendants(CanvasImageParameterPopover({ ...props, expanded: true, showModel: false, showSize: false }));
  assert.equal(expanded.some(node => node.type === "CanvasParameterPopover" || node.type === "ModelPicker"), false);
  assert.equal(expanded.find(node => node.type === "ImageSettingsPanel").props.showSize, false);
  const unavailable = descendants(CanvasImageParameterPopover({ ...props, imageModels: [] })).find(node => node.type === "ModelPicker");
  assert.deepEqual(Array.from(unavailable.props.options), []);
});

test("canvas image parameter changes keep custom dimensions stable while typing", () => {
  const changes = [];
  const { CanvasImageParameterPopover } = loadSource("../src/app/canvas/canvas-image-parameters.tsx", {
    "@/lib/image-options": imageOptions,
    "@/app/canvas/canvas-image-parameter-defaults": { defaultCanvasImageParameters: () => ({ generation_count: 1 }) },
    "@/lib/api": { imageOutputCountLimit: () => 15 },
  });
  const tree = CanvasImageParameterPopover({ node: { generation_size: "1000x800", generation_snap_to_multiple_16: true }, imageModel: "base", onChange: patch => changes.push(patch) });
  const settings = descendants(tree).find(node => node.type === "ImageSettingsPanel");
  settings.props.onChange({ mode: "custom", customWidth: "1001", customHeight: "801" });
  assert.equal(changes[0].generation_size, "1001x801");
  assert.equal(changes[0].generation_snap_to_multiple_16, true);
  settings.props.onChange({ mode: "auto" });
  assert.equal(changes[1].generation_size, "");
});

test("canvas overflow menus preserve media actions, disabled state and dialog focus ownership", () => {
  for (const type of ["image", "video"]) {
    for (const busy of [false, true]) {
      const state = hooks();
      const calls = [];
      const { CanvasNodeQuickActions } = loadSource("../src/app/canvas/canvas-node-actions-panel.tsx", { react: state.react });
      const nodes = descendants(state.render(CanvasNodeQuickActions, {
        node: { type, url: "/fixture", prompt: "test" }, busy, uploading: false, imageEditingSupported: true,
        onImageOperation: action => calls.push(action), onMediaOperation: action => calls.push(action),
        onToggleFreeResize() {}, onReversePrompt() {}, onUpload() {},
      }));
      const items = nodes.filter(node => node.type === "DropdownMenuItem");
      assert.ok(items.length > 0);
      const action = items[0];
      assert.equal(action.props.disabled, busy);
      const content = nodes.find(node => node.type === "DropdownMenuContent");
      const dismiss = event({});
      content.props.onCloseAutoFocus(dismiss);
      assert.equal(dismiss.defaultPrevented, false, "ordinary dismissal restores trigger focus");
      if (!busy) {
        action.props.onSelect();
        assert.deepEqual(calls, [type === "image" ? "split" : "frame-first"]);
        const selected = event({});
        content.props.onCloseAutoFocus(selected);
        assert.equal(selected.defaultPrevented, true, "a selected action keeps control of its new dialog");
      }
    }
  }
});

test("panorama initialization cancels a discarded mount before creating a viewer", () => {
  const state = hooks();
  const frames = new Map(), viewers = [];
  let frameID = 0;
  class Viewer {
    listeners = new Map();
    destroyed = 0;
    constructor(options) { this.container = options.container; viewers.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    destroy() { this.destroyed++; }
  }
  const { PanoramaSurface } = loadSource("../src/app/canvas/canvas-panorama-viewer.tsx", {
    react: state.react,
    "@photo-sphere-viewer/core": { SYSTEM: { load() {} }, Viewer },
  }, {
    requestAnimationFrame: callback => { frames.set(++frameID, callback); return frameID; },
    cancelAnimationFrame: id => frames.delete(id),
  }, "\nexport { PanoramaSurface };\n");
  const props = { src: "/panorama.png", alt: "全景", proxyGeneratedPanorama: false, viewerEntry: { setActive() {} } };
  const nodes = descendants(state.render(PanoramaSurface, props));
  const container = { querySelector: () => null, replaceChildren() {} };
  nodes.find(node => node.props?.ref).props.ref.current = container;
  const discard = state.effects[0]();
  assert.equal(viewers.length, 0, "setup must not start a request before a discarded mount can clean up");
  assert.equal(frames.size, 1);
  discard();
  assert.equal(frames.size, 0);
  state.render(PanoramaSurface, props);
  const cleanup = state.effects[0]();
  const callback = [...frames.values()][0];
  callback();
  assert.equal(viewers.length, 1);
  viewers[0].listeners.get("ready")();
  assert.equal(descendants(state.render(PanoramaSurface, props)).some(node => node.type === "LoadingState"), false);
  cleanup();
  assert.equal(viewers[0].destroyed, 1);
  assert.equal(viewers[0].listeners.size, 0);
});

test("desktop CSP permits only the current fixed Radix viewport stylesheet without enabling inline scripts or network connections", () => {
  const markup = renderToStaticMarkup(createElement(ScrollArea, {}, "Viewport"));
  const styles = [...markup.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]);
  assert.equal(styles.length, 1);
  const hash = createHash("sha256").update(styles[0]).digest("base64");
  const html = readFileSync(new URL("../src/desktop/index.html", import.meta.url), "utf8");
  assert.ok(html.includes(`style-src 'self' 'sha256-${hash}'`));
  assert.ok(html.includes("script-src 'self';"));
  assert.ok(html.includes("connect-src 'none';"));
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
});

function desktopFixture(readSettings, connect) {
  const state = hooks();
  const { DesktopConnectionSettings } = loadSource("../src/desktop/settings.tsx", { react: state.react }, {
    Error,
    window: { desktopConnection: { settings: readSettings, connect }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    document: { documentElement: { classList: { toggle() {} } } },
  });
  return { state, render: () => descendants(state.render(DesktopConnectionSettings)) };
}

const desktopSettings = { mode: "local", remoteURL: "https://canvas.example.test", needsPassword: true, dataDirectory: "C:/Users/test/AppData/chatgpt2api/runtime", statusMessage: "", development: false, connecting: false };

test("desktop connection fields follow local and remote mode without exposing hidden required inputs", async () => {
  const fixture = desktopFixture(async () => desktopSettings, () => Promise.resolve({ ok: true }));
  let nodes = fixture.render();
  assert.equal(nodes.find(node => node.props?.id === "connect").props.disabled, true);
  fixture.state.effects.forEach(effect => effect()); await flush();
  nodes = fixture.render();
  const password = nodes.find(node => node.type === "PasswordInput");
  assert.equal(password.props.required, true);
  assert.equal(password.props.minLength, 12);
  assert.equal(password.props.maxLength, 72);
  assert.equal(nodes.some(node => node.type === "Input" && node.props.type === "url"), false);
  nodes.find(node => node.type === "RadioGroup").props.onValueChange("remote");
  nodes = fixture.render();
  assert.equal(nodes.some(node => node.type === "PasswordInput"), false);
  const remote = nodes.find(node => node.type === "Input" && node.props.type === "url");
  assert.equal(remote.props.required, true);
  assert.equal(remote.props.value, desktopSettings.remoteURL);
});

test("desktop connection clears passwords, submits once and unlocks retry after a failure", async () => {
  let resolveConnect;
  const pending = new Promise(resolve => { resolveConnect = resolve; });
  const calls = [];
  const fixture = desktopFixture(async () => desktopSettings, input => { calls.push({ ...input }); return pending; });
  fixture.render(); fixture.state.effects.forEach(effect => effect()); await flush();
  let nodes = fixture.render();
  const password = { value: "isolated-test-password" };
  nodes.find(node => node.type === "PasswordInput").props.ref.current = password;
  const form = nodes.find(node => node.type === "form");
  form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
  assert.equal(password.value, "");
  assert.deepEqual(calls, [{ mode: "local", remoteURL: "", adminPassword: "isolated-test-password" }]);
  nodes = fixture.render();
  assert.equal(nodes.find(node => node.type === "FieldSet").props.disabled, true);
  assert.equal(nodes.find(node => node.props?.id === "connect").props.disabled, true);
  resolveConnect({ ok: false, error: "受控连接失败" }); await flush();
  nodes = fixture.render();
  assert.equal(nodes.find(node => node.type === "FieldSet").props.disabled, false);
  assert.equal(nodes.find(node => node.type === "AlertDescription").props.children, "受控连接失败");
  assert.ok(nodes.find(node => node.props?.id === "connect").props.children.includes("重试连接"));
});

test("desktop settings read failure stays visible and cannot submit a connection", async () => {
  let calls = 0;
  const fixture = desktopFixture(async () => { throw new Error("无法读取测试设置"); }, async () => { calls++; return { ok: true }; });
  fixture.render(); fixture.state.effects.forEach(effect => effect()); await flush();
  const nodes = fixture.render();
  assert.equal(nodes.find(node => node.type === "AlertDescription").props.children, "无法读取测试设置");
  assert.equal(nodes.find(node => node.props?.id === "connect").props.disabled, true);
  nodes.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  await flush(); assert.equal(calls, 0);
});

test("shared confirmations preserve content, busy dismissal and independent confirmation disabling", () => {
  const { ConfirmDialog } = loadSource("../src/components/ui/confirm-dialog.tsx");
  for (const busy of [false, true]) {
    for (const confirmDisabled of [false, true]) {
      const changes = [], confirmations = [];
      const content = { type: "Checkbox", props: { checked: true } };
      const tree = ConfirmDialog({
        open: true, title: "确认清理", description: "保留运行中任务", busy, confirmDisabled,
        confirmLabel: "仅清理记录", children: content,
        onOpenChange: value => changes.push(value), onConfirm: () => confirmations.push(true),
      });
      const nodes = descendants(tree);
      const body = nodes.find(node => node.type === "ScrollArea");
      assert.ok(descendants(body).some(node => node.type === "DialogTitle" && node.props.children === "确认清理"));
      assert.ok(descendants(body).some(node => node.type === "DialogDescription" && node.props.children === "保留运行中任务"));
      assert.ok(descendants(body).includes(content), "optional confirmation controls remain in the scrollable body");
      assert.equal(descendants(body).some(node => node.type === "DialogFooter"), false, "actions remain outside the scrolling body");
      assert.ok(nodes.includes(content));
      const buttons = nodes.filter(node => node.type === "Button");
      const confirm = buttons.at(-1), cancel = buttons[0];
      assert.equal(confirm.props.disabled, busy || confirmDisabled);
      assert.equal(cancel.props.disabled, busy);
      tree.props.onOpenChange(false);
      assert.deepEqual(changes, busy ? [] : [false]);
      if (!busy) cancel.props.onClick();
      if (!confirm.props.disabled) confirm.props.onClick();
      assert.deepEqual(confirmations, busy || confirmDisabled ? [] : [true]);
      assert.equal(nodes.filter(node => node.type === "Spinner").length, busy ? 1 : 0);
    }
  }
});

test("canvas project deletion uses shared confirmation while name edits retain validation", () => {
  const state = hooks(), changes = [];
  const { CanvasProjectDialog } = loadSource("../src/app/canvas/canvas-project-dialog.tsx", { react: state.react });
  const props = { open: true, mode: "delete", title: "品牌视觉", onOpenChange: () => {}, onConfirm: value => changes.push(value) };
  const confirmation = state.render(CanvasProjectDialog, props);
  assert.equal(confirmation.type, "ConfirmDialog");
  assert.equal(confirmation.props.destructive, true);
  assert.ok(confirmation.props.description.includes("品牌视觉"));
  confirmation.props.onConfirm();
  assert.deepEqual(changes, [undefined]);
  const edit = descendants(state.render(CanvasProjectDialog, { ...props, mode: "rename" }));
  const input = edit.find(node => node.type === "Input");
  input.props.onChange({ target: { value: "   " } });
  let submit = descendants(state.render(CanvasProjectDialog, { ...props, mode: "rename" })).find(node => node.type === "Button" && node.props.children === "保存");
  assert.equal(submit.props.disabled, true);
  input.props.onChange({ target: { value: "  新标题  " } });
  submit = descendants(state.render(CanvasProjectDialog, { ...props, mode: "rename" })).find(node => node.type === "Button" && node.props.children === "保存");
  assert.equal(submit.props.disabled, false);
  submit.props.onClick();
  assert.deepEqual(changes, [undefined, "新标题"]);
});

test("image preset groups retain every size, selection, automatic mode, and disabled state", () => {
  const { ImageSizePresetControls } = loadSource("../src/components/generation/image-size-preset-controls.tsx", {
    "@/lib/image-options": { IMAGE_ASPECT_RATIO_PRESET_OPTIONS },
  });
  for (const selected of IMAGE_ASPECT_RATIO_PRESET_OPTIONS) {
    for (const disabled of [false, true]) {
      const changes = [];
      const controls = descendants(ImageSizePresetControls({
        value: { mode: selected.value === "auto" ? "auto" : "ratio", aspectRatio: selected.aspectRatio, resolution: selected.resolution },
        disabled,
        ariaLabelPrefix: "编辑图片",
        onChange: (patch) => changes.push(JSON.parse(JSON.stringify(patch))),
      })).filter((node) => node.type === "AspectRatioOptionButton" || node.type === "Toggle");
      assert.equal(controls.length, IMAGE_ASPECT_RATIO_PRESET_OPTIONS.length);
      assert.equal(controls.filter((node) => node.props.active || node.props.pressed).length, 1);
      for (const option of IMAGE_ASPECT_RATIO_PRESET_OPTIONS) {
        const label = option.value === "auto" ? "编辑图片自动尺寸" : `编辑图片 ${option.label}`;
        const control = controls.find((node) => node.props["aria-label"] === label);
        assert.ok(control, `Missing preset ${option.value}`);
        assert.equal(control.props.disabled, disabled);
        assert.equal(Boolean(control.props.active || control.props.pressed), option.value === selected.value);
        if (!disabled) {
          control.props.onClick();
          assert.deepEqual(changes.at(-1), { mode: option.value === "auto" ? "auto" : "ratio", aspectRatio: option.aspectRatio, resolution: option.resolution });
        }
      }
    }
  }
});

test("shared field labels target unique controls and exclude their editable values", () => {
  const render = (value) => renderToStaticMarkup(createElement("div", null,
    ...["Name", "Instructions"].map((label) => createElement(LabeledField, { label, key: label, meta: "0/200" },
      (id) => createElement("textarea", { id, defaultValue: value }),
    )),
  ));
  for (const value of ["", "A long edited value"]) {
    const markup = render(value);
    const labels = [...markup.matchAll(/<label\b[^>]*for="([^"]+)"[^>]*>([^<]+)<\/label>/g)];
    assert.deepEqual(labels.map((match) => match[2]), ["Name", "Instructions"]);
    assert.equal(new Set(labels.map((match) => match[1])).size, 2);
    assert.equal((markup.match(/0\/200/g) || []).length, 2);
    for (const match of labels) assert.ok(markup.includes(`<textarea id="${match[1]}">`));
  }
});

function sortableFixture(values = ["first", "second", "third"], disabled = false) {
  const state = hooks();
  const contexts = [];
  const orders = [];
  const starts = [];
  const components = loadSource("../src/components/sortable-list.tsx", {
    react: {
      ...state.react,
      createContext: () => {
        const context = { Provider: Symbol("provider"), current: null };
        contexts.push(context);
        return context;
      },
      useContext: (context) => context.current,
    },
    "motion/react": {
      Reorder: { Group: "group", Item: "item" },
      useDragControls: () => ({ start: (pointer) => starts.push(pointer) }),
      useReducedMotion: () => false,
    },
  });
  const listProps = { values, disabled, onReorder: (next) => orders.push([...next]), children: (order) => order };
  const list = state.render(components.SortableList, listProps);
  contexts[0].current = list.props.value;
  const item = state.render(components.SortableItem, { value: "second", label: "Second" });
  contexts[1].current = item.props.value;
  return { ...components, state, contexts, listProps, list: list.props.children, item: item.props.children, orders, starts };
}

test("sorting previews stay inside the list until one final drop commit", () => {
  const fixture = sortableFixture();
  fixture.item.props.onDragStart();
  fixture.list.props.onReorder(["second", "first", "third"]);
  let tree = fixture.state.render(fixture.SortableList, fixture.listProps);
  fixture.contexts[0].current = tree.props.value;
  assert.deepEqual(Array.from(tree.props.children.props.values), ["second", "first", "third"]);
  assert.deepEqual(Array.from(tree.props.children.props.children), ["second", "first", "third"]);
  assert.deepEqual(fixture.orders, []);
  tree.props.children.props.onReorder(["first", "third", "second"]);
  fixture.item.props.onDragEnd({ type: "pointerup" });
  fixture.item.props.onDragEnd({ type: "pointerup" });
  assert.deepEqual(fixture.orders, [["first", "third", "second"]]);
});

test("cancelled pointer sorting restores the original order without persisting a preview", () => {
  const fixture = sortableFixture();
  fixture.item.props.onDragStart();
  fixture.list.props.onReorder(["second", "first", "third"]);
  let tree = fixture.state.render(fixture.SortableList, fixture.listProps);
  fixture.contexts[0].current = tree.props.value;
  fixture.item.props.onDragEnd({ type: "pointercancel" });
  tree = fixture.state.render(fixture.SortableList, fixture.listProps);
  assert.deepEqual(Array.from(tree.props.children.props.values), ["first", "second", "third"]);
  assert.deepEqual(fixture.orders, []);
  tree.props.value.beginDrag();
  tree.props.children.props.onReorder(["third", "first", "second"]);
  tree.props.value.endDrag();
  assert.deepEqual(fixture.orders, [["third", "first", "second"]], "a new drag still commits after cancellation");
});

test("sorting does not commit a round trip or an obsolete external order", () => {
  for (const mode of ["round-trip", "external-change", "disabled"]) {
    const fixture = sortableFixture();
    fixture.item.props.onDragStart();
    fixture.list.props.onReorder(["second", "first", "third"]);
    if (mode === "round-trip") fixture.list.props.onReorder(["first", "second", "third"]);
    const props = { ...fixture.listProps,
      values: mode === "external-change" ? ["third", "first"] : fixture.listProps.values,
      disabled: mode === "disabled",
    };
    const tree = fixture.state.render(fixture.SortableList, props);
    fixture.contexts[0].current = tree.props.value;
    if (mode === "external-change") tree.props.children.props.onReorder(["second", "third", "first"]);
    fixture.contexts[0].current.endDrag();
    assert.deepEqual(fixture.orders, [], mode);
    if (mode === "external-change") assert.deepEqual(Array.from(tree.props.children.props.values), ["third", "first"]);
  }
});

test("shared sorting moves the same item by keyboard without changing other values", () => {
  for (const [key, expected] of [
    ["ArrowUp", ["second", "first", "third"]],
    ["ArrowDown", ["first", "third", "second"]],
    ["Home", ["second", "first", "third"]],
    ["End", ["first", "third", "second"]],
  ]) {
    const fixture = sortableFixture();
    const handle = fixture.state.render(fixture.SortableHandle);
    const input = event(null, null, key);
    handle.props.onKeyDown(input);
    assert.equal(input.defaultPrevented, true);
    assert.deepEqual(fixture.orders, [expected]);
  }
  const boundary = sortableFixture(["second", "third"]);
  boundary.contexts[1].current.onKeyDown(event(null, null, "ArrowUp"));
  boundary.contexts[1].current.onKeyDown(event(null, null, "Tab"));
  assert.deepEqual(boundary.orders, []);
});

test("disabled sorting rejects pointer, keyboard, and motion reorder callbacks", () => {
  const fixture = sortableFixture(undefined, true);
  const handle = fixture.state.render(fixture.SortableHandle);
  handle.props.onPointerDown({ button: 0 });
  handle.props.onKeyDown(event(null, null, "ArrowDown"));
  fixture.list.props.onReorder(["third", "second", "first"]);
  assert.equal(handle.props.disabled, true);
  assert.equal(fixture.item.props.drag, false);
  assert.deepEqual(fixture.starts, []);
  assert.deepEqual(fixture.orders, []);
});

test("sorting handles start only primary drags and navigation remains clickable after a drag", () => {
  const fixture = sortableFixture();
  const handle = fixture.state.render(fixture.SortableHandle);
  handle.props.onPointerDown({ button: 2 });
  handle.props.onPointerDown({ button: 0, pointerType: "touch" });
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.starts[0].pointerType, "touch");
  fixture.item.props.onDragStart();
  const click = { ...event(), detail: 1, stopped: false, stopPropagation() { this.stopped = true; } };
  fixture.item.props.onClickCapture(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.stopped, true);
  const keyboardClick = { ...click, detail: 0, defaultPrevented: false };
  fixture.item.props.onClickCapture(keyboardClick);
  assert.equal(keyboardClick.defaultPrevented, false);
  fixture.item.props.onPointerDownCapture();
  const laterClick = { ...click, defaultPrevented: false };
  fixture.item.props.onClickCapture(laterClick);
  assert.equal(laterClick.defaultPrevented, false);
});

test("select trigger closes once without a following touch click reopening it", () => {
  for (const pointerType of ["mouse", "touch", "pen"]) {
    const state = hooks();
    const changes = [];
    const context = { open: true, setOpen(value) { context.open = value; changes.push(value); } };
    const react = { ...state.react, createContext: () => ({}), useContext: () => context };
    const { SelectTrigger } = loadSource("../src/components/ui/select.tsx", { react });
    const trigger = state.render(SelectTrigger);
    assert.match(trigger.props.className, /pointer-events-auto/);
    const down = { ...event(), button: 0, ctrlKey: false, pointerType };
    trigger.props.onPointerDown(down);
    assert.equal(down.defaultPrevented, true);
    assert.deepEqual(changes, [false]);
    const closed = state.render(SelectTrigger);
    const click = event();
    closed.props.onClick(click);
    assert.equal(click.defaultPrevented, true, "Radix click-to-open must not run after closing");
    assert.doesNotMatch(closed.props.className, /pointer-events-auto/);
    const nextDown = { ...event(), button: 0, ctrlKey: false, pointerType };
    closed.props.onPointerDown(nextDown);
    const nextClick = event();
    closed.props.onClick(nextClick);
    assert.equal(nextDown.defaultPrevented, false);
    assert.equal(nextClick.defaultPrevented, false, "a later interaction can open normally");
  }
});

test("select trigger respects disabled state, consumer cancellation, and modified clicks", () => {
  for (const mode of ["disabled", "cancelled", "right", "control"]) {
    const state = hooks();
    const changes = [];
    const react = { ...state.react, createContext: () => ({}), useContext: () => ({ open: true, setOpen: (value) => changes.push(value) }) };
    const { SelectTrigger } = loadSource("../src/components/ui/select.tsx", { react });
    const trigger = state.render(SelectTrigger, { disabled: mode === "disabled", onPointerDown: (e) => { if (mode === "cancelled") e.preventDefault(); } });
    trigger.props.onPointerDown({ ...event(), button: mode === "right" ? 2 : 0, ctrlKey: mode === "control" });
    assert.deepEqual(changes, [], mode);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("applying library prompts navigates only after the handoff is saved", () => {
  for (const failure of [null, "SecurityError", "QuotaExceededError"]) {
    const state = hooks();
    const session = { key: "session-a", role: "user" };
    const navigations = [];
    const errors = [];
    const values = new Map();
    const browser = {
      get sessionStorage() {
        if (failure === "SecurityError") throw new DOMException("Storage access denied", failure);
        return {
          setItem(key, value) {
            if (failure === "QuotaExceededError") throw new DOMException("Storage is full", failure);
            values.set(key, value);
          },
          getItem: (key) => values.get(key) ?? null,
          removeItem: (key) => values.delete(key),
        };
      },
    };
    const handoff = loadSource("../src/app/prompt-library/prompt-handoff.ts", {}, { window: browser });
    const { default: PromptLibraryPage } = loadSource("../src/app/prompt-library/page.tsx", {
      react: state.react,
      "react-router-dom": { useNavigate: () => (path) => navigations.push(path), useSearchParams: () => [new URLSearchParams()] },
      "@/lib/use-auth-guard": { useAuthGuard: () => ({ isCheckingAuth: false, session }) },
      "@/lib/use-auth-session-revision": { useAuthSessionRevision: () => 0 },
      "@/lib/session": { getCachedAuthSession: () => session },
      "@/app/prompt-library/prompt-handoff": handoff,
      sonner: { toast: { error: (message) => errors.push(message) } },
    });
    const content = state.render(PromptLibraryPage);
    const market = state.render(content.type, content.props);
    market.props.onApplyPrompt({ id: "prompt", title: "Prompt", prompt: "Draw a product" });
    assert.deepEqual(navigations, failure ? [] : ["/studio"], failure ?? "available storage");
    assert.equal(errors.length, failure ? 1 : 0);
    assert.equal(handoff.consumePromptForWorkbench(session.key)?.prompt, failure ? undefined : "Draw a product");
  }
});

class KeyboardTarget {
  constructor(control = false, editable = false) { this.control = control; this.isContentEditable = editable; }
  closest() { return this.control ? this : null; }
}

test("native scroll containers leave keyboard scrolling to the browser", () => {
  for (const mode of ["input", "editable", "cancelled", "consumer", "plain"]) {
    const state = hooks();
    const { ScrollArea } = loadSource("../src/components/ui/scroll-area.tsx", { react: state.react, "radix-ui": { ScrollArea: { Root: "div", Viewport: "div", Corner: "div", ScrollAreaScrollbar: "div", ScrollAreaThumb: "div" } } }, { HTMLElement: KeyboardTarget, Element: KeyboardTarget });
    let consumerCalls = 0;
    const root = state.render(ScrollArea, { onKeyDown(e) { consumerCalls++; if (mode === "consumer") e.preventDefault(); } });
    const viewport = root.props.children.find((item) => item?.props?.["data-slot"] === "scroll-area-viewport");
    assert.equal(viewport.props["data-slot"], "scroll-area-viewport");
    const target = new KeyboardTarget(mode === "input", mode === "editable");
    const e = event(target);
    if (mode === "cancelled") e.preventDefault();
    root.props.onKeyDown(e);
    assert.equal(e.defaultPrevented, mode === "cancelled" || mode === "consumer", mode);
    assert.equal(consumerCalls, 1, mode);
  }
});

test("read-only number inputs cannot be changed with step controls", () => {
  const state = hooks();
  const { NumberInput } = loadSource("../src/components/ui/number-input.tsx", { react: state.react, "./input-group": { InputGroup: "div", InputGroupInput: "input" } });
  const changes = [];
  const tree = state.render(NumberInput, { value: 2, readOnly: true, onValueChange: (value) => changes.push(value) });
  const input = descendants(tree).find((item) => item.type === "input");
  let steps = 0;
  input.props.ref({ value: "3", readOnly: true, focus() {}, stepUp() { steps++; }, stepDown() { steps++; } });
  const buttons = descendants(tree).filter((item) => item.props?.tooltip);
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    button.props.onClick();
    assert.equal(button.props.disabled, true);
  }
  assert.equal(steps, 0);
  assert.equal(changes.length, 0);
});

test("multi-select preserves keyboard activation of nested remove buttons", () => {
  const state = hooks();
  const { MultiSelect } = loadSource("../src/components/ui/multi-select.tsx", { react: state.react });
  const tree = state.render(MultiSelect, { value: ["one"], options: [{ value: "one", label: "One" }], onValueChange() {} });
  const trigger = descendants(tree).find((item) => item.props?.role === "combobox");
  const nestedButton = {};
  for (const key of ["Enter", " "]) {
    const e = event(nestedButton, trigger, key);
    trigger.props.onKeyDown(e);
    assert.equal(e.defaultPrevented, false, key);
  }
  const e = event(trigger, trigger, "Enter");
  trigger.props.onKeyDown(e);
  assert.equal(e.defaultPrevented, true);
});

test("multi-select actions keep keyboard activation separate from option selection", () => {
  for (const disabled of [false, true]) {
    const state = hooks();
    const { MultiSelect } = loadSource("../src/components/ui/multi-select.tsx", { react: state.react });
    const changes = [];
    const items = [{ value: "one", label: "One" }, { value: "two", label: "Two", action: "Edit" }];
    const tree = state.render(MultiSelect, {
      value: ["one"],
      disabled,
      options: items,
      onValueChange: (value) => changes.push(Array.from(value)),
    });
    assert.equal(tree.props.multiple, true);
    assert.equal(tree.props.disabled, disabled);
    const list = descendants(tree).find((item) => item.type === "ComboboxList");
    const option = list.props.children(items[1]);
    assert.equal(option.type, "ComboboxItem");
    assert.equal(option.props.disabled, disabled);
    const actions = descendants(option).find((item) => item.props?.onPointerDown && item.props?.onKeyDown);
    for (const key of ["Enter", " ", "Escape"]) {
      let stopped = false;
      const e = { ...event(actions, actions, key), stopPropagation() { stopped = true; } };
      actions.props.onKeyDown(e);
      assert.equal(stopped, key !== "Escape", key);
      assert.equal(e.defaultPrevented, false, "nested button must retain native activation");
    }
    for (const handler of ["onFocus", "onPointerDown", "onMouseDown", "onClick"]) {
      let stopped = false;
      actions.props[handler]({ stopPropagation() { stopped = true; } });
      assert.equal(stopped, true, handler);
    }
    assert.deepEqual(changes, []);
    tree.props.onValueChange(items);
    tree.props.onValueChange([]);
    assert.deepEqual(changes, disabled ? [] : [["one", "two"], []]);
  }
});

test("multi-select preserves selection order and rejects removal while disabled", () => {
  for (const disabled of [false, true]) {
    const state = hooks();
    const { MultiSelect } = loadSource("../src/components/ui/multi-select.tsx", { react: state.react });
    const changes = [];
    const options = [{ value: "one", label: "One" }, { value: "two", label: "Two" }];
    const props = { value: ["two", "stale", "one", "two"], options, disabled: false,
      onValueChange: (value) => changes.push(Array.from(value)) };
    let tree = state.render(MultiSelect, props);
    assert.deepEqual(Array.from(tree.props.value, (option) => option.value), ["two", "one"]);
    tree.props.onOpenChange(true);
    tree = state.render(MultiSelect, { ...props, disabled });
    for (const effect of state.effects) effect();
    tree = state.render(MultiSelect, { ...props, disabled });
    assert.equal(tree.props.open, !disabled);
    tree.props.onOpenChange(true);
    const removeButton = descendants(tree).find((item) => item.props?.["aria-label"] === "移除 Two");
    assert.equal(removeButton.props.disabled, disabled);
    for (const key of ["Enter", " "]) {
      let stopped = false;
      const e = { ...event(removeButton, removeButton, key), stopPropagation() { stopped = true; } };
      removeButton.props.onKeyDown(e);
      assert.equal(stopped, true);
      assert.equal(e.defaultPrevented, false);
    }
    removeButton.props.onClick({ preventDefault() {}, stopPropagation() {} });
    tree = state.render(MultiSelect, { ...props, disabled });
    assert.equal(tree.props.open, !disabled);
    assert.deepEqual(changes, disabled ? [] : [["one"]]);
  }
});

test("queue refreshes cannot delete histories after unmount or supersession", async () => {
  for (const staleKind of ["unmount", "superseded", "current"]) {
    const state = hooks();
    const requests = [];
    const deletions = [];
    const listeners = new Map();
    const { useImageConversationsForQueue } = loadSource("../src/components/image-task-queue.tsx", {
      react: state.react,
      "@/lib/image-conversation-source": { isWorkflowImageConversation: () => true },
      "@/store/image-conversations": {
        loadImageConversationHistoryWindow() { const request = deferred(); requests.push(request); return request.promise; },
        mergeImageConversationItems: (first, active) => [...first, ...active],
        deleteImageConversation: async (id) => { deletions.push(id); },
      },
    }, { window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} } }, "\nexport { useImageConversationsForQueue };\n");
    state.render(useImageConversationsForQueue);
    const cleanup = state.effects[0]();
    if (staleKind === "unmount") cleanup();
    if (staleKind === "superseded") listeners.get("focus")();
    requests[0].resolve({ firstPage: { items: [{ id: "workflow-history" }] }, activePage: { items: [] } });
    await flush();
    assert.deepEqual(deletions, staleKind === "current" ? ["workflow-history"] : [], staleKind);
    cleanup();
  }
});

test("login image fallback stops retrying when the fallback itself fails", () => {
  const state = hooks();
  const { useLoginPageImageState } = loadSource("../src/components/use-login-page-image-state.ts", {
    react: state.react,
    "@/lib/app-meta": { DEFAULT_LOGIN_PAGE_IMAGE: "/fallback.svg", resolveLoginPageImageSrc: (value) => value || "/fallback.svg" },
    "@/lib/login-page-image-layout": { normalizeLoginPageImageMode: (value) => value, normalizeLoginPageImageTransform: (value) => value, getLoginPageImageLayout: () => null },
  });
  let retries = 0;
  const target = { get src() { return "https://app.example/fallback.svg"; }, set src(_) { retries++; } };
  const props = { src: "/custom.png", mode: "contain", zoom: 1, positionX: 50, positionY: 50 };
  let result = state.render(useLoginPageImageState, props);
  result.onImageError({ currentTarget: target });
  result = state.render(useLoginPageImageState, props);
  assert.equal(result.currentSrc, "/fallback.svg");
  result.onImageError({ currentTarget: target });
  assert.equal(retries, 0, "React should own src changes; a failed fallback must not be assigned repeatedly");
});

test("announcement effect replay starts a fresh load and applies its response", async () => {
  const state = hooks();
  const requests = [];
  const lifecycle = loadSource("../src/lib/announcement-lifecycle.ts");
  const mutations = loadSource("../src/lib/scoped-mutation-lifecycle.ts");
  const { AnnouncementCenter } = loadSource("../src/components/announcement-center.tsx", {
    react: state.react,
    "@/lib/announcement-lifecycle": lifecycle,
    "@/lib/scoped-mutation-lifecycle": mutations,
    "@/lib/api": {
      fetchAnnouncements() { const request = deferred(); requests.push(request); return request.promise; },
      fetchAnnouncementPreferences: async () => ({ preferences: { seen_versions: [], permanent_versions: [], snoozed_dates: {} } }),
    },
  }, { window: { addEventListener() {}, removeEventListener() {}, setInterval() { return 1; }, clearInterval() {} }, document: { addEventListener() {}, removeEventListener() {} } });
  state.render(AnnouncementCenter, { sessionKey: "session-a" });
  const setup = state.effects[0];
  setup()();
  const cleanup = setup();
  assert.equal(requests.length, 2, "replayed effect reused a load invalidated by cleanup");
  requests[0].resolve({ items: [{ id: "old", updated_at: "1", title: "old" }] });
  requests[1].resolve({ items: [{ id: "new", updated_at: "2", title: "new" }] });
  await flush();
  const tree = state.render(AnnouncementCenter, { sessionKey: "session-a" });
  const serialized = JSON.stringify(tree);
  assert.ok(serialized.includes('"new"'));
  assert.ok(!serialized.includes('"old"'));
  cleanup();
});

test("conversation search restores the full list when it closes", () => {
  const state = hooks();
  const { ImageSidebar } = loadSource("../src/app/image/components/image-sidebar.tsx", {
    react: state.react,
    "@/lib/use-app-meta": { useAppMeta: () => ({ app_title: "Test" }) },
    "@/app/image/use-history-download": { useHistoryDownload: () => ({ selecting: false, busy: false, selected: new Set() }) },
    "@/store/image-conversations": { getImageConversationStats: () => ({ running: 0, queued: 0 }), isImageConversationHistorySummaryOnly: () => false },
  });
  const props = { pinnedIds: [], unreadIds: [], conversations: [{ id: "a", title: "Alpha", turns: [] }, { id: "b", title: "Beta", turns: [] }] };
  const render = () => descendants(state.render(ImageSidebar, props));
  const conversations = (nodes) => nodes.filter((node) => node.type === "Button" && Object.hasOwn(node.props, "aria-current"));
  let nodes = render();
  assert.equal(conversations(nodes).length, 2);
  nodes.find((node) => node.props?.["aria-label"] === "搜索会话").props.onClick();
  nodes = render();
  nodes.find((node) => node.type === "SearchInput").props.onValueChange("alpha");
  nodes = render();
  assert.equal(conversations(nodes).length, 1);
  nodes.find((node) => node.props?.["aria-label"] === "搜索会话").props.onClick();
  nodes = render();
  assert.equal(conversations(nodes).length, 2);
  assert.equal(nodes.some((node) => node.type === "SearchInput"), false);
});

test("mobile navigation closes after choosing an allowed destination", () => {
  const state = hooks();
  const { TopNav } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "react-router-dom": { useLocation: () => ({ pathname: "/studio" }), useNavigate: () => () => {} },
    "@/lib/session": { getCachedAuthSession: () => ({ key: "session", role: "user" }) },
    "@/lib/auth-session": { canAccessPath: (_, path) => path === "/studio", AUTH_SESSION_CHANGE_EVENT: "session-change" },
    "@/lib/use-app-meta": { useAppMeta: () => ({ app_title: "Test" }) },
    "@/lib/app-meta": { resolveSiteIconSrc: () => "/icon.svg" },
  });
  const render = () => descendants(state.render(TopNav, { onPreloadRoute() {} }));
  let nodes = render();
  nodes.find((node) => node.type === "Popover").props.onOpenChange(true);
  nodes = render();
  assert.equal(nodes.find((node) => node.type === "Popover").props.open, true);
  const destinations = nodes.filter((node) => node.type?.name === "NavPill");
  assert.ok(destinations.every((node) => node.props.item.href === "/studio"));
  destinations.find((node) => node.props.onNavigate).props.onNavigate();
  assert.equal(render().find((node) => node.type === "Popover").props.open, false);
});

test("navigation widgets have distinct stable keys and remount when the active session changes", () => {
  const state = hooks();
  let session = { key: "session-a", role: "user" };
  const listeners = new Map();
  const { TopNav } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "@/lib/use-active-navigation": loadSource("../src/lib/use-active-navigation.ts", { react: state.react }),
    "react-router-dom": { useLocation: () => ({ pathname: "/assets" }), useNavigate: () => () => {} },
    "@/lib/session": { getCachedAuthSession: () => session },
    "@/lib/auth-session": { canAccessPath: () => true, AUTH_SESSION_CHANGE_EVENT: "session-change" },
    "@/lib/use-app-meta": { useAppMeta: () => ({ app_title: "Test" }) },
    "@/lib/app-meta": { resolveSiteIconSrc: () => "/icon.svg" },
    "@/lib/theme": { getPreferredColorTheme: () => "light" },
  }, { window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {} } });
  const widgets = (tree) => descendants(tree).filter((item) => item.type === "ImageTaskQueue" || item.type === "AnnouncementCenter");
  const initialTree = state.render(TopNav);
  const initialRail = descendants(initialTree).find(node => node.type?.name === "NavigationRail");
  const initialWidgets = widgets(initialTree);
  assert.equal(initialWidgets.length, 2);
  assert.ok(initialWidgets.every((item) => typeof item.key === "string" && item.key.length > 0));
  assert.equal(new Set(initialWidgets.map((item) => item.key)).size, 2);
  const cleanup = state.effects[1]();
  const sameSessionWidgets = widgets(state.render(TopNav));
  assert.deepEqual(sameSessionWidgets.map((item) => item.key), initialWidgets.map((item) => item.key));
  session = { key: "session-b", role: "user" };
  listeners.get("session-change")();
  const nextTree = state.render(TopNav);
  const nextRail = descendants(nextTree).find(node => node.type?.name === "NavigationRail");
  assert.notEqual(nextRail.key, initialRail.key);
  const nextWidgets = widgets(nextTree);
  assert.equal(nextWidgets.length, 2);
  assert.equal(new Set(nextWidgets.map((item) => item.key)).size, 2);
  for (const widget of nextWidgets) {
    assert.notEqual(widget.key, initialWidgets.find((item) => item.type === widget.type).key);
  }
  cleanup();
});

test("opening queued work still navigates when browser storage is unavailable", () => {
  const state = hooks();
  let firstState = true;
  const navigations = [];
  const events = [];
  const { ImageTaskQueue } = loadSource("../src/components/image-task-queue.tsx", {
    react: { ...state.react, useState(initial) {
      if (firstState) {
        firstState = false;
        return state.react.useState([{ id: "conversation", title: "Work", turns: [{ id: "turn", images: [], createdAt: "2026-01-01", count: 1 }] }]);
      }
      return state.react.useState(initial);
    } },
    "react-router-dom": { useNavigate: () => (path) => navigations.push(path) },
    "@/lib/use-now": { useNow: () => 0 },
    "@/components/ui/status-tone": {
      statusToneClasses: Object.fromEntries(["info", "success", "warning", "danger"].map((tone) => [tone, Object.fromEntries(["chip", "soft", "panel", "text", "dot", "bar", "trigger"].map((key) => [key, `${tone}-${key}`]))])),
    },
    "@/store/image-conversations": {
      getEffectiveImageTurnStatus: () => "queued",
      getImageTurnLoadingCounts: () => ({ queued: 1, running: 0 }),
      ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY: "active",
      IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT: "open-conversation",
    },
    "@/store/image-turn-progress": { getImageTurnProgressSnapshot: () => ({}) },
    "@/store/canvas-task-queue": { getCanvasTaskQueueSnapshot: () => [] },
  }, {
    window: { localStorage: { setItem() { throw new Error("storage denied"); } }, dispatchEvent: (e) => events.push(e) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  const tree = state.render(ImageTaskQueue);
  const queuedItem = descendants(tree).find((item) => item.type?.name === "QueueItem");
  queuedItem.props.onOpenConversation("conversation");
  assert.deepEqual(navigations, ["/studio"]);
  assert.equal(events[0].type, "open-conversation");
  assert.equal(events[0].detail.conversationId, "conversation");
});

test("recent creation tasks distinguish success, failure and cancellation through shared status", () => {
  const opened = [];
  const { CompletionItem } = loadSource("../src/components/image-task-queue.tsx", {}, {}, "\nexport { CompletionItem };\n");
  for (const [finalStatus, expected] of [["success", "success"], ["message", "success"], ["error", "error"], ["cancelled", "cancelled"]]) {
    const tree = CompletionItem({ item: {
      conversationId: "isolated-conversation", conversationTitle: "隔离任务",
      turn: { prompt: "隔离提示词", error: finalStatus === "error" ? "隔离生成失败" : "" },
      finalStatus, totalCount: 2, completedCount: finalStatus === "success" ? 2 : 0,
      failedCount: finalStatus === "error" ? 2 : 0, cancelledCount: finalStatus === "cancelled" ? 2 : 0,
    }, onOpenConversation: id => opened.push(id) });
    const nodes = descendants(tree);
    const status = nodes.find(node => node.type === "RunStatus");
    assert.ok(status, "Terminal tasks must use the shared status presentation");
    assert.equal(status.props.status, expected);
    assert.equal(status.props.title, "隔离任务");
    if (finalStatus === "error") assert.match(JSON.stringify(nodes), /隔离生成失败/);
    tree.props.onClick();
  }
  assert.deepEqual(opened, Array(4).fill("isolated-conversation"));
});

test("canvas queue tasks preserve terminal status, progress and navigation", () => {
  const opened = [];
  const { CanvasQueueItem } = loadSource("../src/components/image-task-queue.tsx", {
    "@/lib/utils": { formatElapsedClock: seconds => `${seconds}s` },
  }, {}, "\nexport { CanvasQueueItem };\n");
  for (const [status, expected] of [["generating", "running"], ["success", "success"], ["error", "error"], ["cancelled", "cancelled"]]) {
    const tree = CanvasQueueItem({ item: {
      canvasID: "isolated-canvas", canvasTitle: "隔离画布", type: "video", title: "隔离视频",
      prompt: "隔离提示词", model: "isolated-model", status, totalCount: 2, completedCount: 1,
      failedCount: status === "error" ? 1 : 0, progress: 50, error: status === "error" ? "隔离保存失败" : "",
      startedAt: 1000, completedAt: status === "generating" ? undefined : 12000,
    }, now: 13000, onOpenCanvas: id => opened.push(id) });
    const nodes = descendants(tree);
    const presentation = nodes.find(node => node.type === "RunStatus");
    assert.ok(presentation, "Canvas tasks must use the shared status presentation");
    assert.equal(presentation.props.status, expected);
    assert.equal(presentation.props.title, "隔离视频");
    const progress = nodes.find(node => node.type === "GenerationProgress");
    assert.equal(progress.props.progress, 50);
    assert.match(JSON.stringify(nodes), /隔离画布/);
    assert.match(JSON.stringify(nodes), /isolated-model/);
    if (status === "error") assert.match(JSON.stringify(nodes), /隔离保存失败/);
    tree.props.onClick();
  }
  assert.deepEqual(opened, Array(4).fill("isolated-canvas"));
});

test("creation queue tasks keep waiting distinct from running and preserve counts", () => {
  const opened = [];
  const { QueueItem } = loadSource("../src/components/image-task-queue.tsx", {
    "@/lib/utils": { formatElapsedClock: seconds => `${seconds}s` },
    "@/lib/image-options": { isHighResolutionImageSize: () => false },
    "@/store/image-conversations": { getEffectiveImageTurnStatus: turn => turn.status },
    "@/store/image-turn-progress": { getImageTurnProgressSnapshot: () => ({}), imageTurnProgressKey: () => "isolated", imageTurnStartedAtTimestamp: () => 0 },
  }, {}, "\nexport { QueueItem };\n");
  for (const [status, expected] of [["queued", "waiting"], ["generating", "running"]]) {
    const tree = QueueItem({ item: {
      conversationId: "isolated-conversation", conversationTitle: "隔离视频任务",
      turn: { id: "turn", status, mode: "video", model: "isolated-model", prompt: "隔离提示词", size: "16:9", createdAt: "2026-11-10T00:00:00Z" },
      totalCount: 2, completedCount: 1, failedCount: 0, cancelledCount: 0,
      queuedCount: status === "queued" ? 1 : 0, runningCount: status === "generating" ? 1 : 0,
    }, now: 0, onOpenConversation: id => opened.push(id) });
    const nodes = descendants(tree);
    const presentation = nodes.find(node => node.type === "RunStatus");
    assert.ok(presentation, "Queued and active tasks must use shared status");
    assert.equal(presentation.props.status, expected);
    assert.equal(nodes.find(node => node.type === "GenerationProgress").props.progress, 50);
    assert.match(JSON.stringify(nodes), /1\/2/);
    tree.props.onClick();
  }
  assert.deepEqual(opened, Array(2).fill("isolated-conversation"));
});

test("queue toolbar never presents failed or stopped work as successful", () => {
  for (const status of ["success", "error", "cancelled"]) {
    const state = hooks();
    const { ImageTaskQueue } = loadSource("../src/components/image-task-queue.tsx", {
      react: state.react,
      "react-router-dom": { useNavigate: () => () => {} },
      "@/lib/use-now": { useNow: () => 0 },
      "@/store/image-turn-progress": { getImageTurnProgressSnapshot: () => ({}) },
      "@/store/canvas-task-queue": { getCanvasTaskQueueSnapshot: () => [{ id: "isolated", status }] },
    });
    const trigger = descendants(state.render(ImageTaskQueue)).find(node => node.type === "Button" && node.props["aria-label"]);
    assert.equal(trigger.props["aria-label"], "查看刚结束的任务");
    assert.equal(descendants(trigger).some(node => node.type === "Spinner" || node.type === "CheckCircle2"), false);
    assert.equal(descendants(trigger).some(node => node.type === "ClipboardList"), true);
  }
});

test("queue toolbar distinguishes queued work from work that has started", () => {
  for (const status of ["queued", "generating"]) {
    const state = hooks();
    let firstState = true;
    const { ImageTaskQueue } = loadSource("../src/components/image-task-queue.tsx", {
      react: { ...state.react, useState(initial) {
        if (firstState) {
          firstState = false;
          return state.react.useState([{ id: "isolated-conversation", turns: [{ id: "turn", createdAt: "2026-11-10", count: 1, images: [] }] }]);
        }
        return state.react.useState(initial);
      } },
      "react-router-dom": { useNavigate: () => () => {} },
      "@/lib/use-now": { useNow: () => 0 },
      "@/store/image-conversations": {
        getEffectiveImageTurnStatus: () => status,
        getImageTurnLoadingCounts: () => ({ queued: status === "queued" ? 1 : 0, running: status === "generating" ? 1 : 0 }),
      },
      "@/store/image-turn-progress": { getImageTurnProgressSnapshot: () => ({}) },
      "@/store/canvas-task-queue": { getCanvasTaskQueueSnapshot: () => [] },
    });
    const trigger = descendants(state.render(ImageTaskQueue)).find(node => node.type === "Button" && node.props["aria-label"]);
    const nodes = descendants(trigger);
    assert.equal(nodes.some(node => node.type === "Spinner"), status === "generating");
    assert.equal(nodes.some(node => node.type === "Clock3"), status === "queued");
  }
});

test("navigation session verification handles network rejection", async () => {
  const state = hooks();
  let attempts = 0;
  const { TopNav } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "@/lib/use-active-navigation": loadSource("../src/lib/use-active-navigation.ts", { react: state.react }),
    "react-router-dom": { useLocation: () => ({ pathname: "/studio" }), useNavigate: () => () => {} },
    "@/lib/session": {
      getCachedAuthSession: () => null,
      async getVerifiedAuthSession() { attempts++; throw new Error("network unavailable"); },
    },
    "@/lib/use-app-meta": { useAppMeta: () => ({}) },
    "@/lib/theme": { getPreferredColorTheme: () => "light" },
  });
  state.render(TopNav);
  const cleanup = state.effects[0]();
  await flush();
  assert.equal(attempts, 1);
  cleanup();
});

test("management navigation opens on hover, stays open across the gap, and closes after leaving", () => {
  const state = hooks();
  const pending = new Map();
  let timer = 0;
  const { ManagementNavigationMenu } = loadSource("../src/components/top-nav.tsx", { react: state.react }, {
    window: { setTimeout: callback => { pending.set(++timer, callback); return timer; }, clearTimeout: id => pending.delete(id) },
    requestAnimationFrame: callback => callback(),
  }, "\nexports.ManagementNavigationMenu = ManagementNavigationMenu;");
  const props = { items: [{ href: "/users", label: "用户管理", icon: "svg" }], pathname: "/studio", pinnedPaths: [], onPreloadRoute() {}, onTogglePin() {} };
  const render = () => descendants(state.render(ManagementNavigationMenu, props));
  let nodes = render();
  const trigger = () => nodes.find(node => node.props?.["aria-label"] === "管理中心" && node.type === "Button");
  trigger().props.onPointerEnter({ pointerType: "mouse" });
  nodes = render();
  assert.equal(nodes.find(node => node.type === "Popover").props.open, true);
  trigger().props.onPointerLeave({ pointerType: "mouse" });
  assert.equal(pending.size, 1);
  nodes.find(node => node.type === "PopoverContent").props.onPointerEnter();
  assert.equal(pending.size, 0);
  nodes.find(node => node.type === "PopoverContent").props.onPointerLeave({ pointerType: "mouse" });
  [...pending.values()][0]();
  nodes = render();
  assert.equal(nodes.find(node => node.type === "Popover").props.open, false);
});

test("management navigation supports touch and keyboard and pinning never follows its link", () => {
  const state = hooks();
  const toggled = [];
  let timers = 0;
  const { ManagementNavigationMenu } = loadSource("../src/components/top-nav.tsx", { react: state.react }, {
    window: { setTimeout: () => { timers++; return 1; }, clearTimeout() {} }, requestAnimationFrame: callback => callback(),
  }, "\nexports.ManagementNavigationMenu = ManagementNavigationMenu;");
  const props = { items: [{ href: "/users", label: "用户管理", icon: "svg" }], pathname: "/studio", pinnedPaths: [], onPreloadRoute() {}, onTogglePin: path => toggled.push(path) };
  const render = () => descendants(state.render(ManagementNavigationMenu, props));
  let nodes = render();
  let trigger = nodes.find(node => node.props?.["aria-label"] === "管理中心" && node.type === "Button");
  trigger.props.onPointerEnter({ pointerType: "touch" });
  assert.equal(render().find(node => node.type === "Popover").props.open, false);
  trigger.props.onClick({ preventDefault() {} });
  trigger.props.onPointerLeave({ pointerType: "touch" });
  assert.equal(timers, 0);
  nodes = render();
  assert.equal(nodes.find(node => node.type === "Popover").props.open, true);
  nodes.find(node => node.props?.["aria-label"] === "置顶用户管理").props.onClick();
  assert.deepEqual(toggled, ["/users"]);
  assert.equal(render().find(node => node.type === "Popover").props.open, true);
  props.pinnedPaths = ["/users"];
  nodes = render();
  assert.equal(nodes.find(node => node.props?.["aria-label"] === "取消置顶用户管理").props["aria-pressed"], true);
  nodes.find(node => node.type === "Popover").props.onOpenChange(false);
  nodes = render();
  trigger = nodes.find(node => node.props?.["aria-label"] === "管理中心" && node.type === "Button");
  let prevented = false;
  trigger.props.onKeyDown({ key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(render().find(node => node.type === "Popover").props.open, true);
});

test("only management entries can be pinned while creation and resource links stay permanent", () => {
  const state = hooks();
  const writes = [];
  const { NavigationRail } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "@/lib/navigation-pins": { readNavigationPins: (_, available) => { assert.deepEqual([...available], ["/users", "/logs"]); return []; }, writeNavigationPins: (scope, paths) => writes.push({ scope, paths: [...paths] }) },
  }, {}, "\nexports.NavigationRail = NavigationRail;");
  const props = { scope: "account-a", pathname: "/studio", onPreloadRoute() {}, items: [
    { href: "/studio", group: "creation", label: "创作台" },
    { href: "/canvas", group: "creation", label: "无限画布" },
    { href: "/workflows", group: "creation", label: "工作流" },
    { href: "/prompt-library", group: "resources", label: "提示词库" },
    { href: "/assets", group: "resources", label: "我的素材" },
    { href: "/users", group: "management", label: "用户管理" },
    { href: "/logs", group: "management", label: "日志管理" },
  ] };
  const render = () => descendants(state.render(NavigationRail, props));
  const links = () => render().flatMap(node => node.type === "SortableList"
    ? descendants({ props: { children: node.props.children(node.props.values) } })
    : [node]).filter(node => node.type?.name === "NavPill").map(node => node.props.item.href);
  const fixed = ["/studio", "/canvas", "/workflows", "/prompt-library", "/assets"];
  assert.deepEqual(links(), fixed);
  const menu = render().find(node => node.type?.name === "ManagementNavigationMenu");
  assert.deepEqual(menu.props.items.map(item => item.href), ["/users", "/logs"]);
  menu.props.onTogglePin("/users");
  assert.deepEqual(links(), [...fixed, "/users"]);
  render().find(node => node.type?.name === "ManagementNavigationMenu").props.onTogglePin("/logs");
  assert.deepEqual(links(), [...fixed, "/logs", "/users"]);
  render().find(node => node.type?.name === "ManagementNavigationMenu").props.onTogglePin("/users");
  assert.deepEqual(links(), [...fixed, "/logs"]);
  assert.deepEqual(writes, [{ scope: "account-a", paths: ["/users"] }, { scope: "account-a", paths: ["/logs", "/users"] }, { scope: "account-a", paths: ["/logs"] }]);
});


test("prompt category selection uses shared list navigation and searches both names and IDs", () => {
  const state = hooks();
  const sources = [{ id: "alpha-source", label: "摄影", enabled: true }, { id: "beta-source", label: "插画", enabled: true }];
  const { ImagePromptMarket } = loadSource("../src/app/image/components/image-prompt-market.tsx", {
    react: state.react,
    "@/app/image/banana-prompts": { DEFAULT_PROMPT_MARKET_SOURCES: sources, sortPromptMarketPrompts: items => items },
    "@/app/image/prompt-favorite-request-lifecycle": { PromptFavoriteRequestLifecycle: class {} },
  });
  const render = () => descendants(state.render(ImagePromptMarket, { open: true, presentation: "page", onOpenChange() {}, onApplyPrompt() {} }));
  let nodes = render();
  let select = nodes.find(node => node.type === "Combobox");
  assert.equal(select.props.value.id, "all");
  assert.equal(select.props.filter(sources[0], " ALPHA "), true);
  assert.equal(select.props.filter(sources[0], "摄影"), true);
  assert.equal(select.props.filter(sources[0], "插画"), false);
  select.props.onValueChange(sources[1]);
  nodes = render();
  select = nodes.find(node => node.type === "Combobox");
  assert.equal(select.props.value.id, "beta-source");
  assert.equal(select.props.itemToStringLabel(sources[1]), "插画");
  assert.equal(select.props.isItemEqualToValue(sources[1], { ...sources[1] }), true);
  select.props.onValueChange(null);
  assert.equal(render().find(node => node.type === "Combobox").props.value.id, "beta-source");
  const option = nodes.find(node => node.type === "ComboboxList").props.children(sources[0]);
  assert.equal(option.type, "ComboboxItem");
  assert.equal(option.props.value, sources[0]);
});

test("workflow history opens and copies through separate native button controls", async () => {
  const state = hooks();
  const opened = [], copied = [];
  const { CodeBlockCopyButton } = loadSource("../src/components/ui/code-block.tsx", {
    react: state.react,
    "class-variance-authority": { cva: () => () => "" },
    "@/lib/clipboard-text": { copyClipboardText: async value => copied.push(value) },
  });
  const { WorkflowTaskRow } = loadSource("../src/app/workflows/creative-workflow-workspace.tsx", {
    "@/components/ui/code-block": { CodeBlockCopyButton },
  }, {}, "\nexport { WorkflowTaskRow };\n");
  const tree = WorkflowTaskRow({ task: { workflow_name: "样例工作流", prompt: "测试提示词", images: [], status: "success", started_at: 0, ended_at: 1000, count: 1 }, now: 1000, onOpen: () => opened.push(true) });
  const nodes = descendants(tree);
  const open = nodes.find(node => node.type === "Button" && node.props["aria-label"] === "查看任务：样例工作流");
  const copy = nodes.find(node => node.type === CodeBlockCopyButton && node.props["aria-label"] === "复制提示词");
  assert.ok(copy, "Task prompt copying must use the shared copy control");
  assert.equal(open.props.type, "button");
  assert.equal(copy.props.type, "button");
  assert.equal(descendants(open).includes(copy), false);
  assert.equal(nodes.some(node => node.props?.role === "button"), false);
  const copyButton = descendants(state.render(CodeBlockCopyButton, copy.props)).find(node => node.type === "Button");
  copyButton.props.onClick(event(null));
  await flush();
  assert.deepEqual(copied, ["测试提示词"]);
  assert.deepEqual(opened, []);
  open.props.onClick();
  assert.deepEqual(opened, [true]);
});

test("script reference and asset dialog upload controls preserve repeated file selection", () => {
  for (const kind of ["reference", "asset"]) {
    const state = hooks();
    const uploaded = [];
    let closed = 0;
    const exports = kind === "reference"
      ? loadSource("../src/app/canvas/canvas-script-node.tsx", { react: state.react })
      : loadSource("../src/app/canvas/canvas-script-assets.tsx", {
        react: state.react,
        "@/lib/use-my-assets": { useMyAssets: () => ({ assets: [], loading: false }) },
      });
    const render = disabled => descendants(state.render(kind === "reference" ? exports.CanvasScriptPromptPanel : exports.ScriptAssetImageDialog,
      kind === "reference"
        ? { node: {}, references: [], models: [], defaultModel: "", running: disabled, onUploadReference: file => uploaded.push(file) }
        : { asset: { id: "hero", name: "主角", description: "红色雨衣" }, nodes: [], initialTab: "canvas", scope: "isolated", imageDefaults: {}, imageModels: [], imageModel: "", disabled, onUpload: file => uploaded.push(file), onClose: () => closed++ }));
    const nodes = render(false);
    const input = nodes.find(node => node.type === "input");
    const label = kind === "reference" ? "上传脚本参考图" : "上传资产图片";
    const buttonType = kind === "reference" ? "Button" : "FileUploadButton";
    const button = nodes.find(node => node.type === buttonType && (kind === "asset" || node.props["aria-label"] === label));
    let picks = 0;
    input.props.ref.current = { click: () => picks++ };
    button.props.onClick();
    assert.equal(picks, 1);
    assert.equal(button.props.disabled, false);
    assert.equal(input.props.hidden, true);
    const file = { name: "reference.png" };
    const selection = { target: { files: [file], value: "reference.png" } };
    input.props.onChange(selection);
    assert.equal(selection.target.value, "");
    input.props.onChange({ target: { files: [file], value: "reference.png" } });
    input.props.onChange({ target: { files: [], value: "" } });
    assert.deepEqual(uploaded, [file, file]);
    assert.equal(closed, kind === "asset" ? 2 : 0);
    for (const node of render(true).filter(node => node.type === "input" || node.type === "FileUploadButton" || node.type === "Button" && node.props["aria-label"] === label)) assert.equal(node.props.disabled, true);
  }
});

test("script asset cards open the shared image picker and lock while generating", () => {
  const state = hooks();
  let loadingImage = false;
  let choices = 0;
  const { ScriptAssetCard } = loadSource("../src/app/canvas/canvas-script-assets.tsx", {
    react: state.react,
    "./canvas-script": { scriptAssetImage: () => loadingImage ? { generation_status: "loading" } : undefined },
  });
  const render = disabled => descendants(state.render(ScriptAssetCard, { asset: { name: "主角" }, nodes: [], disabled, onChoose: () => choices++ }));
  const button = render(false).find(node => node.type === "Button" && node.props["aria-label"] === "选择主角图片");
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(choices, 1);
  assert.equal(render(false).some(node => node.type === "input"), false);
  for (const disabled of [false, true]) {
    loadingImage = !disabled;
    const controls = render(disabled).filter(node => node.type === "Button");
    assert.equal(controls.length, 2);
    assert.ok(controls.every(node => node.props.disabled));
  }
});

test("conversation rows keep pin and menu actions independent from opening a conversation", () => {
  const state = hooks();
  const opened = [], pinned = [], renamed = [], deleted = [];
  const { ImageSidebar } = loadSource("../src/app/image/components/image-sidebar.tsx", {
    react: state.react,
    "@/lib/use-app-meta": { useAppMeta: () => ({ app_title: "Test" }) },
    "@/app/image/use-history-download": { useHistoryDownload: () => ({ selecting: false, busy: false, selected: new Set() }) },
    "@/store/image-conversations": { getImageConversationStats: (item) => ({ running: item.id === "b" ? 1 : 0, queued: 0 }) },
  });
  const nodes = descendants(state.render(ImageSidebar, {
    conversations: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }],
    pinnedIds: ["b"], unreadIds: ["a"], selectedConversationId: null,
    onSelectConversation: id => opened.push(id), onTogglePin: id => pinned.push(id),
    onRenameConversation: id => renamed.push(id), onDeleteConversation: id => deleted.push(id),
  }));
  assert.deepEqual(nodes.filter(node => node.props?.["data-conversation-id"]).map(node => node.props["data-conversation-id"]), ["b", "a"]);
  assert.equal(nodes.filter(node => node.type === "Spinner").length, 1);
  assert.equal(nodes.filter(node => node.props?.["aria-label"] === "任务已完成，未查看").length, 1);
  nodes.find(node => node.props?.["aria-label"] === "取消置顶会话：Beta").props.onClick();
  const menus = descendants(nodes.find(node => node.props?.["data-conversation-id"] === "b")).filter(node => node.type === "DropdownMenuItem");
  menus[0].props.onSelect();
  menus[1].props.onSelect();
  menus[2].props.onSelect();
  assert.deepEqual(opened, []);
  assert.deepEqual(pinned, ["b", "b"]);
  assert.deepEqual(renamed, ["b"]);
  assert.deepEqual(deleted, ["b"]);
  nodes.find(node => node.type === "Button" && Object.hasOwn(node.props, "aria-current")).props.onClick();
  assert.deepEqual(opened, ["b"]);
});

test("studio sidebar persists pins by account and only marks newly finished conversations unread", () => {
  const state = hooks();
  const storage = new Map();
  const { useStudioSidebar, readStudioSidebarPreferences } = loadSource("../src/app/image/use-studio-sidebar.ts", {
    react: state.react,
    "@/store/image-conversations": { getImageConversationStats: item => ({ running: item.running || 0, queued: item.queued || 0 }) },
  }, { window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } } });
  let items = [{ id: "a", running: 1 }, { id: "b", queued: 1 }, { id: "old" }];
  const render = (selected = null, ready = true) => state.render(() => useStudioSidebar("account-a", items, selected, ready));
  const runEffects = () => state.effects.forEach(effect => effect());
  let result = render(); runEffects();
  assert.deepEqual(Array.from(result.unreadIds), []);
  result.togglePin("b");
  result = render(); runEffects();
  assert.deepEqual(Array.from(readStudioSidebarPreferences("account-a").pinnedIds), ["b"]);
  assert.deepEqual(Array.from(readStudioSidebarPreferences("account-b").pinnedIds), []);
  items = [{ id: "a" }, { id: "b", running: 1 }, { id: "old" }];
  render(null, false); runEffects();
  render(); runEffects();
  result = render(); runEffects();
  assert.deepEqual(Array.from(result.unreadIds), ["a"]);
  render("a"); runEffects();
  result = render("a"); runEffects();
  assert.deepEqual(Array.from(result.unreadIds), []);
  items = [{ id: "a" }, { id: "b" }, { id: "old" }];
  render("a"); runEffects();
  result = render("a"); runEffects();
  assert.deepEqual(Array.from(result.unreadIds), ["b"]);
  assert.deepEqual(Array.from(readStudioSidebarPreferences("account-a").unreadIds), ["b"]);
  result.togglePin("b");
  result = render();
  assert.deepEqual(Array.from(result.pinnedIds), []);
});

test("studio sidebar tolerates malformed preferences and does not mark removed work completed", () => {
  const state = hooks();
  const { useStudioSidebar, readStudioSidebarPreferences } = loadSource("../src/app/image/use-studio-sidebar.ts", {
    react: state.react,
    "@/store/image-conversations": { getImageConversationStats: item => ({ running: item.running || 0, queued: 0 }) },
  }, { window: { localStorage: { getItem: () => "invalid", setItem() { throw new Error("blocked"); } } } });
  assert.deepEqual(Array.from(readStudioSidebarPreferences("a").pinnedIds), []);
  state.render(() => useStudioSidebar("a", [{ id: "deleted", running: 1 }], null, true));
  state.effects.forEach(effect => effect());
  state.render(() => useStudioSidebar("a", [], null, true));
  state.effects.forEach(effect => effect());
  const result = state.render(() => useStudioSidebar("a", [], null, true));
  assert.deepEqual(Array.from(result.unreadIds), []);
});


test("conversation batch selection uses the filtered list and never opens a selected conversation", () => {
  const state = hooks();
  const opened = [];
  let cleared = 0, downloads = 0, cancelled = 0;
  const batch = {
    selecting: false, selected: new Set(), busy: false,
    setSelecting(value) { this.selecting = value; },
    setSelected(value) { this.selected = typeof value === "function" ? value(this.selected) : value; },
    toggle(id) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); },
    download() { downloads++; }, cancel() { cancelled++; },
  };
  const { ImageSidebar } = loadSource("../src/app/image/components/image-sidebar.tsx", {
    react: state.react,
    "@/lib/use-app-meta": { useAppMeta: () => ({ app_title: "Test" }) },
    "@/app/image/use-history-download": { useHistoryDownload: () => batch },
    "@/store/image-conversations": { getImageConversationStats: () => ({ running: 0, queued: 0 }) },
  });
  const props = {
    conversations: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }],
    pinnedIds: [], unreadIds: [], onSelectConversation: id => opened.push(id), onClearHistory: () => { cleared++; },
  };
  const render = () => descendants(state.render(ImageSidebar, props));
  let nodes = render();
  nodes.find(node => node.type === "DropdownMenuItem" && node.props.variant === "destructive").props.onSelect();
  assert.equal(cleared, 1);
  nodes.find(node => node.type === "DropdownMenuItem" && !node.props.variant).props.onSelect();
  nodes = render();
  assert.equal(batch.selecting, true);
  assert.equal(nodes.find(node => node.props?.["aria-label"] === "下载所选会话").props.disabled, true);
  const row = descendants(nodes.find(node => node.props?.["data-conversation-id"] === "a"));
  row.find(node => node.type === "Button").props.onClick();
  assert.deepEqual(opened, []);
  assert.deepEqual([...batch.selected], ["a"]);
  nodes.find(node => node.props?.["aria-label"] === "搜索会话").props.onClick();
  nodes = render();
  nodes.find(node => node.type === "SearchInput").props.onValueChange("Beta");
  nodes = render();
  nodes.find(node => node.props?.["aria-label"] === "全选当前列表").props.onCheckedChange(true);
  assert.deepEqual([...batch.selected], ["a", "b"]);
  nodes = render();
  nodes.find(node => node.props?.["aria-label"] === "全选当前列表").props.onCheckedChange(false);
  assert.deepEqual([...batch.selected], ["a"]);
  nodes = render();
  nodes.find(node => node.props?.["aria-label"] === "下载所选会话").props.onClick();
  assert.equal(downloads, 1);
  batch.busy = true;
  nodes = render();
  assert.equal(nodes.find(node => node.type === "Button" && Object.hasOwn(node.props, "aria-current")).props.disabled, true);
  assert.equal(nodes.find(node => node.props?.["aria-label"] === "下载所选会话").props.disabled, true);
  nodes.find(node => node.props?.["aria-label"] === "取消下载").props.onClick();
  assert.equal(cancelled, 1);
  batch.busy = false;
  nodes = render();
  nodes.find(node => node.props?.["aria-label"] === "退出选择").props.onClick();
  assert.equal(batch.selecting, false);
  assert.equal(batch.selected.size, 0);
});

test("notification panels follow the navigation placement when the viewport changes", () => {
  const state = hooks();
  const listeners = new Map();
  const query = {
    matches: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  const { TopNav } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "react-router-dom": { useLocation: () => ({ pathname: "/studio" }), useNavigate: () => () => {} },
    "@/lib/session": { getCachedAuthSession: () => ({ key: "session", role: "admin" }) },
    "@/lib/auth-session": { canAccessPath: () => true },
    "@/lib/use-app-meta": { useAppMeta: () => ({ app_title: "Test" }) },
    "@/lib/app-meta": { resolveSiteIconSrc: () => "/icon.svg" },
  }, { window: { matchMedia: () => query } });
  const widgets = tree => descendants(tree).filter(node => node.type === "ImageTaskQueue" || node.type === "AnnouncementCenter");
  state.render(TopNav);
  const cleanup = state.effects.at(-1)();
  assert.deepEqual(widgets(state.render(TopNav)).map(node => node.props.side), ["bottom", "bottom"]);
  query.matches = true;
  listeners.get("change")();
  assert.deepEqual(widgets(state.render(TopNav)).map(node => node.props.side), ["right", "right"]);
  cleanup();
  assert.equal(listeners.size, 0);
});

test("settings search matches categories and keywords without changing the active destination", () => {
  const state = hooks();
  const { SectionNavigation } = loadSource("../src/components/section-navigation.tsx", { react: state.react, "@/lib/use-active-navigation": { useActiveNavigation: () => ({ current: null }) } });
  const props = { activeId: "account", items: [
    { id: "account", label: "账户信息", group: "个人设置", keywords: "余额", href: "/profile#account", icon: "svg" },
    { id: "keys", label: "API 密钥", group: "个人设置", keywords: "Key 自定义接口", href: "/profile#keys", icon: "svg" },
    { id: "config", label: "站点与运行", group: "系统管理", keywords: "数据库", href: "/settings#config", icon: "svg" },
  ] };
  const render = () => descendants(state.render(SectionNavigation, props));
  let nodes = render();
  assert.equal(nodes.filter(node => node.type === "Link").length, 3);
  nodes.find(node => node.type === "SearchInput").props.onValueChange("key");
  nodes = render();
  assert.deepEqual(nodes.filter(node => node.type === "Link").map(node => node.props.to), ["/profile#keys"]);
  nodes.find(node => node.type === "SearchInput").props.onValueChange("系统");
  nodes = render();
  assert.deepEqual(nodes.filter(node => node.type === "Link").map(node => node.props.to), ["/settings#config"]);
  nodes.find(node => node.type === "SearchInput").props.onValueChange("no-match");
  nodes = render();
  const empty = nodes.find(node => node.type === "EmptyState");
  assert.ok(empty);
  empty.props.action.props.onClick();
  nodes = render();
  assert.equal(nodes.find(node => node.type === "Link" && node.props["aria-current"] === "page").props.to, "/profile#account");
  nodes.find(node => node.props?.["aria-label"] === "展开设置分类").props.onClick();
  nodes = render();
  assert.equal(nodes.find(node => node.props?.["aria-label"] === "展开设置分类").props["aria-expanded"], true);
  nodes.find(node => node.type === "Link").props.onClick();
  assert.equal(render().find(node => node.props?.["aria-label"] === "展开设置分类").props["aria-expanded"], false);
});

test("appearance settings use the existing theme state and ignore an empty toggle selection", () => {
  const calls = [];
  const { AppearanceSettings } = loadSource("../src/app/profile/appearance-settings.tsx", {
    "@/lib/use-color-theme": { useColorTheme: () => "light" },
    "@/lib/theme": { applyColorTheme: value => calls.push(["apply", value]), saveColorTheme: value => calls.push(["save", value]) },
  });
  const group = descendants(AppearanceSettings()).find(node => node.type === "ToggleGroup");
  assert.equal(group.props.value, "light");
  group.props.onValueChange("");
  assert.deepEqual(calls, []);
  group.props.onValueChange("dark");
  assert.deepEqual(calls, [["apply", "dark"], ["save", "dark"]]);
});


test("navigation selects the solid icon only for its active route", () => {
  const { NavPill } = loadSource("../src/components/top-nav.tsx", {}, {}, "\nexport { NavPill };\n");
  const item = { href: "/canvas", label: "无限画布", icon: "canvas" };
  for (const [pathname, active] of [["/canvas", true], ["/canvas/project", true], ["/studio", false]]) {
    const nodes = descendants(NavPill({ item, pathname, compact: true, onPreloadRoute() {} }));
    assert.equal(nodes.find(node => node.type === "NavigationIcon").props.active, active);
    assert.equal(nodes.find(node => node.type === "NavigationIcon").props.name, "canvas");
  }
});

test("navigation icon variants keep the icon size while switching from outline to solid", () => {
  const { NavigationIcon } = loadSource("../src/components/navigation-icon.tsx");
  for (const name of ["home", "canvas", "workflow", "book", "folder", "users", "shield", "logs", "settings"]) {
    const outline = NavigationIcon({ name, active: false, className: "icon-size" });
    const solid = NavigationIcon({ name, active: true, className: "icon-size" });
    assert.equal(outline.props["data-navigation-icon"], "outline");
    assert.equal(solid.props["data-navigation-icon"], "solid");
    assert.equal(solid.props.fill, "currentColor");
    assert.equal(outline.props.className, solid.props.className);
    assert.equal(solid.props["aria-hidden"], "true");
  }
});

test("the account menu contains account actions while theme switching stays independent", () => {
  const state = hooks();
  const { AccountMenu } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "@/lib/session": { displaySubjectId: () => "admin" },
  }, {}, "\nexport { AccountMenu };\n");
  const nodes = descendants(state.render(AccountMenu, { session: { name: "Admin", role: "admin" }, roleLabel: "管理员", pathname: "/studio", onPreloadRoute() {}, onLogout() {} }));
  assert.equal(nodes.filter(node => node.type === "ThemeToggle").length, 0);
  assert.ok(nodes.find(node => node.type === "Link" && node.props.to === "/profile"));
});

test("library sidebar preserves desktop collapse and mobile filtering across viewport changes", () => {
  for (const desktop of [false, true]) {
    const state = hooks();
    let resize;
    const query = { matches: desktop, addEventListener: (_, listener) => { resize = listener; }, removeEventListener() {} };
    class Target {
      constructor(filter) { this.filter = filter; }
      closest(selector) { return selector === "[data-library-filter]" && this.filter ? this : null; }
    }
    const { LibraryWorkspace } = loadSource("../src/components/library-workspace.tsx", { react: { ...state.react, useId: () => "library-sidebar" } }, { Element: Target, window: { matchMedia: () => query } });
    const render = () => state.render(LibraryWorkspace, { title: "工作流", sidebar: "categories", children: toggle => toggle });
    const toggle = tree => descendants(tree).find(node => node.props?.["aria-expanded"] !== undefined);
    const aside = tree => descendants(tree).find(node => node.type === "aside");
    let tree = render();
    state.effects.forEach(effect => effect());
    assert.equal(toggle(tree).props["aria-expanded"], desktop);
    assert.equal(toggle(tree).props["aria-controls"], aside(tree).props.id);
    if (desktop) {
      toggle(tree).props.onClick();
      tree = render();
      assert.equal(toggle(tree).props["aria-expanded"], false);
      assert.equal(aside(tree).props.inert, true);
    }
    toggle(tree).props.onClick();
    tree = render();
    assert.equal(toggle(tree).props["aria-expanded"], true);
    const sidebar = descendants(tree).find(node => node.type === "div" && node.props?.onClick);
    sidebar.props.onClick({ target: new Target(false) });
    assert.equal(toggle(render()).props["aria-expanded"], true);
    sidebar.props.onClick({ target: new Target(true) });
    assert.equal(toggle(render()).props["aria-expanded"], desktop, "only mobile filter selection dismisses the panel");
    if (desktop) {
      tree = render();toggle(tree).props.onClick();
      query.matches = false;resize();
      assert.equal(toggle(render()).props["aria-expanded"], false);
      query.matches = true;resize();
      assert.equal(toggle(render()).props["aria-expanded"], false, "resizing retains the desktop collapse preference");
    }
  }
});

test("library sidebar animates position without resizing content and cancels interrupted motion", () => {
  for (const reducedMotion of [false, true]) {
    const state = hooks();
    const effects = [];
    const animations = [];
    let left = 248;
    const content = {
      getBoundingClientRect: () => ({ left }),
      animate(keyframes) {
        const animation = { keyframes, cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(animation);
        return animation;
      },
    };
    const { LibraryWorkspace } = loadSource("../src/components/library-workspace.tsx", {
      react: { ...state.react, useId: () => "sidebar", useLayoutEffect: effect => effects.push(effect) },
    }, { window: { matchMedia: query => ({ matches: query.includes("reduced-motion") ? reducedMotion : true }) } });
    const render = () => state.render(LibraryWorkspace, { title: "工作流", children: toggle => toggle });
    let tree = render();
    tree.props.children.at(-1).props.ref.current = content;
    effects.at(-1)();
    const toggle = tree => descendants(tree).find(node => node.props?.["aria-expanded"] !== undefined);
    toggle(tree).props.onClick();
    left = 0;
    tree = render();
    const cleanup = effects.at(-1)();
    assert.equal(animations.length, reducedMotion ? 0 : 1);
    if (reducedMotion) continue;
    assert.equal(animations[0].keyframes[0].transform, "translateX(248px)");
    assert.ok(animations[0].keyframes.every(frame => Object.keys(frame).join() === "transform"));
    left = 80;
    toggle(tree).props.onClick();
    cleanup();
    assert.equal(animations[0].cancelled, true);
    left = 248;
    render();
    effects.at(-1)();
    assert.equal(animations[1].keyframes[0].transform, "translateX(-168px)", "resume from the current visual position");
  }
});

test("workflow list passes the selected workflow to actions and protects shared entries", () => {
  const { WorkflowList } = loadSource("../src/app/workflows/workflow-list.tsx");
  const own = { id: "own", name: "自己的工作流", editable: true, scope: "private" };
  const shared = { id: "shared", name: "共享工作流", editable: false, scope: "public" };
  const calls = [];
  const callbacks = Object.fromEntries(["onRun", "onEdit", "onCopy", "onDelete"].map(action => [action, workflow => calls.push([action, workflow.id])]));
  const rows = descendants(WorkflowList({ items: [own, shared], ...callbacks })).filter(node => node.type === "TableRow" && node.key);
  const ownNodes = descendants(rows[0]);
  ownNodes.find(node => node.props?.["aria-label"] === "运行工作流：自己的工作流").props.onClick();
  const ownActions = ownNodes.filter(node => node.type === "DropdownMenuItem");
  assert.equal(ownActions.length, 3);
  ownActions.forEach(node => node.props.onSelect());
  const sharedActions = descendants(rows[1]).filter(node => node.type === "DropdownMenuItem");
  assert.equal(sharedActions.length, 1);
  sharedActions[0].props.onSelect();
  assert.deepEqual(calls, [["onRun", "own"], ["onEdit", "own"], ["onCopy", "own"], ["onDelete", "own"], ["onCopy", "shared"]]);
});

test("asset list preserves selection and only exposes allowed mutations", () => {
  const { AssetListRow } = loadSource("../src/app/assets/asset-display.tsx", { "@/app/assets/asset-library": { formatAssetCreatedTime: value => value } });
  for (const kind of ["text", "image"]) {
    const calls = [];
    const props = { asset: { id: "one", title: "素材", kind, createdAt: "today" }, onOpen: () => calls.push("open"), onCopy: () => calls.push("copy"), onDownload: () => calls.push("download"), onSelectedChange: value => calls.push(value) };
    const nodes = descendants(AssetListRow(props));
    nodes.find(node => node.type === "Checkbox").props.onCheckedChange(true);
    nodes.find(node => node.props?.["aria-label"] === "查看素材 素材").props.onClick();
    const menu = nodes.filter(node => node.type === "DropdownMenuItem");
    assert.equal(menu.length, 2);
    menu[1].props.onSelect();
    assert.deepEqual(calls, [true, "open", kind === "text" ? "copy" : "download"]);
    const editable = descendants(AssetListRow({ ...props, selected: true, onEdit: () => calls.push("edit"), onDelete: () => calls.push("delete") }));
    const editableMenu = editable.filter(node => node.type === "DropdownMenuItem");
    assert.equal(editableMenu.length, 4);
    editableMenu[2].props.onSelect();
    editableMenu[3].props.onSelect();
    assert.deepEqual(calls.slice(-2), ["edit", "delete"]);
  }
});

test("asset card selection and compact actions stay independent and respect available permissions", async () => {
  const state = hooks();
  const copyState = hooks();
  const copied = [];
  const { CodeBlockCopyButton } = loadSource("../src/components/ui/code-block.tsx", {
    react: copyState.react,
    "class-variance-authority": { cva: () => () => "" },
    "@/lib/clipboard-text": { copyClipboardText: async text => copied.push(text) },
  });
  const { AssetCard } = loadSource("../src/app/assets/asset-display.tsx", {
    react: state.react,
    "@/app/assets/asset-library": { assetModel: () => "complete-model-name", formatAssetCreatedTime: value => value },
    "@/components/ui/code-block": { CodeBlockCopyButton },
  });
  for (const kind of ["image", "text"]) {
    const calls = [];
    const props = {
      asset: { id: "one", title: "素材", kind, content: "素材完整文本", createdAt: "today", visibility: "private", owned: true, source: "创作台" },
      onOpen: () => calls.push("open"), onDownload: () => calls.push("download"),
      onSelectedChange: value => calls.push(value),
    };
    let nodes = descendants(state.render(AssetCard, props));
    nodes.find(node => node.type === "Checkbox").props.onCheckedChange(true);
    assert.deepEqual(calls, [true]);
    const action = label => nodes.find(node => node.type === "Button" && node.props["aria-label"] === label);
    if (kind === "text") {
      const copy = nodes.find(node => node.type === CodeBlockCopyButton);
      assert.equal(copy.props.value, props.asset.content);
      descendants(copyState.render(CodeBlockCopyButton, copy.props)).find(node => node.type === "Button").props.onClick(event(null));
      await flush();
      assert.deepEqual(copied, [props.asset.content]);
      assert.deepEqual(calls, [true]);
    } else {
      action("下载素材").props.onClick();
    }
    assert.equal(action("编辑素材"), undefined);
    assert.equal(action("删除素材"), undefined);
    nodes = descendants(state.render(AssetCard, { ...props, onEdit: () => calls.push("edit"), onDelete: () => calls.push("delete") }));
    action("编辑素材").props.onClick();
    action("删除素材").props.onClick();
    action("查看素材 素材").props.onClick();
    assert.deepEqual(calls, [true, ...(kind === "text" ? [] : ["download"]), "edit", "delete", "open"]);
    const model = nodes.find(node => node.props?.["data-asset-model"] !== undefined);
    assert.ok(descendants(model).some(node => node.props?.children === "complete-model-name"));
  }
});

test("tag creation snapshots selected assets and preserves removal from the current tag", async () => {
  const state = hooks();
  const mutations = [];
  const changes = [];
  const { AssetGroupMenu } = loadSource("../src/app/assets/asset-groups.tsx", {
    react: state.react,
    sonner: { toast: { success() {} } },
    "@/lib/my-assets-core": { createMyAssetId: () => "new-tag" },
  });
  const props = { state: { groups: [{ id: "tag", name: "品牌", assetKeys: ["self:a"] }], loading: false, busy: false, error: "", mutate: async (method, body) => { mutations.push([method, body]); return true; } }, filter: "tag", onFilterChange: value => changes.push(value), selectedKeys: ["self:a"], availableKeys: new Set(["self:a"]) };
  const render = (extra = {}) => state.render(AssetGroupMenu, { ...props, ...extra });
  let tree = render();
  descendants(tree).find(node => node.type === "Button" && node.props.children?.includes("新建标签")).props.onClick();
  tree = render({ selectedKeys: ["self:b"] });
  descendants(tree).find(node => node.type === "Input").props.onChange({ target: { value: "新标签" } });
  tree = render({ selectedKeys: ["self:b"] });
  descendants(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(mutations[0][0], "POST");
  assert.equal(JSON.stringify(mutations[0][1]), JSON.stringify({ id: "new-tag", name: "新标签", add: ["self:a"] }));
  assert.deepEqual(changes, ["new-tag"]);
  tree = render();
  const action = descendants(tree).find(node => node.type === "Button" && node.props.children?.includes("移出当前标签"));
  assert.ok(action);
  action.props.onClick();
  await flush();
  assert.equal(mutations.at(-1)[0], "PATCH");
  assert.equal(JSON.stringify(mutations.at(-1)[1]), JSON.stringify({ id: "tag", remove: ["self:a"] }));
});

test("bulk tag actions are directly available and preserve addition, disabled states, and retry", async () => {
  const state = hooks();
  const mutations = [];
  let retries = 0;
  const { AssetGroupMenu } = loadSource("../src/app/assets/asset-groups.tsx", {
    react: state.react,
    sonner: { toast: { success() {} } },
  });
  const props = {
    state: {
      groups: [{ id: "tag", name: "品牌", assetKeys: ["self:a"] }],
      loading: false, busy: false, error: "",
      mutate: async (method, body) => { mutations.push([method, JSON.parse(JSON.stringify(body))]); return true; },
      reload: () => retries++,
    },
    filter: "tag", onFilterChange() {}, selectedKeys: ["self:a", "self:b"], availableKeys: new Set(["self:a", "self:b"]),
  };
  const render = (extra = {}) => descendants(state.render(AssetGroupMenu, { ...props, ...extra }));
  const button = (nodes, label) => nodes.find(node => node.type === "Button" && node.props.children?.includes(label));
  const nodes = render();
  assert.ok(button(nodes, "新建标签"));
  assert.equal(button(nodes, "添加到标签").props.disabled, false);
  assert.equal(nodes.some(node => node.props?.["aria-label"] === "所选素材标签操作"), false);
  nodes.find(node => node.type === "DropdownMenuItem").props.onSelect();
  await flush();
  assert.deepEqual(mutations, [["PATCH", { id: "tag", add: ["self:a", "self:b"] }]]);
  for (const change of [{ loading: true }, { busy: true }, { error: "unavailable" }]) {
    const disabled = render({ state: { ...props.state, ...change } });
    for (const label of ["新建标签", "添加到标签", "移出当前标签"]) assert.equal(button(disabled, label).props.disabled, true);
    assert.equal(disabled.find(node => node.type === "DropdownMenuItem").props.disabled, true);
  }
  const failed = render({ state: { ...props.state, error: "unavailable" } });
  button(failed, "重试读取标签").props.onClick();
  assert.equal(retries, 1);
  assert.equal(button(render({ state: { ...props.state, groups: [] } }), "添加到标签").props.disabled, true);
  assert.equal(button(render({ selectedKeys: ["self:b"] }), "移出当前标签").props.disabled, true);
  assert.equal(button(render({ filter: "all" }), "移出当前标签"), undefined);
  const sidebar = render({ selectedKeys: [] });
  assert.ok(sidebar.find(node => node.props?.["aria-label"] === "新建标签"));
  assert.equal(sidebar.some(node => node.type === "DropdownMenuItem"), false);
});

test("tag row menus rename and delete only their own tag while preserving the active filter", async () => {
  for (const filter of ["all", "one", "two"]) {
    for (const operation of ["rename", "delete"]) {
      const state = hooks();
      const mutations = [], changes = [];
      const { AssetGroupMenu } = loadSource("../src/app/assets/asset-groups.tsx", {
        react: state.react, sonner: { toast: { success() {} } },
      });
      const groups = [{ id: "one", name: "标签1", assetKeys: ["self:a"] }, { id: "two", name: "标签2", assetKeys: ["self:b"] }];
      const props = {
        state: { groups, loading: false, busy: false, error: "", mutate: async (method, body) => { mutations.push([method, JSON.parse(JSON.stringify(body))]); return true; } },
        filter, onFilterChange: value => changes.push(value), selectedKeys: [], availableKeys: new Set(), group: groups[1],
      };
      const render = (extra = {}) => descendants(state.render(AssetGroupMenu, { ...props, ...extra }));
      let nodes = render();
      assert.ok(nodes.find(node => node.props?.["aria-label"] === "标签“标签2”的操作"));
      nodes.find(node => node.type === "DropdownMenuItem" && node.props.children.includes(operation === "delete" ? "删除标签" : "重命名标签")).props.onSelect();
      nodes = render({ filter: "one" });
      assert.deepEqual(mutations, [], "opening an action does not mutate tags");
      if (operation === "delete") {
        const confirmation = nodes.find(node => node.type === "ConfirmDialog");
        assert.equal(confirmation.props.open, true);
        assert.equal(confirmation.props.title, "删除标签“标签2”？");
        assert.match(confirmation.props.description, /所有素材和其他标签都会保留/);
        confirmation.props.onOpenChange(false);
        assert.deepEqual(mutations, [], "cancel never deletes tags");
        nodes = render();
        nodes.find(node => node.type === "DropdownMenuItem" && node.props.children.includes("删除标签")).props.onSelect();
        render().find(node => node.type === "ConfirmDialog").props.onConfirm();
      } else {
        const input = nodes.find(node => node.type === "Input");
        assert.equal(input.props.value, "标签2");
        input.props.onChange({ target: { value: "新名称" } });
        render().find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
      }
      await flush();
      assert.deepEqual(mutations, [[operation === "delete" ? "DELETE" : "PATCH", operation === "delete" ? { id: "two" } : { id: "two", name: "新名称" }]]);
      assert.deepEqual(changes, operation === "delete" && filter === "two" ? ["all"] : []);
    }
  }
});

test("workflow attachments preserve reference order, movement bounds, removal and original links", () => {
  const { WorkflowReferenceGrid } = loadSource("../src/app/workflows/creative-workflow-workspace.tsx", {}, {}, "\nexport { WorkflowReferenceGrid };\n");
  const references = [{ id: "first", name: "first.png", url: "/first.png" }, { id: "last", name: "last.png", url: "/last.png" }];
  const moves = [], removed = [];
  const props = { references, className: "grid-cols-2", onMove: (...args) => moves.push(args), onRemove: id => removed.push(id) };
  const tree = WorkflowReferenceGrid(props);
  assert.equal(tree.type, "AttachmentGroup");
  const actions = descendants(tree).filter(node => node.type === "AttachmentAction");
  const byName = name => actions.find(node => node.props["aria-label"] === name);
  assert.equal(byName("前移 first.png").props.disabled, true);
  assert.equal(byName("后移 last.png").props.disabled, true);
  byName("后移 first.png").props.onClick();
  byName("移除参考图 last.png").props.onClick();
  assert.deepEqual(moves, [["first", 1]]);
  assert.deepEqual(removed, ["last"]);
  assert.ok(descendants(WorkflowReferenceGrid({ ...props, disabled: true })).filter(node => node.type === "AttachmentAction").every(node => node.props.disabled));
  const readonly = WorkflowReferenceGrid({ references, className: "grid-cols-4", openOriginal: true });
  assert.equal(descendants(readonly).filter(node => node.type === "AttachmentAction").length, 0);
  const links = descendants(readonly).filter(node => node.type === "a");
  assert.deepEqual(links.map(node => node.props.href), references.map(ref => ref.url));
  assert.ok(links.every(node => node.props.target === "_blank" && node.props.rel === "noreferrer"));
});

test("test results represent only completed dry-run checks and retain their full labels", () => {
  const { TestResults } = loadSource("../src/components/ai-elements/test-results.tsx");
  const checks = ["创建请求符合契约", "查询响应解析通过"];
  const tree = TestResults({ checks, label: "插件干跑检查结果" });
  assert.equal(tree.props["aria-label"], "插件干跑检查结果");
  const titles = descendants(tree).filter(node => node.type === "TraceTitle").map(node => node.props.children);
  assert.ok(checks.every(check => titles.includes(check)));
  assert.ok(descendants(tree).some(node => node.type === "TraceCollapsibleTrigger"));
  assert.equal(descendants(tree).filter(node => node.type === "TraceLine" && node.props.status).length, 0);
});

test("code block copying reports failures, supports text actions and respects cancelled clicks", async () => {
  const state = hooks();
  const copied = [], errors = [];
  let reject = false;
  const { CodeBlockCopyButton } = loadSource("../src/components/ui/code-block.tsx", {
    react: state.react,
    "class-variance-authority": { cva: () => () => "" },
    "@/lib/clipboard-text": { copyClipboardText: async text => { if (reject) throw new Error("剪贴板被拒绝"); copied.push(text); } },
    sonner: { toast: { error: text => errors.push(text) } },
  });
  const props = { value: "node canvas-agent/server.mjs", children: "复制源码" };
  let tree = state.render(CodeBlockCopyButton, props);
  let button = descendants(tree).find(node => node.type === "Button");
  assert.ok(button.props.children.includes("复制源码"));
  assert.equal(button.props["aria-label"], undefined, "Text actions must keep their visible accessible name");
  button.props.onClick(event(null));
  await flush();
  assert.deepEqual(copied, [props.value]);
  tree = state.render(CodeBlockCopyButton, props);
  assert.equal(descendants(tree).find(node => node.type === "Button").props["data-copied"], true);
  reject = true;
  button.props.onClick(event(null));
  await flush();
  assert.deepEqual(errors, ["剪贴板被拒绝"]);
  tree = state.render(CodeBlockCopyButton, { ...props, onClick: click => click.preventDefault() });
  descendants(tree).find(node => node.type === "Button").props.onClick(event(null));
  await flush();
  assert.equal(errors.length, 1);
});

test("copy feedback applies only to the copied value, including delayed writes", async () => {
  for (const delayed of [false, true]) {
    const state = hooks();
    let finish;
    const { CodeBlockCopyButton } = loadSource("../src/components/ui/code-block.tsx", {
      react: state.react,
      "class-variance-authority": { cva: () => () => "" },
      "@/lib/clipboard-text": { copyClipboardText: () => delayed ? new Promise(resolve => { finish = resolve; }) : Promise.resolve() },
    });
    const render = value => descendants(state.render(CodeBlockCopyButton, { value })).find(node => node.type === "Button");
    const button = render("原提示词");
    assert.equal(button.props.type, "button", "Copying must never submit a surrounding form");
    button.props.onClick(event(null));
    if (!delayed) {
      await flush();
      assert.equal(render("原提示词").props["data-copied"], true);
    }
    assert.notEqual(render("修改后的提示词").props["data-copied"], true);
    if (delayed) {
      finish();
      await flush();
      assert.notEqual(render("修改后的提示词").props["data-copied"], true);
    }
  }
});

test("canvas message copies preserve edit, retry and message visibility rules", () => {
  const edited = [], retried = [];
  const { CanvasAgentTaskItem } = loadSource("../src/app/canvas/canvas-agent-conversation.tsx", {
    react: { memo: component => component },
    "./agent/canvas-agent-run-state": { canvasAgentMessageRunStatus: message => message.status },
  }, {}, "\nexport { CanvasAgentTaskItem };\n");
  const request = { id: "request", role: "user", text: "原始消息" };
  const props = {
    task: { id: "task", request, replies: [] }, nodes: [], busy: false, editDisabled: false,
    protocolPresentation: { sources: [], reasoning: [] }, timings: new Map(), displayTraces: new Map(),
    onEdit: message => edited.push(message), onRetry: message => retried.push(message),
  };
  const render = patch => descendants(CanvasAgentTaskItem({ ...props, ...patch }));
  let nodes = render();
  let copy = nodes.find(node => node.type === "CodeBlockCopyButton");
  assert.equal(copy.props.value, request.text);
  nodes.find(node => node.props?.["aria-label"] === "编辑消息").props.onClick();
  assert.deepEqual(edited, [request]);
  assert.deepEqual(retried, []);
  assert.equal(render({ editDisabled: true }).find(node => node.props?.["aria-label"] === "编辑消息").props.disabled, true);
  for (const patch of [
    { editingMessageID: request.id, onSaveEdit() {}, onCancelEdit() {} },
    { task: { ...props.task, request: { ...request, status: "running" } } },
    { task: { ...props.task, request: { ...request, text: "" } } },
    { task: { ...props.task, request: { ...request, questionAnswerFor: "question" } } },
  ]) assert.equal(render(patch).some(node => node.type === "CodeBlockCopyButton"), false);
  const reply = { id: "reply", role: "assistant", text: "最终回答", status: "success" };
  nodes = render({ task: { ...props.task, request: undefined, replies: [reply] }, latestAssistantID: reply.id });
  copy = nodes.find(node => node.type === "CodeBlockCopyButton");
  assert.equal(copy.props.value, reply.text);
  nodes.find(node => node.props?.["aria-label"] === "重试").props.onClick();
  assert.equal(retried[0].id, reply.id);
  assert.equal(nodes.some(node => node.props?.["aria-label"] === "编辑消息"), false);
  const hidden = render({ task: { ...props.task, request: undefined, replies: [reply] }, latestAssistantID: reply.id, pendingQuestion: reply.text });
  assert.equal(hidden.some(node => node.type === "CodeBlockCopyButton"), false);
});

test("workflow prompt copies follow image selection and draft edits", () => {
  const state = hooks();
  const changed = [];
  const { WorkflowTaskDialog, SeriesDraftCard } = loadSource("../src/app/workflows/creative-workflow-workspace.tsx", {
    react: state.react,
  }, {}, "\nexport { WorkflowTaskDialog, SeriesDraftCard };\n");
  const task = {
    id: "task", workflow_name: "隔离工作流", status: "success", started_at: 0, ended_at: 1000,
    prompt: "批次提示词", inputs: {}, references: [], config: {}, execution: {}, backend_task_ids: [], count: 3,
    images: [{ url: "/first", prompt: "第一张提示词" }, { url: "/second", prompt: "第二张提示词" }, { url: "/third" }],
  };
  const render = patch => descendants(state.render(WorkflowTaskDialog, { task: { ...task, ...patch }, now: 1000, onClose() {} }));
  let nodes = render();
  const copy = items => items.find(node => node.type === "CodeBlockCopyButton");
  assert.equal(copy(nodes).props.value, "第一张提示词");
  nodes.find(node => node.props?.["aria-label"] === "查看第 2 张结果").props.onClick();
  nodes = render();
  assert.equal(copy(nodes).props.value, "第二张提示词");
  nodes.find(node => node.props?.["aria-label"] === "查看第 3 张结果").props.onClick();
  assert.equal(copy(render()).props.value, task.prompt);
  assert.equal(copy(render({ images: [], prompt: "" })).props.disabled, true);
  const draft = { id: "draft", title: "第一张", prompt: "草稿提示词", status: "success" };
  const props = { draft, index: 0, first: true, last: true, onChange: patch => changed.push(patch) };
  nodes = descendants(SeriesDraftCard(props));
  assert.equal(copy(nodes).props.value, draft.prompt);
  nodes.find(node => node.type === "InputGroupTextarea").props.onChange({ target: { value: "修改后的草稿" } });
  assert.deepEqual(changed, [{ prompt: "修改后的草稿", status: "draft" }]);
  assert.equal(copy(descendants(SeriesDraftCard({ ...props, draft: { ...draft, ...changed[0] } }))).props.value, "修改后的草稿");
});

test("channel instruction copies retain the current endpoint, models and protocol example", () => {
  const state = hooks();
  const { ChannelParameterEditor } = loadSource("../src/components/channel-parameter-editor.tsx", { react: state.react });
  const render = props => descendants(state.render(ChannelParameterEditor, { value: "", onChange() {}, ...props }));
  for (const kind of ["image", "video", "audio"]) {
    const copy = render({ kind, baseURL: "https://isolated.example", models: ["isolated-model"] }).find(node => node.type === "CodeBlockCopyButton");
    assert.ok(copy.props.value.startsWith("Base URL：https://isolated.example\n模型列表：isolated-model\n"));
    assert.ok(copy.props.value.includes('"isolated-model": {'));
    assert.ok(copy.props.value.includes(kind === "audio" ? "/audio/speech" : kind === "video" ? "/videos" : "/images/generations"));
    assert.equal(copy.props.children, "复制说明");
  }
  const next = render({ baseURL: "https://changed.example", models: [] }).find(node => node.type === "CodeBlockCopyButton");
  assert.ok(next.props.value.startsWith("Base URL：https://changed.example\n模型列表：请填写实际模型名称\n"));
});

test("text asset preview copying follows the displayed asset content", () => {
  const state = hooks();
  const { AssetPreview } = loadSource("../src/app/assets/asset-display.tsx", {
    react: state.react,
    "@/app/assets/asset-library": { assetPrompt: () => "", assetModel: () => "", formatAssetCreatedTime: value => value },
    "@/app/assets/asset-media": { assetMediaSummary: () => "文本素材" },
  });
  const asset = { id: "isolated", title: "文本素材", kind: "text", tags: [], content: "完整文本\n第二行" };
  const render = content => descendants(state.render(AssetPreview, { asset: { ...asset, content }, onClose() {}, onDownload() {} }));
  const copy = render(asset.content).find(node => node.type === "CodeBlockCopyButton");
  assert.equal(copy.props.value, asset.content);
  assert.equal(copy.props.children, "复制文本");
  assert.equal(copy.props.variant, "outline");
  assert.equal(copy.props.size, "default");
  assert.equal(render("切换后的素材文本").find(node => node.type === "CodeBlockCopyButton").props.value, "切换后的素材文本");
});

test("prompt source row and detail copies retain their own prompt text", async () => {
  const state = hooks();
  const prompts = [
    { id: "one", title: "第一条", prompt: "第一条提示词\n完整内容", tags: [] },
    { id: "two", title: "第二条", prompt: "第二条提示词", tags: [] },
  ];
  const { PromptSourceContentDialog } = loadSource("../src/app/settings/components/prompt-source-content-dialog.tsx", { react: state.react });
  const props = { source: { id: "isolated", label: "隔离来源" }, open: true, onOpenChange() {}, onPull: async () => ({ ok: true, prompts }) };
  const render = () => descendants(state.render(PromptSourceContentDialog, props));
  render();
  state.effects.forEach(effect => effect());
  await flush();
  let nodes = render();
  assert.deepEqual(nodes.filter(node => node.type === "CodeBlockCopyButton").map(node => node.props.value), prompts.map(prompt => prompt.prompt));
  nodes.filter(node => node.type === "Button" && node.props.children === "详情")[1].props.onClick();
  nodes = render();
  const detailCopy = nodes.find(node => node.type === "CodeBlockCopyButton" && node.props.children === "复制提示词");
  assert.equal(detailCopy.props.value, prompts[1].prompt);
  assert.equal(detailCopy.props.variant, "default");
  assert.equal(detailCopy.props.size, "default");
});

test("canvas connection and share copies use the current session and generated link", async () => {
  const state = hooks();
  const { CanvasCodexConnect } = loadSource("../src/app/canvas/canvas-codex-connect.tsx", { react: state.react }, { window: { location: { origin: "https://isolated.example" } } });
  const props = { agent: { models: [], model: "isolated", connected: true, sessionId: "first-session" }, open: true, onOpenChange() {} };
  const render = sessionId => descendants(state.render(CanvasCodexConnect, { ...props, agent: { ...props.agent, sessionId } }));
  assert.equal(render("first-session").find(node => node.type === "CodeBlockCopyButton").props.value, "first-session");
  assert.equal(render("next-session").find(node => node.type === "CodeBlockCopyButton").props.value, "next-session");
  const shareState = hooks();
  const changed = [];
  const { CanvasShareDialog } = loadSource("../src/app/canvas/canvas-share-dialog.tsx", {
    react: shareState.react,
    "@/services/api/canvas": { fetchCanvasShare: async () => ({ token: "isolated-share" }) },
  }, { window: { location: { origin: "https://isolated.example" } } });
  const shareProps = { projectID: "isolated", onShareChange: value => changed.push(value), beforeShare: async () => true, onClose() {} };
  shareState.render(CanvasShareDialog, shareProps);
  shareState.effects.forEach(effect => effect());
  await flush();
  const copy = descendants(shareState.render(CanvasShareDialog, shareProps)).find(node => node.type === "CodeBlockCopyButton");
  assert.equal(copy.props.value, "https://isolated.example/share/canvas/isolated-share");
  assert.equal(copy.props.variant, "default");
  assert.equal(copy.props.size, "default");
  assert.deepEqual(changed, [true]);
});

test("system Skill attachment removal preserves other files and locks while reading", async () => {
  const state = hooks();
  const { SkillManager } = loadSource("../src/app/canvas/canvas-agent-skill-picker.tsx", {
    react: state.react,
    "@/lib/session": { getCachedAuthSession: () => ({ key: "isolated", role: "admin" }) },
  }, { TextEncoder }, "\nexport { SkillManager };\n");
  const props = { open: true, onClose() {} };
  let tree = state.render(SkillManager, props);
  descendants(tree).find(node => node.type === "Toggle" && node.props.children === "系统").props.onClick();
  tree = state.render(SkillManager, props);
  descendants(tree).find(node => node.type === "Button" && node.props.children?.includes("新建")).props.onClick();
  tree = state.render(SkillManager, props);
  const fileInput = descendants(tree).find(node => node.type === "input" && node.props.multiple);
  const files = [{ name: "one.md", size: 4, text: async () => "one" }, { name: "two.txt", size: 4, text: async () => "two" }];
  fileInput.props.onChange({ target: { files, value: "" } });
  await flush();
  tree = state.render(SkillManager, props);
  let actions = descendants(tree).filter(node => node.type === "AttachmentAction");
  assert.equal(actions.length, 2);
  actions[0].props.onClick();
  tree = state.render(SkillManager, props);
  actions = descendants(tree).filter(node => node.type === "AttachmentAction");
  assert.deepEqual(actions.map(node => node.props["aria-label"]), ["移除 references/two.txt"]);
  let finish;
  fileInput.props.onChange({ target: { files: [{ name: "pending.md", size: 1, text: () => new Promise(resolve => { finish = resolve; }) }], value: "" } });
  tree = state.render(SkillManager, props);
  assert.ok(descendants(tree).filter(node => node.type === "AttachmentAction").every(node => node.props.disabled));
  finish("pending");
  await flush();
});

test("public reference URL attachments preserve validation, limits, removal and disabled state", () => {
  const state = hooks();
  const changed = [];
  const { PublicReferenceURLList } = loadSource("../src/app/image/components/image-composer.tsx", {
    react: state.react,
    "@/lib/public-reference-url": { isPublicReferenceURL: value => value.startsWith("https://") },
  }, {}, "\nexport { PublicReferenceURLList };\n");
  const props = { label: "参考视频", values: ["https://example.org/one.mp4", "https://example.org/two.mp4"], max: 3, onChange: values => changed.push(values) };
  let tree = state.render(PublicReferenceURLList, props);
  const actions = descendants(tree).filter(node => node.type === "AttachmentAction");
  assert.equal(actions.length, 2);
  actions[0].props.onClick();
  assert.deepEqual(changed, [[props.values[1]]]);
  tree = state.render(PublicReferenceURLList, { ...props, disabled: true });
  assert.ok(descendants(tree).filter(node => node.type === "AttachmentAction").every(node => node.props.disabled));
  tree = state.render(PublicReferenceURLList, { ...props, showValues: false });
  assert.equal(descendants(tree).filter(node => node.type === "Attachment").length, 0);
  descendants(tree).find(node => node.type === "InputGroupInput").props.onChange({ target: { value: "https://example.org/new.mp4" } });
  tree = state.render(PublicReferenceURLList, props);
  descendants(tree).find(node => node.type === "TooltipButton").props.onClick();
  assert.deepEqual(changed[1], [...props.values, "https://example.org/new.mp4"]);
});


test("contract document attachments select and repeat files, expose metadata and disable both actions", () => {
  const state = hooks();
  const changes = [];
  const { VideoContractDocumentUpload } = loadSource("../src/app/settings/components/video-contract-document-upload.tsx", { react: state.react });
  const props = { file: null, disabled: false, onChange: file => changes.push(file) };
  let tree = state.render(VideoContractDocumentUpload, props);
  let nodes = descendants(tree);
  assert.equal(nodes.find(node => node.type === "Attachment").props.state, "idle");
  const input = nodes.find(node => node.type === "input");
  let picks = 0;
  input.props.ref.current = { click() { picks++; } };
  nodes.find(node => node.type === "AttachmentTrigger").props.onClick();
  const file = { name: "视频接口.md", size: 2048 };
  const target = { files: [file], value: "document.md" };
  input.props.onChange({ target });
  assert.equal(target.value, "");
  input.props.onChange({ target: { files: [file], value: "document.md" } });
  assert.deepEqual(changes, [file, file]);
  tree = state.render(VideoContractDocumentUpload, { ...props, file });
  nodes = descendants(tree);
  assert.equal(nodes.find(node => node.type === "AttachmentTitle").props.children, file.name);
  assert.match(nodes.find(node => node.type === "AttachmentDescription").props.children, /2 KB/);
  nodes.find(node => node.type === "AttachmentAction" && node.props["aria-label"] === "更换文档").props.onClick();
  assert.equal(picks, 2);
  nodes.find(node => node.type === "AttachmentAction" && node.props["aria-label"] === "移除文档").props.onClick();
  assert.equal(changes.at(-1), null);
  tree = state.render(VideoContractDocumentUpload, { ...props, file, disabled: true });
  assert.ok(descendants(tree).filter(node => ["AttachmentAction", "input"].includes(node.type)).every(node => node.props.disabled));
});

test("contract material previews use disabled upload controls and preserve rule visibility and limits", () => {
  const hidden = new Set();
  const { ContractReferenceMaterialPreview } = loadSource("../src/app/settings/components/video-model-contracts-card.tsx", {
    "@/lib/video-model-contracts": { videoContractUIState: () => ({ hidden }) },
  }, {}, "\nexport { ContractReferenceMaterialPreview };\n");
  const contract = { capability: { first_frame_image_limit: 2, references: { image: 3, video: 2, audio: 1, total: 6 } } };
  const render = () => descendants(ContractReferenceMaterialPreview({ contract, ruleValues: {} }));
  let uploads = render().filter(node => node.type === "ReferenceFileUpload");
  assert.deepEqual(uploads.map(node => node.props.label), ["上传首帧", "上传尾帧", "上传参考图", "上传参考视频", "上传参考音频"]);
  assert.deepEqual(uploads.map(node => node.props.remaining ?? 1), [1, 1, 3, 2, 1]);
  assert.ok(uploads.every(node => node.props.disabled));
  hidden.add("last_frame");
  hidden.add("reference_video");
  uploads = render().filter(node => node.type === "ReferenceFileUpload");
  assert.deepEqual(uploads.map(node => node.props.label), ["上传首帧", "上传参考图", "上传参考音频"]);
  contract.capability = { first_frame_image_limit: 0, references: { image: 0, video: 0, audio: 0, total: 0 } };
  assert.equal(ContractReferenceMaterialPreview({ contract, ruleValues: {} }), null);
});
