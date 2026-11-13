import assert from "node:assert/strict";
import { canvasDocumentValuesEqual } from "../src/app/canvas/canvas-document-equality.ts";
import { canvasAgentTaskGroups } from "../src/app/canvas/agent/canvas-agent-task-groups.ts";
import { canvasAgentTaskTimings } from "../src/app/canvas/agent/canvas-agent-timing.ts";
import { canvasAgentProtocolUserMessageIndex } from "../src/app/canvas/agent/canvas-agent-message-links.ts";
import * as canvasAgentPresentation from "../src/app/canvas/agent/canvas-agent-presentation.ts";
import { CanvasAgentSessionConflictError } from "../src/app/canvas/canvas-document-merge.ts";
import { setCanvasAgentProcessing } from "../src/app/canvas/agent/canvas-agent-timing.ts";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAgentQuestionCard, CanvasAgentQuestionRecord } from "../src/app/canvas/canvas-agent-interaction.tsx";
import { CanvasAgentTaskProcess } from "../src/app/canvas/canvas-agent-task-process.tsx";
import ts from "typescript";
import { createRequire } from "node:module";
import { CONTEXT_COMPACTION_RATIO, contextTokenBudget, DEFAULT_CANVAS_AGENT_CONTEXT_WINDOW_TOKENS, estimateCanvasAgentTokens } from "../src/app/canvas/agent/canvas-agent-memory.ts";
import { canvasAgentHistorySummaries } from "../src/app/canvas/agent/canvas-agent-history.ts";
import { parseCanvasAgentSessions } from "../src/app/canvas/agent/canvas-agent-sessions.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const panelSource = read("../src/app/canvas/canvas-agent-panel.tsx");
const runSettingsSource = read("../src/app/canvas/canvas-agent-run-settings.tsx");

test("external MCP reads and confirms scripts through the authoritative backend tool chain", async () => {
  const source = ts.createSourceFile("panel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "executeExternalAction") handler = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler);
  const code = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const name of ["get_node", "confirm_script_node"]) {
    const calls = [], accepted = [], busyStates = [], abortRef = { current: null };
    const session = { id: "s", messages: [], agentState: {}, protocolMessages: [] }, sessionsRef = { current: [session] };
    const action = { id: "call", name, arguments: { nodeId: "script", ...(name === "confirm_script_node" ? { confirmationFingerprint: "a".repeat(64) } : {}) } };
    const document = { nodes: [], agent_run: { toolResult: { ok: true, ...(name === "get_node" ? { node: { confirmationFingerprint: "a".repeat(64) } } : { confirmed: true, submitted: false }) } } };
    let saves = 0;
    const dependencies = {
      abortRef, busy: false, activeSession: session, sessionsRef, canvasId: "canvas", AbortController, AbortSignal,
      onExecuteAction: () => assert.fail("script reads and confirmations cannot use the browser-only executor"),
      setBusy: value => busyStates.push(value), nanoid: () => "answer", commit: value => { sessionsRef.current = value; },
      setCanvasAgentProcessing, onPersist: async () => { saves++; },
      getAgentContext: () => ({ generation: { imageModel: "image", videoModel: "video" }, selectedNodeIds: [] }),
      tokenNameForModel: () => "", mediaModels: { video: { options: [] } }, canvasAgentSessionAttachments: () => [],
      acceptBackendSnapshot: value => accepted.push(value), onSyncError: () => assert.fail("unexpected sync error"),
      runBackendCanvasTool: async (project, context, tool, accept, signal) => {
        calls.push({ project, context, tool, signal }); accept(document); return { result: document.agent_run.toolResult, document };
      },
      releaseCanvasAgentRun: (ref, controller) => { assert.equal(ref.current, controller); ref.current = null; return true; },
      toast: { error: () => assert.fail("unexpected save error") },
    };
    const execute = new Function(...Object.keys(dependencies), `${code}\nreturn executeExternalAction;`)(...Object.values(dependencies));
    const result = await execute(action, new AbortController().signal);
    assert.equal(result, document.agent_run.toolResult);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, action);
    assert.equal(calls[0].project, "canvas");
    assert.equal(calls[0].context.sessionId, "s");
    assert.equal(calls[0].context.assistantId, "answer");
    assert.equal(saves, 2, "persist the request before execution and settle its timing afterwards");
    assert.deepEqual(accepted, [document]);
    assert.deepEqual(busyStates, [true, false]);
    assert.equal(abortRef.current, null);
  }
});

test("context estimates run outside render and draft edits reuse the current estimate", () => {
  const source = ts.createSourceFile("panel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ["contextEstimate", "contextUsage", "tokenEstimate", "contextInfo"].includes(node.name.getText(source))) declarations.push(`const ${node.getText(source)};`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const code = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const memo = [];
  let cursor = 0, contextReads = 0, requested, result = {}, submissions = 0;
  const render = new Function("useMemo", "useCanvasAgentTokenEstimate", "estimateCanvasAgentTokens", "CONTEXT_COMPACTION_RATIO", "contextTokenBudget", "DEFAULT_CANVAS_AGENT_CONTEXT_WINDOW_TOKENS", "props", `
    const {open, activeSession, getAgentContext, nodes, selectedNodeIDs, model, mediaModels, agentConfig, busy, input, agentMode, codex, composerReferenceNodeIDs, draftAttachments} = props;
    ${code}
    return contextInfo;
  `);
  const props = {
    open: true, activeSession: { agentState: {}, protocolMessages: [{ role: "user", content: "历史消息".repeat(10000) }], messages: [] },
    getAgentContext: () => { contextReads++; return { project: { nodeCount: props.nodes.length }, nodes: props.nodes }; },
    nodes: [{ id: "text", prompt: "原始文本" }], selectedNodeIDs: [], model: "test-model", mediaModels: { image: {}, video: {} },
    agentConfig: {}, busy: false, input: "", agentMode: "native", codex: {}, composerReferenceNodeIDs: [], draftAttachments: { attachments: [] },
  };
  const budget = () => {
    cursor = 0;
    return render((create, deps) => {
      const index = cursor++;
      if (!memo[index] || !deps.every((value, i) => Object.is(value, memo[index].deps[i]))) memo[index] = { deps, value: create() };
      return memo[index].value;
    }, input => {
      if (input !== requested) { requested = input; result = {}; if (input) submissions++; }
      return result;
    }, value => {
      assert.equal(typeof value, "string", "rendering must not serialize or estimate the full transcript");
      return estimateCanvasAgentTokens(value);
    }, CONTEXT_COMPACTION_RATIO, contextTokenBudget, DEFAULT_CANVAS_AGENT_CONTEXT_WINDOW_TOKENS, props);
  };
  assert.equal(budget().tokens, undefined, "a pending estimate must not be reported as zero");
  assert.equal(submissions, 1);
  result = { tokens: estimateCanvasAgentTokens(requested) };
  const initial = budget().tokens;
  for (const input of ["第", "第一", "第一条补充要求"]) {
    props.input = input;
    assert.ok(budget().tokens > initial);
  }
  assert.equal(contextReads, 1);
  assert.equal(submissions, 1);
  props.nodes = [{ id: "text", prompt: "更新内容".repeat(1000) }];
  assert.equal(budget().tokens, undefined, "changed canvas input must not reuse a stale estimate");
  result = { tokens: estimateCanvasAgentTokens(requested) };
  assert.ok(budget().tokens > initial + 1000);
  assert.equal(contextReads, 2);
  props.activeSession = { ...props.activeSession, contextUsage: { model: "test-model", inputTokens: 1234 } };
  assert.equal(budget().tokens, 1234);
  assert.equal(requested, undefined, "authoritative upstream usage does not require local history estimation");
  props.activeSession = { ...props.activeSession, contextUsage: { model: "test-model", inputTokens: 0 } };
  assert.equal(budget().tokens, 0, "measured zero remains authoritative");
  props.activeSession = { ...props.activeSession, contextUsage: undefined };
  assert.equal(budget().tokens, undefined);
  result = { error: "估算失败" };
  assert.equal(budget().error, "估算失败");
  props.open = false;
  budget();
  assert.equal(requested, undefined, "a hidden panel must stop estimating");
});

test("history directories reuse validated sessions without reading transcript bodies", () => {
  const source = ts.createSourceFile("panel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "historySessions") declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration);
  const code = ts.transpileModule(`const ${declaration.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const render = new Function("useMemo", "canvasAgentHistorySummaries", "sessions", "sessionSummaries", `${code}\nreturn historySessions;`);
  const now = "2026-11-12T00:00:00Z";
  let transcriptReads = 0, protocolReads = 0;
  let sessions = [{ id: "long", title: "长会话", createdAt: now, updatedAt: now, messages: Array.from({ length: 2000 }, (_, i) => ({ id: `reply-${i}`, role: "assistant", status: "success", get text() { transcriptReads++; return "完整旧记录"; } })), protocolMessages: Array.from({ length: 2000 }, (_, i) => ({ role: "tool", toolCallId: `call-${i}`, name: "get_canvas_summary", get content() { protocolReads++; return "完整工具结果"; } })), agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } }];
  assert.equal(parseCanvasAgentSessions(sessions), sessions);
  assert.equal(transcriptReads, 2000, "the input boundary validates every UI message");
  assert.equal(protocolReads, 2000, "the input boundary validates every protocol message");
  transcriptReads = protocolReads = 0;
  const original = sessions;
  assert.throws(() => { sessions = parseCanvasAgentSessions([{ ...original[0], protocolMessages: [{ role: "tool", content: 123 }] }]); }, /原记录未被替换/);
  assert.equal(sessions, original, "invalid incoming data must leave the current history intact");
  transcriptReads = protocolReads = 0;
  let sessionSummaries = [];
  let memo;
  const directory = () => render((create, deps) => {
    if (!memo || !deps.every((value, i) => Object.is(value, memo.deps[i]))) memo = { deps, value: create() };
    return memo.value;
  }, canvasAgentHistorySummaries, sessions, sessionSummaries);
  assert.equal(directory()[0].message_count, 2000);
  assert.equal(transcriptReads, 0, "the first directory must reuse boundary validation");
  assert.equal(protocolReads, 0);
  for (const _input of ["第", "第一", "第一条补充要求"]) assert.equal(directory()[0].message_count, 2000);
  assert.equal(transcriptReads, 0, "draft-only rerenders must not traverse unchanged message bodies");
  sessions = [{ ...sessions[0], title: "重命名长会话", messages: [...sessions[0].messages, { id: "new", role: "user", text: "新请求" }] }];
  assert.deepEqual(directory().map(item => [item.title, item.message_count]), [["重命名长会话", 2001]]);
  sessionSummaries = [{ id: "unloaded", title: "未加载会话", created_at: now, updated_at: now, message_count: 1000, content_hash: "fixture" }];
  assert.equal(directory().find(item => item.id === "unloaded").message_count, 1000);
  assert.equal(transcriptReads, 0, "renaming, appending and loading summaries must not read old message text");
  assert.equal(protocolReads, 0, "directory updates must not read tool results");
  sessions = [];
  assert.deepEqual(directory().map(item => item.id), ["unloaded"]);
});

test("task history omits missing duration and preserves a measured zero duration", () => {
  for (const status of ["success", "error", "interrupted"]) {
    const missing = renderToStaticMarkup(createElement(CanvasAgentTaskProcess, { status, timing: {} }));
    assert.ok(!missing.includes("执行耗时"), "old messages without timing must not display an empty duration label");
    const zero = renderToStaticMarkup(createElement(CanvasAgentTaskProcess, { status, timing: { elapsedMs: 0 } }));
    assert.ok(zero.includes("执行耗时"));
    assert.ok(zero.includes("0分 0秒"));
  }
});

test("accepted-run observation errors never overwrite the assistant with a failure reply", () => {
  const source = ts.createSourceFile("panel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isCatchClause(node) && node.block.getText(source).includes("error instanceof CanvasAgentObservationError")) handler = node.block;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler);
  const code = ts.transpileModule(`const handle = (error) => ${handler.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  class ObservationError extends Error {}
  for (const current of [true, false]) {
    for (const reason of [undefined, "canvas-detached"]) {
      const notices = [];
      const dependencies = {
        CanvasAgentSessionConflictError, CanvasAgentObservationError: ObservationError, isCurrentCanvasAgentRun: () => current,
        runLifecycleRef: { current: {} }, runEpoch: 1, controller: { signal: { reason } },
        onSyncError: error => notices.push(error), toast: { error: () => {} },
        updateSessionForRun: () => assert.fail("An observation error cannot replace the saved assistant reply"),
      };
      const run = new Function(...Object.keys(dependencies), `${code}\nreturn handle;`)(...Object.values(dependencies));
      run(new ObservationError("进度读取异常"));
      assert.deepEqual(notices, current && reason !== "canvas-detached" ? ["进度读取异常"] : []);
    }
  }
});

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
  const key = (key, isComposing = false, keyCode = 13) => ({ key, keyCode, nativeEvent: { isComposing, keyCode }, preventDefault() {} });
  choice.props.onClick({ target: { tagName: "INPUT" } });
  choice.props.onClick({ target: { tagName: "INPUT" } });
  choice.props.onKeyDown(key("Enter", true));
  choice.props.onKeyDown(key("Enter", false, 229));
  choice.props.onKeyDown(key("Enter"));
  assert.deepEqual(selected, ["继续", "继续", "继续"]);
  const textarea = elements.find(element => element.type === "textarea");
  textarea.props.onKeyDown(key("Enter", true));
  textarea.props.onKeyDown(key("Enter", false, 229));
  textarea.props.onKeyDown({ ...key("Enter"), shiftKey: true });
  assert.equal(selected.length, 3, "IME confirmation and newline must preserve the draft");
  textarea.props.onKeyDown(key("Enter"));
  assert.deepEqual(selected, ["继续", "继续", "继续", "自定义回复"]);
  assert.ok(elements.some(element => element.type === "span" && element.props.children === "保留原草稿"));
});

test("answer composer whitespace focuses its textarea without taking focus from controls", () => {
  for (const disabled of [false, true]) {
    const { elements } = answerInput({ options: [], value: "草稿", disabled, onChange() {}, onSelect() {} });
    const composer = elements.find(element => element.props.onClick && element.type !== "label");
    let focused = 0;
    const event = (control = null, defaultPrevented = false) => ({
      defaultPrevented,
      target: { closest: () => control },
      currentTarget: { querySelector(selector) {
        assert.equal(selector, "textarea");
        return { focus() { focused++; } };
      } },
    });
    composer.props.onClick(event());
    assert.equal(focused, disabled ? 0 : 1, "blank space activates the enabled answer editor");
    composer.props.onClick(event({ tagName: "BUTTON" }));
    composer.props.onClick(event({ tagName: "TEXTAREA" }));
    composer.props.onClick(event(null, true));
    assert.equal(focused, disabled ? 0 : 1, "buttons, caret placement and prevented clicks keep their native focus");
  }
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
  assert.match(answered, /data-slot="message"[^>]*data-role="user"/);
  assert.match(answered, /data-slot="message-content"/);
  assert.match(answered, /data-agent-question-prompt[^>]*>采用哪种方案？<\/p>/);
  assert.match(answered, /data-agent-question-answer[^>]*class="[^"]*text-foreground[^"]*"[^>]*>使用现有方案<\/p>/);
  assert.ok(answered.indexOf("采用哪种方案？") < answered.indexOf("使用现有方案"));
  assert.match(answered, /data-slot="bubble-content"[^>]*>[\s\S]*采用哪种方案？[\s\S]*使用现有方案/);
  assert.doesNotMatch(answered, /TraceCollapsible|已询问|aria-expanded/);

  const unanswered = renderToStaticMarkup(createElement(CanvasAgentQuestionRecord, { question: "采用哪种方案？" }));
  assert.match(unanswered, /等待回答/);
  assert.doesNotMatch(unanswered, /data-agent-question-answer/);
  const cancelled = renderToStaticMarkup(createElement(CanvasAgentQuestionRecord, { question: "采用哪种方案？", cancelled: true }));
  assert.match(cancelled, /已取消/);
  assert.doesNotMatch(cancelled, /等待回答|data-agent-question-answer/);
});

test("editing from a checkpoint reveals the original message after the editor renders and explains blockers", () => {
  const editStart = panelSource.indexOf("function editUserMessage(message:");
  const editEnd = panelSource.indexOf("function cancelMessageEdit", editStart);
  const editHandler = panelSource.slice(editStart, editEnd);
  assert.match(editHandler, /当前任务仍在运行，请等待停止后再编辑/);
  assert.match(editHandler, /请先回答或取消当前问题，再编辑并继续/);
  assert.match(editHandler, /setEditingUserMessageID\(message\.id\)/);
  assert.match(panelSource, /target\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\)/);
  assert.match(read("../src/app/canvas/canvas-agent-conversation.tsx"), /<Checkpoint\b[^>]*\bediting=\{editingMessageID === task\.request\.id\}/);
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

test("movie cards show media version status without a manual review flow", () => {
  const module = {exports:{}};
  const compiled = ts.transpileModule(read("../src/app/canvas/canvas-movie-card.tsx"), {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","module","exports",compiled)(name => {
    if(name === "react/jsx-runtime") return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name === "react") return {useState:initial=>[initial,()=>{}]};
    if(name === "lucide-react") return {Download:"Download",LocateFixed:"LocateFixed"};
    if(name.endsWith("/badge")) return {Badge:"Badge"};
    if(name.endsWith("/button")) return {Button:"Button"};
    if(name.endsWith("/card")) return {Card:"Card",CardContent:"CardContent",CardHeader:"CardHeader",CardTitle:"CardTitle"};
    if(name.endsWith("/media-video-player")) return {MediaVideoPlayer:"MediaVideoPlayer"};
    if(name.endsWith("/canvas-node-geometry")) return {canvasNodeAspectRatio:()=>9/16};
    if(name.endsWith("/canvas-media-download")) return {downloadCanvasNodeMedia:()=>{}};
    if(name === "sonner") return {toast:{error(){}}};
    throw new Error(`Unexpected import: ${name}`);
  },module,module.exports);
  for(const fixture of [
    {historical:true,want:"历史成片",variant:"secondary"},
    {outdated:true,want:"旧版本 · 待更新",variant:"destructive"},
    {want:"当前成片",variant:"secondary"},
  ]){
    const tree=module.exports.CanvasMovieCard({node:{id:"movie",type:"video",width:200,height:360},...fixture});
    const status=tree.props.children[0].props.children[1];
    assert.equal(status.props.children,fixture.want);
    assert.equal(status.props.variant,fixture.variant);
  }
});


test("conversation conflicts pause execution without replacing them with a model-failure message", () => {
 const source = ts.createSourceFile("panel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 let handler;
 function visit(node) {
  if (ts.isCatchClause(node) && node.block.getText(source).includes("error instanceof CanvasAgentSessionConflictError")) handler = node.block;
  ts.forEachChild(node, visit);
 }
 visit(source);
 assert.ok(handler);
 const code = ts.transpileModule(`const handle = (error) => ${handler.getText(source)};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
 let session = {messages: [{id: "user", role: "user", text: "preserved request"}, {id: "assistant", role: "assistant", text: "", status: "thinking", processingStartedAt: 1}]};
 const dependencies = {
  CanvasAgentSessionConflictError, sessionID: "s", runEpoch: 1, assistantID: "assistant", setCanvasAgentProcessing,
  updateSessionForRun: (_id, _epoch, update) => {session = update(session);},
 };
 const run = new Function(...Object.keys(dependencies), `${code}\nreturn handle;`)(...Object.values(dependencies));
 run(new CanvasAgentSessionConflictError(["s"], {id: "canvas"}));
 assert.equal(session.messages[0].text, "preserved request");
 assert.equal(session.messages[1].status, "waiting");
 assert.equal(session.messages[1].processingStartedAt, undefined);
 assert.match(session.messages[1].text, /保留两份对话/);
 assert.doesNotMatch(session.messages[1].text, /执行失败/);
});

test("conversation memoization preserves current actions and forwards every display update", () => {
  const text = read("../src/app/canvas/canvas-agent-conversation.tsx");
  const source = ts.createSourceFile("conversation.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wrapper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "CanvasAgentConversation");
  assert.ok(wrapper);
  const code = ts.transpileModule(wrapper.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const callbacks = [], retained = [], memoized = {};
  let cursor = 0;
  const useStableCallback = callback => {
    const index = cursor++;
    callbacks[index] = callback;
    return retained[index] ||= (...args) => callbacks[index](...args);
  };
  const require = createRequire(import.meta.url);
  const exports = {};
  new Function("require", "exports", "useStableCallback", "MemoizedCanvasAgentConversation", code)(require, exports, useStableCallback, memoized);
  const render = props => { cursor = 0; return exports.CanvasAgentConversation(props); };
  const called = [];
  const actions = ["onEdit", "onRetry", "onResume", "onChooseMedia", "onSaveEdit", "onCancelEdit", "onFocusNode"];
  const messages = [{ id: "u", role: "user", text: "Keep request" }], protocolMessages = [], nodes = [];
  const first = { messages, protocolMessages, nodes, busy: false, editDisabled: false, ...Object.fromEntries(actions.map(name => [name, (...args) => called.push({name, version: 1, args})])) };
  const initial = render(first);
  assert.equal(initial.type, memoized);
  const second = { ...first, ...Object.fromEntries(actions.map(name => [name, (...args) => called.push({name, version: 2, args})])) };
  const current = render(second);
  for (const key of Object.keys(initial.props)) assert.equal(current.props[key], initial.props[key], `draft rerender changed ${key}`);
  const actionArgs = { onEdit: [messages[0]], onRetry: [messages[0]], onResume: [], onChooseMedia: [], onSaveEdit: [messages[0], "edited text"], onCancelEdit: [], onFocusNode: ["image"] };
  for (const name of actions) initial.props[name](...actionArgs[name]);
  assert.deepEqual(called, actions.map(name => ({ name, version: 2, args: actionArgs[name] })));
  for (const [name, value] of Object.entries({
    messages: [...messages, { id: "a", role: "assistant", text: "New reply" }], protocolMessages: [{ role: "assistant", content: "New protocol" }],
    nodes: [{ id: "image", type: "image", url: "/new.png" }], run: { status: "running", assistantId: "a" },
    busy: true, editDisabled: true, pendingQuestion: "Choose one", editingMessageID: "u", resumable: true,
  })) assert.equal(render({ ...second, [name]: value }).props[name], value, `display update lost ${name}`);
  const absent = render({ ...second, onResume: undefined, onChooseMedia: undefined, onSaveEdit: undefined, onCancelEdit: undefined, onFocusNode: undefined });
  for (const name of actions.filter(name => name !== "onEdit" && name !== "onRetry")) assert.equal(absent.props[name], undefined, `optional ${name} became enabled`);
});

function conversationTaskRendering() {
  const text = read("../src/app/canvas/canvas-agent-conversation.tsx");
  const source = ts.createSourceFile("conversation.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text !== "CanvasAgentConversation");
  const item = source.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(source) === "CanvasAgentTaskItem");
  assert.ok(item && ts.isCallExpression(item.initializer));
  const comparator = item.initializer.arguments[1];
  assert.ok(comparator);
  const code = ts.transpileModule(functions.map(node => node.getText(source)).join("\n") + `\nconst compare = ${comparator.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  let serializedCharacters = 0, cursor = 0;
  const memo = [];
  const cachedValue = (create, deps) => {
    const index = cursor++;
    if (!memo[index] || !deps.every((value, i) => Object.is(value, memo[index].deps[i]))) memo[index] = { deps, value: create() };
    return memo[index].value;
  };
  const dependencies = {
    exports: {},
    require: createRequire(import.meta.url),
    useMemo: cachedValue, useCallback: (callback, deps) => cachedValue(() => callback, deps),
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    canvasAgentTaskGroups, canvasAgentTaskTimings, canvasAgentProtocolUserMessageIndex,
    ...canvasAgentPresentation, canvasDocumentValuesEqual,
    Button: "button", CanvasAgentTaskItem: "task-item", CanvasAgentNodeChip: "node-chip", AssistantMarkdown: "markdown", ASSISTANT_MARKDOWN_COMPONENTS: {},
    JSON: { parse: JSON.parse, stringify(value, ...args) { const encoded = JSON.stringify(value, ...args); serializedCharacters += encoded?.length || 0; return encoded; } },
  };
  const compiled = new Function(...Object.keys(dependencies), `${code}\nreturn {render: CanvasAgentConversationContent, compare};`)(...Object.values(dependencies));
  return {
    ...compiled,
    serializedCharacters: () => serializedCharacters,
    items(props) { cursor = 0; return compiled.render(props).props.children.flat(Infinity).filter(item => item?.type === "task-item").map(item => item.props); },
  };
}

function conversationTraceFixture() {
  const payload = { ok: true, nodes: [], retained: "Complete tool output 中文😀. ".repeat(60000) };
  const messages = [
    { id: "request", role: "user", text: "读取画布" },
    { id: "reply", role: "assistant", text: "读取完成", status: "success", elapsedMs: 123, trace: [{ id: "tool:read", type: "operation", kind: "read", label: "读取", detail: "已完成", status: "success" }] },
  ];
  const protocolMessages = [
    { role: "user", messageID: "request", content: "读取画布" },
    { role: "assistant", toolCalls: [{ id: "read", name: "get_canvas_summary", arguments: { complete: true } }] },
    { role: "tool", toolCallId: "read", name: "get_canvas_summary", content: JSON.stringify(payload) },
    { role: "assistant", content: "读取完成" },
  ];
  return { payload, props: { messages, protocolMessages, nodes: [], busy: false, editDisabled: false, onEdit() {}, onRetry() {} } };
}

test("task rendering and comparison preserve complete tool payloads without serialized signatures", () => {
  const harness = conversationTaskRendering(), { props, payload } = conversationTraceFixture();
  const initial = harness.items(props)[0];
  assert.deepEqual(initial.displayTraces.get("reply")[0].tool.output, payload);
  assert.equal(harness.serializedCharacters(), 0, "display equality must not serialize complete tool results");
  const copied = harness.items({ ...props, messages: structuredClone(props.messages), protocolMessages: structuredClone(props.protocolMessages) })[0];
  assert.equal(harness.compare(initial, copied), true, "equal snapshots should retain the rendered task");
  assert.equal(harness.serializedCharacters(), 0);
  assert.equal(harness.compare(initial, initial), true);
});

test("task equality forwards tool, plan, timing, source, message, action and node changes", () => {
  const harness = conversationTaskRendering(), { props } = conversationTraceFixture();
  const initial = harness.items(props)[0];
  const changedProtocol = structuredClone(props.protocolMessages);
  changedProtocol[2].content = JSON.stringify({ ok: true, nodes: [{ id: "new" }] });
  const changedTool = harness.items({ ...props, protocolMessages: changedProtocol })[0];
  assert.equal(harness.compare(initial, changedTool), false);
  assert.equal(harness.compare(initial, { ...initial, displayTraces: new Map() }), false);
  const messageChanges = [
    { text: "新的回复" }, { status: "waiting" }, { elapsedMs: 124 }, { processingStartedAt: 1000 },
    { references: [{ id: "image", type: "image", title: "新素材", url: "/image.png" }] },
    { trace: [{ id: "tool:read", type: "operation", kind: "read", label: "新标签", detail: "已完成", status: "success" }] },
  ];
  for (const changes of messageChanges) {
    const messages = [props.messages[0], { ...props.messages[1], ...changes }];
    assert.equal(harness.compare(initial, harness.items({ ...props, messages })[0]), false, `lost message changes: ${Object.keys(changes)}`);
  }
  for (const [key, value] of Object.entries({
    latestAssistantID: "other", pendingQuestion: "请选择", editingMessageID: "request", busy: true, editDisabled: true, resumable: true, runStatus: "running",
    onEdit() {}, onRetry() {}, onSaveEdit() {}, onCancelEdit() {}, onResume() {}, onChooseMedia() {}, handleFocusNode() {},
    timings: new Map([["reply", { elapsedMs: 999 }]]),
    protocolPresentation: { reasoning: [{ id: "reason", text: "新的推理" }], sources: [] },
    taskPlan: { explanation: "更新计划", steps: [{ id: "step", title: "生成", status: "deferred" }] },
  })) assert.equal(harness.compare(initial, { ...initial, [key]: value }), false, `lost ${key}`);
  assert.equal(harness.compare(initial, { ...initial, protocolPresentation: { reasoning: [], sources: [{ url: "https://example.com/new", title: "新来源" }] } }), false);
  const nodeProps = { ...props, nodes: [{ id: "image", type: "image", title: "原图" }], messages: [props.messages[0], { ...props.messages[1], text: "查看 `image`" }] };
  const nodeItem = harness.items(nodeProps)[0];
  assert.equal(harness.compare(nodeItem, harness.items({ ...nodeProps, nodes: [{ ...nodeProps.nodes[0], title: "新图" }] })[0]), false);
  assert.equal(harness.compare(initial, harness.items({ ...props, nodes: [{ id: "unrelated", type: "text" }] })[0]), true, "unrelated nodes should not rebuild plain task text");
});
