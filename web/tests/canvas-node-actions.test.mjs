import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actionsSource = readFileSync(new URL("../src/app/canvas/canvas-node-actions-panel.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const engineSource = readFileSync(new URL("../src/app/canvas/canvas-engine.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const controlsSource = readFileSync(new URL("../src/app/canvas/canvas-workspace-controls.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const pageSource = readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const specialNodesSource = readFileSync(new URL("../src/app/canvas/canvas-special-nodes.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const generationFooterSource = readFileSync(new URL("../src/app/canvas/canvas-generation-footer.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const imageComposerSource = readFileSync(new URL("../src/app/image/components/image-composer.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const agentPanelSource = readFileSync(new URL("../src/app/canvas/canvas-agent-panel.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const canvasLibrarySource = readFileSync(new URL("../src/app/canvas/library-page.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const canvasSidePanelSource = readFileSync(new URL("../src/app/canvas/canvas-side-panel.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const configComposerSource = readFileSync(new URL("../src/app/canvas/canvas-config-composer.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const promptScrollFrameSource = readFileSync(new URL("../src/components/generation/prompt-textarea-frame.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const workflowSource = readFileSync(new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const tooltipSource = readFileSync(new URL("../src/components/ui/tooltip.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const globalStylesSource = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const taskQueueSource = readFileSync(new URL("../src/components/image-task-queue.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const canvasTaskQueueStoreSource = readFileSync(new URL("../src/store/canvas-task-queue.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const imageToolsSource = readFileSync(new URL("../src/app/canvas/canvas-image-tools.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("node tools retain media operations and leave generic commands in the context menu", () => {
  for (const label of ["局部编辑", "裁剪", "切图", "放大", "多角度", "自由缩放", "反推提示词", "下载", "存入我的素材"]) {
    assert.match(actionsSource, new RegExp(label));
  }
  assert.doesNotMatch(engineSource, /id: "actions", label: "操作"/);
  assert.match(pageSource, /onClick=\{onCopyContent\}/);
  assert.match(pageSource, /onClick=\{onDuplicate\}>复制节点/);
  assert.doesNotMatch(actionsSource, /复制节点|复制提示词|复制文字/);
  assert.match(actionsSource, /更多节点操作/);
  assert.doesNotMatch(actionsSource, /ActionSection title="生成"/);
});

test("canvas image tool drags release window listeners on every exit path", () => {
  const hookStart = imageToolsSource.indexOf("function useWindowPointerDrag");
  const hookEnd = imageToolsSource.indexOf("export function CanvasCropDialog", hookStart);
  assert.ok(hookStart >= 0 && hookEnd > hookStart);
  const hookSource = imageToolsSource.slice(hookStart, hookEnd);
  for (const eventName of ["pointermove", "pointerup", "pointercancel", "blur"]) {
    assert.match(hookSource, new RegExp(`window\\.addEventListener\\("${eventName}"`));
    assert.match(hookSource, new RegExp(`window\\.removeEventListener\\("${eventName}"`));
  }
  assert.match(hookSource, /useEffect\(\(\) => stopDragging, \[stopDragging\]\)/);
  assert.ok((imageToolsSource.match(/stopDragging\(\);[\s\S]*?if \((?:open|!open)\)/g) || []).length >= 2);
  assert.ok((imageToolsSource.match(/startDragging\(move, /g) || []).length >= 2);
});

test("the horizontal quick actions support every actionable node type", () => {
  for (const nodeType of ["image", "panorama", "video", "audio", "text", "director"]) {
    assert.match(actionsSource, new RegExp(`node\\.type === "${nodeType}"`));
  }
  for (const callback of ["onDownload", "onReversePrompt", "onSaveAsset", "onDuplicate", "onToggleFreeResize", "onTextToImage", "onOpenDirector"]) {
    assert.match(pageSource, new RegExp(`${callback}=\\{`));
  }
  assert.match(actionsSource, /<ScrollArea/);
  assert.match(actionsSource, /viewClass="flex w-max min-w-full items-center gap-1"/);
});

test("text, video, audio, panorama, config, and director actions use real page handlers", () => {
  assert.match(pageSource, /function renderNodeQuickActions\(node: CanvasNode\)/);
  assert.match(pageSource, /onImageOperation=\{\(operation\) => void openCanvasImageTool\(node.id, operation\)\}/);
  assert.match(pageSource, /onTextToImage=\{\(\) => generateFromTextNode\(node\.id\)\}/);
  assert.match(pageSource, /setOpenDirectorNodeID\(node\.id\)/);
  assert.match(pageSource, /saveCanvasNodeAsset\(node\.id\)/);
  assert.match(actionsSource, /node\.type === "video"/);
  assert.match(actionsSource, /node\.type === "audio"/);
  assert.match(actionsSource, /node\.type === "panorama"/);
  assert.match(actionsSource, /node\.type === "director"/);
});

test("node actions require a single selected node in selection mode", () => {
  assert.match(engineSource, /const actionNode = !exporting && tool === "select" && selectedNodeIDs.size === 1/);
  assert.match(engineSource, /<CanvasNodeToolbar key=\{actionNode.id\}/);
});

test("media nodes have a dedicated preview action and double click focuses the node", () => {
  assert.match(actionsSource, /aria-label="预览" onClick=\{onPreview\}/);
  assert.match(pageSource, /onPreview=\{\(\) => setPreviewNodeID\(node\.id\)\}/);
  assert.match(engineSource, /onDoubleClick=\{\(event\) => \{[\s\S]{0,180}onFocusNode\(node\.id\)/);
  assert.doesNotMatch(specialNodesSource, /expandOnDoubleClick onMoveStart/);
  assert.match(pageSource, /onFocusNode=\{focusCanvasNode\}/);
});

test("optional canvas image information only shows dimensions and file size", () => {
  const imageInfo = engineSource.match(/<div data-canvas-image-info[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(imageInfo, /natural_width/);
  assert.match(imageInfo, /formatImageBytes\(node\.bytes\)/);
  assert.doesNotMatch(imageInfo, /node\.title|<Info/);
  assert.match(engineSource, /getCachedAuthenticatedImageByteSize\(node\.url\)/);
  assert.match(pageSource, /const bytesChanged =/);
  assert.match(pageSource, /const nextNodes = nodesRef\.current\.map/);
  assert.match(pageSource, /return \{ \.\.\.node, url: hydrated\.url \}/);
  assert.doesNotMatch(pageSource, /replaceNodes\(hydratedNodes\)/);
});

test("canvas node chrome supports compact details and overflow marquee titles", () => {
  assert.match(pageSource, /<InfoSection title="基础信息">/);
  assert.match(pageSource, /<InfoSection title="生成信息">/);
  assert.match(pageSource, /copyable/);
  assert.match(engineSource, /<OverflowMarqueeText text=\{node.title/);
  assert.match(globalStylesSource, /@keyframes overflow-marquee/);
});

test("the canvas side panel animates without unmounting and uses the generation history label", () => {
  assert.doesNotMatch(canvasSidePanelSource, /if \(!open\) return null/);
  assert.match(canvasSidePanelSource, /--canvas-side-panel-width/);
  assert.match(canvasSidePanelSource, /open \? width : 0/);
  assert.match(canvasSidePanelSource, /transition-\[opacity,transform,box-shadow,border-color\] duration-300 ease-in-out/);
  assert.match(canvasSidePanelSource, />生成历史<\/SidePanelTab>/);
  assert.doesNotMatch(canvasSidePanelSource, />资产<\/SidePanelTab>/);
  assert.doesNotMatch(pageSource, /aria-label=\{sidePanel.open \? "收起侧栏"/);
  assert.match(canvasSidePanelSource, /data-canvas-side-panel-footer[\s\S]*?aria-label="收起侧栏"/);
  assert.match(canvasSidePanelSource, /共 \{nodes.length\} 节点/);
});

test("the canvas side panel resize target stays outside its internal scrollbar", () => {
  assert.match(canvasSidePanelSource, /w-2 translate-x-1\/2 cursor-col-resize/);
  assert.match(canvasSidePanelSource, /absolute inset-y-0 left-1\/2 w-px/);
  assert.doesNotMatch(canvasSidePanelSource, /w-3 translate-x-1\/2 cursor-col-resize/);
});

test("the canvas prompt library shares chronological ordering and limits every category", () => {
  assert.match(canvasSidePanelSource, /sortPromptMarketPrompts/);
  assert.match(canvasSidePanelSource, /promptMatchesKeyword\(prompt, query\)/);
  assert.match(canvasSidePanelSource, /SIDE_PANEL_PROMPT_CATEGORY_PAGE_SIZE = 12/);
  assert.doesNotMatch(canvasSidePanelSource, /SYSTEM_PROMPT_SOURCE_ID|系统提示词|暂无系统提示词/);
  assert.match(canvasSidePanelSource, /const promptGroups = useMemo/);
  assert.match(canvasSidePanelSource, /category\.prompts\.slice\(0, visibleCount\)/);
  assert.match(canvasSidePanelSource, /加载更多（\{visiblePrompts\.length\}\/\{category\.prompts\.length\}）/);
  assert.match(canvasSidePanelSource, /expandedCategoryID/);
  assert.match(canvasSidePanelSource, /expandedCategoryID === category\.id/);
  assert.doesNotMatch(canvasSidePanelSource, /collapsedCategories/);
  assert.match(canvasSidePanelSource, /memo\(function CanvasPromptsTab/);
  assert.match(canvasSidePanelSource, /insertPromptRef\.current/);
  assert.doesNotMatch(canvasSidePanelSource, /onEndReached=\{revealMore\}/);
  assert.doesNotMatch(canvasSidePanelSource, /filter\(\(prompt\) => !prompt\.isNsfw\)/);
});

test("the canvas prompt cache is bounded and isolated by authenticated session", () => {
  assert.match(pageSource, /<CanvasSidePanel[\s\S]*?sessionKey=\{session\.key\}/);
  assert.match(canvasSidePanelSource, /sidePanelPromptCache = new Map<string, SidePanelPromptCacheEntry>/);
  assert.match(canvasSidePanelSource, /sidePanelPromptRequests = new Map<string, Promise<SidePanelPromptData>>/);
  assert.match(canvasSidePanelSource, /SIDE_PANEL_PROMPT_CACHE_TTL_MS = 5 \* 60_000/);
  assert.match(canvasSidePanelSource, /SIDE_PANEL_PROMPT_CACHE_LIMIT = 8/);
  assert.match(canvasSidePanelSource, /loadSidePanelPrompts\(sessionKey, force\)/);
  assert.match(canvasSidePanelSource, /sidePanelPromptRequests\.get\(key\) === tracked/);
  assert.match(canvasSidePanelSource, /requestVersionRef\.current !== requestVersion/);
});

test("canvas generation is concurrent per node and stopping is task scoped", () => {
  assert.match(pageSource, /activeGenerationsRef = useRef\(new Map<string, CanvasActiveGeneration>\(\)\)/);
  assert.match(pageSource, /async function runAudioGeneration\(nodeID: string, concurrent = true/);
  assert.match(pageSource, /async function runVideoGeneration\(nodeID: string, prompt\?: string, concurrent = true/);
  assert.match(pageSource, /const concurrent = options\.concurrent !== false/);
  assert.match(pageSource, /activeGenerationsRef\.current\.has\(nodeID\)/);
  assert.match(pageSource, /function requestStopGeneration\(nodeID: string\)/);
  assert.match(pageSource, /generation\.submittedTaskIDs\.forEach\(\(taskID\)/);
  assert.match(pageSource, /其他节点的任务会继续运行/);
  assert.doesNotMatch(pageSource, /generationBusy=\{Boolean\(runningNodeID\)\}/);
  assert.doesNotMatch(pageSource, /busy=\{Boolean\(runningNodeID\)/);
  assert.match(pageSource, /syncCanvasTaskQueue\(session\.key, documentRef\.current\.id, titleRef\.current, next\)/);
  assert.match(taskQueueSource, /subscribeCanvasTaskQueue/);
  assert.match(taskQueueSource, /activeCount = queueItems\.length \+ activeCanvasTasks\.length/);
  assert.match(taskQueueSource, /navigate\(canvasProjectPath\(canvasID\)\)/);
});

test("canvas task queue is cleared across projects and sessions before stale work can resync", () => {
  const applyDocumentSource = pageSource.slice(
    pageSource.indexOf("function applyDocument"),
    pageSource.indexOf("async function hydrateCanvasStorageURLs"),
  );
  assert.match(applyDocumentSource, /clearCanvasTaskQueueForCanvas\(session\.key, previousCanvasID\)/);
  const titleUpdateIndex = applyDocumentSource.indexOf("titleRef.current = next.title");
  const nodeSyncIndex = applyDocumentSource.indexOf("replaceNodes(next.nodes");
  assert.ok(titleUpdateIndex >= 0 && nodeSyncIndex >= 0 && titleUpdateIndex < nodeSyncIndex);

  const lifecycleStart = pageSource.indexOf("useEffect(() => {\n    const batchAnimationTimers");
  assert.ok(lifecycleStart >= 0);
  const lifecycleSource = pageSource.slice(lifecycleStart, pageSource.indexOf("\n  useEffect(() => {", lifecycleStart + 1));
  assert.match(lifecycleSource, /activateCanvasTaskQueueSession\(session\.key\)/);
  assert.match(lifecycleSource, /active = false;[\s\S]*?canvasOperationEpochRef\.current \+= 1;[\s\S]*?clearCanvasTaskQueueForSession\(session\.key\)/);
  assert.match(lifecycleSource, /\}, \[projectID, session\.key\]\);/);
  assert.match(canvasTaskQueueStoreSource, /window\.addEventListener\(AUTH_SESSION_CHANGE_EVENT,[\s\S]*?clearSnapshot\(\)/);
});

test("canvas routes every generation through the key matched to its actual node model", () => {
  assert.match(pageSource, /const relayTokenName = nextTokenNameForModel\("text", model\)/);
  assert.match(pageSource, /const relayTokenName = nextTokenNameForModel\("audio", generationAudioModel\)/);
  assert.match(pageSource, /const relayTokenName = nextTokenNameForModel\("image", generationModel\)/);
  assert.match(pageSource, /const relayTokenName = nextTokenNameForModel\("video", selectedModel\)/);
  assert.match(pageSource, /const taskRelayTokenName = nextTokenNameForModel\("image", generationModel\)\.trim\(\)/);
  assert.match(pageSource, /relayTokenName=\{tokenNameForModel\("audio", nodeAudioModel\)\}/);
  assert.doesNotMatch(pageSource, /const (?:image|video|audio|text)RelayTokenName = tokenNameForModel/);
});

test("shared tooltips include a directional arrow and comfortable trigger spacing", () => {
  assert.match(tooltipSource, /sideOffset = 10/);
  assert.match(tooltipSource, /<TooltipPrimitive\.Arrow/);
  assert.match(tooltipSource, /<svg viewBox="0 0 14 7" preserveAspectRatio="none" className="overflow-visible"/);
  assert.match(tooltipSource, /className="fill-popover" d="M0-2H14V-.5L7 6.5 0-.5Z"/);
  assert.match(tooltipSource, /d="M0-.5 7 6.5 14-.5"/);
  assert.match(tooltipSource, /width=\{14\}/);
  assert.match(tooltipSource, /vectorEffect="non-scaling-stroke"/);
});

test("shared tooltips close when their trigger performs an action", () => {
  assert.match(tooltipSource, /const \[open, setOpen\] = React\.useState\(false\)/);
  assert.match(tooltipSource, /<Tooltip open=\{open\} onOpenChange=\{setOpen\}>/);
  assert.match(tooltipSource, /onPointerDown=\{\(\) => setOpen\(false\)\}/);
  assert.match(tooltipSource, /onClick=\{\(\) => setOpen\(false\)\}/);
});

test("canvas controls use available canvas width without horizontal scrolling", () => {
  assert.match(pageSource, /width=\{controlsWidth\}/);
  assert.match(controlsSource, /props.width < CANVAS_DOCK_BREAKPOINT/);
  assert.doesNotMatch(controlsSource, /overflow-x-auto/);
});

test("canvas prompt editors keep scrollable input and parameter panels", () => {
  assert.match(globalStylesSource, /\.canvas-prompt-scroll-frame \{[\s\S]*?max-height: max\(5rem, min\(40vh, calc\(100dvh - 26rem\)\)\);[\s\S]*?resize: vertical;/);
  assert.ok((pageSource.match(/<PromptTextareaFrame/g) || []).length >= 1);
  assert.ok((specialNodesSource.match(/<PromptTextareaFrame/g) || []).length >= 2);
  assert.match(promptScrollFrameSource, /<ScrollArea className="h-full"/);
  assert.match(promptScrollFrameSource, /querySelector\("textarea"\)/);
  assert.match(promptScrollFrameSource, /Math\.max\(frame\.clientHeight, textarea\.scrollHeight\)/);
  assert.ok((pageSource.match(/className="h-0 min-h-0 flex-1"/g) || []).length >= 1);
  assert.ok((specialNodesSource.match(/<AppScrollArea className="min-h-0 flex-1"/g) || []).length >= 2);
  assert.match(configComposerSource, /canvas-prompt-editor-resize relative h-28/);
  assert.match(configComposerSource, /<ScrollArea className="h-full" viewportClassName="h-full"/);
  assert.doesNotMatch(pageSource, /canvas-prompt-resize/);
  assert.doesNotMatch(specialNodesSource, /canvas-prompt-resize/);
});

test("config prompt references use a stable standalone picker and reliable deletion", () => {
  assert.match(configComposerSource, /createPortal\(/);
  assert.match(configComposerSource, /data-canvas-config-mention-menu/);
  assert.match(configComposerSource, /className="pointer-events-auto fixed z-\[140\]/);
  assert.match(configComposerSource, /composerCaretRect\(editor\)/);
  assert.match(configComposerSource, /remove\.addEventListener\("pointerdown", deleteReference\)/);
  assert.match(configComposerSource, /onChange\(serializeEditor\(editor\), true\)/);
  assert.doesNotMatch(configComposerSource, /remove\.dataset\.tooltip/);
  assert.doesNotMatch(configComposerSource, /className="absolute top-\[calc\(100%\+6px\)\]/);
});

test("every canvas parameter panel uses the shared generation footer", () => {
  assert.ok((pageSource.match(/<CanvasGenerationFooter/g) || []).length >= 3);
  assert.ok((specialNodesSource.match(/<CanvasGenerationFooter/g) || []).length >= 2);
  assert.match(generationFooterSource, /size-8 min-w-0 rounded-xl p-0/);
  assert.match(generationFooterSource, /variant=\{running \? "destructive" : "default"\}/);
});

test("canvas and creator video parameters use the shared settings panel", () => {
  assert.match(pageSource, /<VideoSettingsPanel/);
  assert.match(imageComposerSource, /<VideoSettingsPanel/);
});

test("both Agent entries let the request determine media instead of exposing fixed parameters", () => {
  for (const source of [agentPanelSource, canvasLibrarySource]) {
    assert.doesNotMatch(source, /CanvasAgentImageSettings|CanvasAgentVideoSettings|ParameterMenu/);
    assert.match(source, /<CanvasAgentSkillPicker/);
  }
});

test("Agent entry names are consistent across canvas and workflows", () => {
  for (const source of [pageSource, agentPanelSource, canvasLibrarySource, workflowSource]) {
    assert.doesNotMatch(source, /创作 Agent|画布 Agent|AI 创建|Agent 创建画布|Agent 创建工作流/);
  }
  assert.match(agentPanelSource, /"history" \? "历史对话" : activeSession.title \|\| "Agent"/);
  assert.match(canvasLibrarySource, /<Bot \/>Agent<\/Button>/);
  assert.match(workflowSource, /<Bot \/>Agent<\/Button>/);
});

test("Agent allows node settings while preserving references and idle new chat", () => {
  assert.match(pageSource, /panelNodeID=\{panelNodeID\}/);
  assert.match(pageSource, /onAgent=\{\(\) => \{[\s\S]*?setPanelNodeID\(""\);\s*setAgentOpen\(true\)/);
  assert.match(agentPanelSource, /aria-label="新对话" disabled=\{busy\}/);
  assert.doesNotMatch(agentPanelSource, /aria-label="新对话" disabled=\{!activeSession\.messages\.length\}/);
});

test("Agent panel has a fixed width without resize handles or listeners", () => {
  assert.doesNotMatch(agentPanelSource, /onWidthChange|startResize|resizeCleanupRef|调整右侧面板宽度/);
  assert.doesNotMatch(pageSource, /setAgentWidth/);
  assert.match(agentPanelSource, /CANVAS_AGENT_WIDTH/);
});

test("Agent submission claims synchronous ownership before hydrating references", () => {
  const claimIndex = agentPanelSource.indexOf("const controller = claimCanvasAgentRun(abortRef)");
  const hydrationIndex = agentPanelSource.indexOf("await hydrateSavedReferences", claimIndex);
  assert.ok(claimIndex >= 0);
  assert.ok(hydrationIndex > claimIndex);
  assert.match(agentPanelSource, /if \(releaseCanvasAgentRun\(abortRef, controller\)\) setBusy\(false\)/);
  assert.doesNotMatch(agentPanelSource, /if \(!text \|\| busy \|\| !activeSession\) return/);
});

test("Agent initial requests are consumed only after their user message is committed", () => {
  assert.match(agentPanelSource, /if \(!controller\) return "busy"/);
  const claimIndex = agentPanelSource.indexOf("const controller = claimCanvasAgentRun(abortRef)");
  const submitIndex = agentPanelSource.indexOf("submitInitialRequestRef.current(initialRequest.prompt", claimIndex);
  const messageCommitIndex = agentPanelSource.indexOf("if (!updateSessionForRun(sessionID, runEpoch", claimIndex);
  const committedCallbackIndex = agentPanelSource.indexOf("options.onUserMessageCommitted?.()", messageCommitIndex);
  const consumedIndex = agentPanelSource.indexOf("consumedInitialRequestRef.current = initialRequest", submitIndex);
  assert.ok(claimIndex >= 0);
  assert.ok(submitIndex > claimIndex);
  assert.ok(messageCommitIndex > claimIndex);
  assert.ok(committedCallbackIndex > messageCommitIndex);
  assert.ok(consumedIndex > submitIndex);
  assert.match(agentPanelSource, /if \(\(agentMode === "native" && !relayPreferencesReady\) \|\| !initialRequest/);
  assert.match(agentPanelSource, /previous\?\.request === initialRequest && previous\.reason === result/);
  assert.match(agentPanelSource, /\}, \[agentMode, busy, codex\.connected, codex\.model, initialRequest, model, relayPreferencesReady, relayTokenName\]\)/);
  assert.match(agentPanelSource, /const stopped = controller\.signal\.aborted \|\| \(error instanceof Error && error\.name === "AbortError"\)/);
});

test("Agent run callbacks and project persistence reject stale lifecycle scopes", () => {
  assert.match(agentPanelSource, /const lifecycle = runLifecycleRef\.current;\s*mountCanvasAgentRunLifecycle\(lifecycle\);[\s\S]*invalidateCanvasAgentRunLifecycle\(lifecycle\);\s*abortCanvasAgentRun\(abortRef\)/);
  assert.match(agentPanelSource, /onEvent: \(event\) => updateSessionForRun\(sessionID, runEpoch/);
  assert.match(agentPanelSource, /onCheckpoint: \(checkpoint\) => updateSessionForRun\(sessionID, runEpoch/);
  assert.match(pageSource, /const renderedCanvasID = documentRef\.current\.id/);
  assert.match(pageSource, /onSessionsChange=\{\(sessions, activeSessionID\) => \{\s*if \(documentRef\.current\.id !== renderedCanvasID\) return/);
  assert.match(pageSource, /onExecuteAction=\{\(action, messageReferenceNodeIDs, execution\) => documentRef\.current\.id === renderedCanvasID/);
});

test("Agent history deletion stays unavailable for the whole active run", () => {
  assert.match(agentPanelSource, /aria-label="删除所选对话" disabled=\{busy \|\| !checkedSessionIDs\.length\}/);
  assert.match(agentPanelSource, /aria-label="删除全部对话" disabled=\{busy \|\| !historySessions\.length\}/);
  assert.match(agentPanelSource, /deleteDisabled=\{busy\}/);
  assert.match(agentPanelSource, /variant="destructive" disabled=\{busy\}/);
  assert.match(agentPanelSource, /function removeSessions\(sessionIDs: string\[\]\) \{\s*if \(busy\) return/);
});
