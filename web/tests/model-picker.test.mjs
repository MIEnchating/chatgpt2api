import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { groupModelsByFamily, resolveModelGroupConfig } from "../src/lib/model-groups.ts";

function pickerHarness() {
  const state = [], cache = [], effects = [];
  let cursor, pending;
  const names = ["ModelSelector", "ModelSelectorContent", "ModelSelectorEmpty", "ModelSelectorGroup", "ModelSelectorInput", "ModelSelectorItem", "ModelSelectorList", "ModelSelectorName", "ModelSelectorTrigger"];
  const selectors = Object.fromEntries(names.map(name => [name, name]));
  const hook = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], next => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useMemo(callback, deps) {
      const index = cursor++;
      if (!cache[index] || deps.some((value, i) => !Object.is(value, cache[index].deps[i]))) cache[index] = { value: callback(), deps };
      return cache[index].value;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index].deps[i]))) pending.push({ index, callback, deps });
    },
  };
  const jsx = (type, props) => ({ type, props });
  const source = readFileSync(new URL("../src/components/model-picker.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {}, requests = [];
  const dependencies = {
    react: hook, "react/jsx-runtime": { jsx, jsxs: jsx }, "lucide-react": { ChevronDown: "ChevronDown" },
    "@/components/ai-elements/model-selector": selectors, "@/components/ui/button": { Button: "Button" },
    "@/lib/model-groups": { groupModelsByFamily, resolveModelGroupConfig }, "@/lib/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
    "@/lib/api": { fetchModelConfig: async () => { requests.push("config"); return { config: { text_models: ["gpt-6.1-sol"], image_models: [], video_models: ["minimax-h3", "blocked-model"], audio_models: [], model_groups: { overrides: { "minimax-h3": "视频优先" }, order: ["视频优先"] } } }; } },
  };
  new Function("exports", "require", code)(exports, name => { assert.ok(name in dependencies, name); return dependencies[name]; });
  return {
    requests,
    render(props) {
      cursor = 0; pending = [];
      const tree = exports.ModelPicker(props);
      for (const item of pending) { effects[item.index]?.cleanup?.(); effects[item.index] = { deps: item.deps, cleanup: item.callback() }; }
      return tree;
    },
    unmount() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

function find(tree, type) {
  if (Array.isArray(tree)) return tree.flatMap(item => find(item, type));
  if (!tree || typeof tree !== "object") return [];
  return [...(tree.type === type ? [tree] : []), ...find(tree.props?.children, type)];
}

test("closed model pickers keep the selected label without constructing option descriptions or controls", () => {
  const picker = pickerHarness();
  let descriptions = 0, checks = 0;
  const options = Array.from({ length: 2000 }, (_, index) => ({ value: `model-${index}`, label: `模型 ${index}` }));
  const props = { label: "Agent 对话模型", value: "model-1999", options, onValueChange: () => assert.fail("closed picker selected a model"), renderDescription: () => { descriptions++; return "价格"; }, isModelDisabled: () => { checks++; return false; } };
  const tree = picker.render(props);
  assert.equal(find(tree, "ModelSelectorName")[0].props.children, "模型 1999");
  assert.equal(find(tree, "ModelSelectorItem").length, 0);
  assert.equal(descriptions, 0);
  assert.equal(checks, 0);
  assert.deepEqual(picker.requests, []);
  picker.unmount();
});

test("opening a model picker preserves grouping, searchable names, disabled choices and selection", async () => {
  const picker = pickerHarness(), changes = [], opened = [];
  const props = { label: "视频模型", value: "minimax-h3", options: ["gpt-6.1-sol", {value: "minimax-h3", label: "海螺 H3"}, "minimax-h3", "blocked-model"], onValueChange: model => changes.push(model), onOpenChange: value => opened.push(value), isModelDisabled: model => model === "blocked-model", renderDescription: model => `价格：${model}` };
  let tree = picker.render(props);
  tree.props.onOpenChange(true);
  tree = picker.render(props);
  await Promise.resolve(); await Promise.resolve();
  tree = picker.render(props);
  assert.equal(tree.props.open, true);
  assert.equal(find(tree, "ModelSelectorInput")[0].props["aria-label"], "搜索模型");
  assert.equal(find(tree, "ModelSelectorGroup")[0].props.heading, "视频优先");
  const items = find(tree, "ModelSelectorItem");
  assert.equal(items.length, 3);
  const selected = items.find(item => item.props.value === "minimax-h3");
  assert.equal(selected.props["data-checked"], true);
  assert.deepEqual(selected.props.keywords, ["海螺 H3", "视频优先"]);
  const blocked = items.find(item => item.props.value === "blocked-model");
  assert.equal(blocked.props.disabled, true);
  blocked.props.onSelect(); assert.deepEqual(changes, []);
  items.find(item => item.props.value === "gpt-6.1-sol").props.onSelect();
  assert.deepEqual(changes, ["gpt-6.1-sol"]);
  tree = picker.render(props);
  assert.equal(tree.props.open, false);
  assert.equal(find(tree, "ModelSelectorItem").length, 0);
  assert.deepEqual(opened, [true, false]);
  picker.unmount();
});

test("disabled and empty model pickers cannot build or open model menus", () => {
  for (const props of [{ disabled: true, options: ["minimax-h3"] }, { options: [] }]) {
    const picker = pickerHarness();
    const input = { label: "视频模型", value: "", onValueChange: () => assert.fail("unavailable picker selected a model"), ...props };
    let tree = picker.render(input);
    tree.props.onOpenChange(true);
    tree = picker.render(input);
    assert.equal(tree.props.open, false);
    assert.equal(find(tree, "Button")[0].props.disabled, true);
    assert.equal(find(tree, "ModelSelectorItem").length, 0);
    picker.unmount();
  }
});
