import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAgentQuestionCard, CanvasAgentQuestionRecord } from "../src/app/canvas/canvas-agent-interaction.tsx";
import ts from "typescript";
import { createRequire } from "node:module";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const panelSource = read("../src/app/canvas/canvas-agent-panel.tsx");
const runSettingsSource = read("../src/app/canvas/canvas-agent-run-settings.tsx");

function answerInput(props) {
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  const source = ts.transpileModule(read("../src/app/canvas/canvas-agent-answer-input.tsx"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", source)((name) => {
    if (name === "react") return { useId: () => "question" };
    if (name === "lucide-react") return { ArrowRight: "svg", PencilLine: "svg" };
    if (name.endsWith("/questionnaire")) return { Questionnaire: "form", QuestionnaireItem: "fieldset", QuestionnaireChoices: "div", QuestionnaireChoice: "label", QuestionnaireChoiceDescription: "span" };
    if (name.endsWith("/button")) return { Button: "button" };
    if (name.endsWith("/badge")) return { Badge: "span" };
    if (name.endsWith("/input-group")) return { InputGroup: "div", InputGroupAddon: "div", InputGroupText: "span", InputGroupTextarea: "textarea" };
    return require(name);
  }, module, module.exports);
  const root = module.exports.CanvasAgentAnswerInput(props);
  const elements = [];
  function visit(element) {
    if (!element || typeof element !== "object") return;
    elements.push(element);
    for (const child of [element.props?.children].flat(Infinity)) visit(child);
  }
  visit(root);
  return { root, elements };
}

test("clicking an answer submits immediately without replacing the custom draft", () => {
  const selected = [], changed = [];
  for (const disabled of [false, true]) {
    const { elements } = answerInput({ options: [{ label: "继续现有方案（推荐）" }], value: "我的自定义回复", disabled, onChange: (value) => changed.push(value), onSelect: (value) => selected.push(value) });
    const choice = elements.find((element) => element.type === "label");
    assert.equal(choice.props.disabled, disabled);
    choice.props.onClick({ target: { tagName: "LABEL" } });
    choice.props.onClick({ target: { tagName: "INPUT" } });
    assert.equal(elements.find((element) => element.type === "textarea").props.value, "我的自定义回复");
  }
  assert.deepEqual(selected, ["继续现有方案（推荐）"]);
  assert.deepEqual(changed, []);
});


test("questionnaire choices keep repeated answers and Enter activation without submitting IME confirmation", () => {
  const selected = [];
  const { elements } = answerInput({ options: [{ label: " 继续 ", description: "保留原草稿" }], value: "自定义回复", onChange() {}, onSelect: value => selected.push(value) });
  const choice = elements.find(element => element.type === "label");
  const key = (key, isComposing = false) => ({ key, nativeEvent: { isComposing }, preventDefault() {} });
  choice.props.onClick({ target: { tagName: "INPUT" } });
  choice.props.onClick({ target: { tagName: "INPUT" } });
  choice.props.onKeyDown(key("Enter", true));
  choice.props.onKeyDown(key("Enter"));
  assert.deepEqual(selected, ["继续", "继续", "继续"]);
  assert.ok(elements.some(element => element.type === "span" && element.props.children === "保留原草稿"));
});

test("question cards keep recommendations inline and never infer them from option order", () => {
  for (const options of [["脚本卡片不出现", "生成的分镜/视频不出现"], ["脚本卡片不出现", "生成的分镜/视频不出现（推荐）"]]) {
    const question = { id: "question", question: "哪一步没有显示？", reason: "", options, kind: "clarification", request: "检查画布" };
    const html = renderToStaticMarkup(createElement(CanvasAgentQuestionCard, { question, busy: false, active: true, onAnswer() { return true; }, onCancel() {} }));
    assert.match(html, />问题</);
    assert.match(html, /或自行撰写回复/);
    assert.match(html, /aria-label="关闭问题"/);
    assert.equal((html.match(/>[^<]*（推荐）[^<]*</g) || []).length, options[1].includes("推荐") ? 1 : 0);
    assert.doesNotMatch(html, /Agent 推荐|语音|麦克风/);
    assert.equal((html.match(/data-slot="questionnaire-choice"/g) || []).length, 2);
    assert.equal((html.match(/<input[^>]*type="radio"/g) || []).length, 2);
  }
});

test("question history renders the prompt and answer together in the user bubble", () => {
  const answered = renderToStaticMarkup(createElement(CanvasAgentQuestionRecord, { question: "采用哪种方案？", answer: "使用现有方案" }));
  assert.match(answered, /data-agent-question-prompt[^>]*>采用哪种方案？<\/p>/);
  assert.match(answered, /data-agent-question-answer[^>]*class="[^"]*text-foreground[^"]*"[^>]*>使用现有方案<\/p>/);
  assert.ok(answered.indexOf("采用哪种方案？") < answered.indexOf("使用现有方案"));
  assert.match(answered, /data-slot="bubble-content"[^>]*>[\s\S]*采用哪种方案？[\s\S]*使用现有方案/);
  assert.doesNotMatch(answered, /TraceCollapsible|已询问|aria-expanded/);

  const unanswered = renderToStaticMarkup(createElement(CanvasAgentQuestionRecord, { question: "采用哪种方案？" }));
  assert.match(unanswered, /等待回答/);
  assert.doesNotMatch(unanswered, /data-agent-question-answer/);
});

test("editing from a checkpoint reveals the original message after the editor renders and explains blockers", () => {
  const editStart = panelSource.indexOf("function editUserMessage(message:");
  const editEnd = panelSource.indexOf("function cancelMessageEdit", editStart);
  const editHandler = panelSource.slice(editStart, editEnd);
  assert.match(editHandler, /当前任务仍在运行，请等待停止后再编辑/);
  assert.match(editHandler, /请先回答或取消当前问题，再编辑并继续/);
  assert.match(editHandler, /setEditingUserMessageID\(message\.id\)/);
  assert.match(panelSource, /target\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\)/);
  assert.match(read("../src/app/canvas/canvas-agent-conversation.tsx"), /<Checkpoint editing=\{editingMessageID === task\.request\.id\}/);
  assert.match(read("../src/components/ai-elements/checkpoint.tsx"), /editing \? "正在编辑" : "编辑并继续"/);
});

test("sending an answer keeps the question controls and puts loading in its send button", () => {
  const question = { id: "question", question: "采用哪种方案？", reason: "", options: ["使用现有方案"], kind: "clarification", request: "检查画布" };
  const html = renderToStaticMarkup(createElement(CanvasAgentQuestionCard, { question, busy: true, active: true, onAnswer() { return true; } }));
  assert.match(html, /采用哪种方案/);
  assert.match(html, /使用现有方案/);
  assert.match(html, /<button[^>]*aria-busy="true"[^>]*>[\s\S]*animate-spin[\s\S]*发送<\/button>/);
  assert.doesNotMatch(html, /正在继续|已回答：|正在发送/);
});

test("history rename input ignores Enter while an IME composition is active", () => {
  const start = panelSource.indexOf('aria-label="对话名称"');
  assert.ok(start >= 0);
  const input = panelSource.slice(start, panelSource.indexOf("onBlur=", start));
  const guard = input.indexOf("event.nativeEvent.isComposing");
  assert.ok(guard >= 0, "rename onKeyDown must check isComposing");
  assert.ok(guard < input.indexOf('event.key === "Enter"'), "composition guard must run before the Enter handler");
});

test("run settings dialog closes its own state when a run starts", () => {
  assert.match(runSettingsSource, /useEffect\(\(\) => \{ if \(busy\) setOpen\(false\); \}, \[busy\]\)/);
});
