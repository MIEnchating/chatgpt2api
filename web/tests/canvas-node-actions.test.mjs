import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actionsSource = readFileSync(new URL("../src/app/canvas/canvas-node-actions-panel.tsx", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../src/app/canvas/canvas-engine.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8");
const specialNodesSource = readFileSync(new URL("../src/app/canvas/canvas-special-nodes.tsx", import.meta.url), "utf8");
const generationFooterSource = readFileSync(new URL("../src/app/canvas/canvas-generation-footer.tsx", import.meta.url), "utf8");
const imageComposerSource = readFileSync(new URL("../src/app/image/components/image-composer.tsx", import.meta.url), "utf8");
const agentSettingsSource = readFileSync(new URL("../src/app/canvas/canvas-agent-generation-settings.tsx", import.meta.url), "utf8");
const agentPanelSource = readFileSync(new URL("../src/app/canvas/canvas-agent-panel.tsx", import.meta.url), "utf8");
const canvasLibrarySource = readFileSync(new URL("../src/app/canvas/library-page.tsx", import.meta.url), "utf8");
const canvasSidePanelSource = readFileSync(new URL("../src/app/canvas/canvas-side-panel.tsx", import.meta.url), "utf8");
const configComposerSource = readFileSync(new URL("../src/app/canvas/canvas-config-composer.tsx", import.meta.url), "utf8");
const promptScrollFrameSource = readFileSync(new URL("../src/components/generation/prompt-textarea-frame.tsx", import.meta.url), "utf8");
const workflowSource = readFileSync(new URL("../src/components/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8");
const tooltipSource = readFileSync(new URL("../src/components/ui/tooltip.tsx", import.meta.url), "utf8");
const globalStylesSource = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const taskQueueSource = readFileSync(new URL("../src/components/image-task-queue.tsx", import.meta.url), "utf8");

test("the side drawer exposes the complete supported image operation set", () => {
  for (const label of ["局部编辑", "裁剪", "切图", "放大", "多角度", "自由缩放", "反推提示词", "复制提示词", "查看大图", "沉浸查看", "下载", "存入我的素材", "复制节点"]) {
    assert.match(actionsSource, new RegExp(label));
  }
  assert.match(engineSource, />操作<\/button>/);
  assert.match(engineSource, /renderNodeActions\(panelNode\)/);
  assert.doesNotMatch(actionsSource, /ActionSection title="生成"/);
});

test("the quick action rail supports every actionable node type", () => {
  for (const nodeType of ["image", "panorama", "video", "audio", "text", "director"]) {
    assert.match(actionsSource, new RegExp(`node\\.type === "${nodeType}"`));
  }
  for (const callback of ["onPreview", "onDownload", "onCopyPrompt", "onReversePrompt", "onSaveAsset", "onDuplicate", "onToggleFreeResize", "onTextToImage", "onOpenDirector"]) {
    assert.match(pageSource, new RegExp(`${callback}=\\{`));
  }
  assert.match(actionsSource, /max-h-\[calc\(100vh-9rem\)\]/);
  assert.match(actionsSource, /\[scrollbar-width:none\]/);
});

test("text, video, audio, panorama, config, and director actions use real page handlers", () => {
  assert.match(pageSource, /function renderNodeActions\(node: CanvasNode\)/);
  assert.match(pageSource, /onImageOperation=\{openImageOperation\}/);
  assert.match(pageSource, /onTextToImage=\{\(\) => generateFromTextNode\(node\.id\)\}/);
  assert.match(pageSource, /setOpenDirectorNodeID\(node\.id\)/);
  assert.match(pageSource, /saveCanvasNodeAsset\(node\.id\)/);
  assert.match(actionsSource, /node\.type === "video"/);
  assert.match(actionsSource, /node\.type === "audio"/);
  assert.match(actionsSource, /node\.type === "panorama"/);
  assert.match(actionsSource, /node\.type === "director"/);
});

test("node hover operations remain absent from the rendered canvas", () => {
  assert.doesNotMatch(engineSource, /data-canvas-node-toolbar/);
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

test("canvas node chrome supports compact details, collapsible tools, and overflow marquee titles", () => {
  assert.match(pageSource, /<InfoSection title="基础信息">/);
  assert.match(pageSource, /<InfoSection title="生成信息">/);
  assert.match(pageSource, /copyable/);
  assert.match(actionsSource, /data-collapsed=\{collapsed \|\| undefined\}/);
  assert.match(actionsSource, /展开工具栏/);
  assert.match(actionsSource, /<ChevronUp/);
  assert.doesNotMatch(actionsSource, /<ChevronDown/);
  assert.match(actionsSource, /transition-transform duration-300 ease-in-out/);
  assert.match(actionsSource, /collapsed && "rotate-180"/);
  assert.match(actionsSource, /inert=\{collapsed\}/);
  assert.match(actionsSource, /transition-\[grid-template-rows,transform\] duration-300 ease-in-out/);
  assert.match(actionsSource, /transitionDelay: collapsed/);
  assert.doesNotMatch(actionsSource, /hover:scale-105[^"\n]*active:scale-90/);
  assert.match(actionsSource, /grid-rows-\[0fr\]/);
  assert.match(actionsSource, /grid-rows-\[1fr\]/);
  assert.match(engineSource, /data-canvas-no-pan className="pointer-events-auto mt-16 hidden shrink-0 sm:block"/);
  assert.ok((engineSource.match(/<OverflowMarqueeText/g) || []).length >= 2);
  assert.match(globalStylesSource, /@keyframes overflow-marquee/);
});

test("the canvas side panel animates without unmounting and uses the material library label", () => {
  assert.doesNotMatch(canvasSidePanelSource, /if \(!open\) return null/);
  assert.match(canvasSidePanelSource, /style=\{\{ width: open \? width : 0 \}\}/);
  assert.match(canvasSidePanelSource, /transition-\[opacity,transform,box-shadow,border-color\] duration-300 ease-in-out/);
  assert.match(canvasSidePanelSource, />素材库<\/SidePanelTab>/);
  assert.doesNotMatch(canvasSidePanelSource, />资产<\/SidePanelTab>/);
  assert.match(pageSource, /<PanelLeftClose className=\{cn\("absolute inset-0/);
  assert.match(pageSource, /<PanelLeftOpen className=\{cn\("absolute inset-0/);
  assert.match(pageSource, /active:scale-90/);
});

test("the canvas side panel resize target stays outside its internal scrollbar", () => {
  assert.match(canvasSidePanelSource, /w-2 translate-x-full cursor-col-resize/);
  assert.match(canvasSidePanelSource, /absolute inset-y-0 left-0 w-px/);
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
  assert.match(pageSource, /syncCanvasTaskQueue\(documentRef\.current\.id, titleRef\.current, next\)/);
  assert.match(taskQueueSource, /subscribeCanvasTaskQueue/);
  assert.match(taskQueueSource, /activeCount = queueItems\.length \+ activeCanvasTasks\.length/);
  assert.match(taskQueueSource, /navigate\(canvasProjectPath\(canvasID\)\)/);
});

test("shared tooltips include a directional arrow and comfortable trigger spacing", () => {
  assert.match(tooltipSource, /sideOffset = 10/);
  assert.match(tooltipSource, /<TooltipPrimitive\.Arrow/);
  assert.match(tooltipSource, /<svg className="overflow-visible"/);
  assert.match(tooltipSource, /className="fill-popover" d="M-2-1H32L15 10Z"/);
  assert.match(tooltipSource, /d="M0 0 15 10 30 0"/);
  assert.match(tooltipSource, /width=\{14\}/);
  assert.match(tooltipSource, /vectorEffect="non-scaling-stroke"/);
});

test("the bottom node toolbar does not render a clipped light-theme shadow", () => {
  assert.match(pageSource, /shadow-none backdrop-blur-xl dark:shadow-\[0_10px_28px_rgba\(0,0,0,\.24\)\]/);
});

test("every canvas prompt editor can resize without hiding its parameter panel", () => {
  assert.match(globalStylesSource, /\.canvas-prompt-scroll-frame \{[\s\S]*?max-height: max\(5rem, min\(40vh, calc\(100dvh - 26rem\)\)\);[\s\S]*?resize: vertical;/);
  assert.ok((pageSource.match(/<PromptTextareaFrame/g) || []).length >= 3);
  assert.ok((specialNodesSource.match(/<PromptTextareaFrame/g) || []).length >= 2);
  assert.match(promptScrollFrameSource, /<ScrollArea className="h-full"/);
  assert.match(promptScrollFrameSource, /querySelector\("textarea"\)/);
  assert.match(promptScrollFrameSource, /Math\.max\(frame\.clientHeight, textarea\.scrollHeight\)/);
  assert.ok((pageSource.match(/className="h-0 min-h-40 flex-1"/g) || []).length >= 2);
  assert.ok((specialNodesSource.match(/className="h-0 min-h-40 flex-1"/g) || []).length >= 2);
  assert.match(configComposerSource, /canvas-prompt-editor-resize relative h-28/);
  assert.match(configComposerSource, /<ScrollArea className="h-full" viewportClassName="h-full"/);
  assert.doesNotMatch(pageSource, /canvas-prompt-resize/);
  assert.doesNotMatch(specialNodesSource, /canvas-prompt-resize/);
});

test("config prompt references use a stable standalone picker and reliable deletion", () => {
  assert.match(configComposerSource, /createPortal\(/);
  assert.match(configComposerSource, /data-canvas-config-mention-menu/);
  assert.match(configComposerSource, /className="fixed z-\[140\]/);
  assert.match(configComposerSource, /composerCaretRect\(editor\)/);
  assert.match(configComposerSource, /remove\.addEventListener\("pointerdown", deleteReference\)/);
  assert.match(configComposerSource, /onChange\(serializeEditor\(editor\), true\)/);
  assert.doesNotMatch(configComposerSource, /remove\.dataset\.tooltip/);
  assert.doesNotMatch(configComposerSource, /className="absolute top-\[calc\(100%\+6px\)\]/);
});

test("every canvas parameter panel uses the shared generation footer", () => {
  assert.ok((pageSource.match(/<CanvasGenerationFooter/g) || []).length >= 3);
  assert.ok((specialNodesSource.match(/<CanvasGenerationFooter/g) || []).length >= 2);
  assert.match(generationFooterSource, /h-10 w-full/);
  assert.match(generationFooterSource, /bg-\[#1456f0\]/);
});

test("canvas and creator video parameters use the shared settings panel", () => {
  assert.match(pageSource, /<VideoSettingsPanel/);
  assert.match(imageComposerSource, /<VideoSettingsPanel/);
});

test("both canvas Agent entries reuse the shared image and video settings panels", () => {
  assert.match(agentSettingsSource, /<ImageSettingsPanel/);
  assert.match(agentSettingsSource, /<VideoSettingsPanel/);
  for (const source of [agentPanelSource, canvasLibrarySource]) {
    assert.match(source, /<CanvasAgentImageSettings/);
    assert.match(source, /<CanvasAgentVideoSettings/);
  }
});

test("Agent parameter popovers do not autofocus the first tooltip trigger", () => {
  for (const source of [agentPanelSource, canvasLibrarySource]) {
    assert.match(source, /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/);
  }
});

test("Agent entry names are consistent across canvas and workflows", () => {
  for (const source of [pageSource, agentPanelSource, canvasLibrarySource, workflowSource]) {
    assert.doesNotMatch(source, /创作 Agent|画布 Agent|AI 创建|Agent 创建画布|Agent 创建工作流/);
  }
  assert.match(agentPanelSource, /"history" \? "历史对话" : "Agent"/);
  assert.match(canvasLibrarySource, /<Bot \/>Agent<\/Button>/);
  assert.match(workflowSource, /<Bot \/>Agent<\/Button>/);
});

test("Agent node references do not open the node drawer and new chat stays available when idle", () => {
  assert.match(pageSource, /if \(agentOpen\) \{\s*setPanelNodeID\(""\);\s*return;/);
  assert.match(pageSource, /onClick=\{\(\) => \{\s*setPanelNodeID\(""\);\s*setAgentOpen\(true\)/);
  assert.match(agentPanelSource, /aria-label="新对话" disabled=\{busy\}/);
  assert.doesNotMatch(agentPanelSource, /aria-label="新对话" disabled=\{!activeSession\.messages\.length\}/);
});
