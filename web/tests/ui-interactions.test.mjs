import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scrollAreaSource = await readFile(new URL("../src/components/ui/scroll-area.tsx", import.meta.url), "utf8");
const selectSource = await readFile(new URL("../src/components/ui/select.tsx", import.meta.url), "utf8");
const dialogSource = await readFile(new URL("../src/components/ui/dialog.tsx", import.meta.url), "utf8");
const inputTagSource = await readFile(new URL("../src/components/ui/input-tag.tsx", import.meta.url), "utf8");
const multiSelectSource = await readFile(new URL("../src/components/ui/multi-select.tsx", import.meta.url), "utf8");
const workflowSource = await readFile(new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8");
const workflowPageSource = await readFile(new URL("../src/app/workflows/page.tsx", import.meta.url), "utf8");
const imageTaskQueueSource = await readFile(new URL("../src/components/image-task-queue.tsx", import.meta.url), "utf8");
const globalStylesSource = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
const imageParameterStylesSource = await readFile(new URL("../src/components/generation/image-parameter-styles.ts", import.meta.url), "utf8");
const aspectRatioOptionSource = await readFile(new URL("../src/components/generation/aspect-ratio-option.tsx", import.meta.url), "utf8");
const imageSizePresetControlsSource = await readFile(new URL("../src/components/generation/image-size-preset-controls.tsx", import.meta.url), "utf8");
const imageSettingsPanelSource = await readFile(new URL("../src/components/generation/image-settings-panel.tsx", import.meta.url), "utf8");
const imageSidebarSource = await readFile(new URL("../src/app/image/components/image-sidebar.tsx", import.meta.url), "utf8");
const videoSettingsPanelSource = await readFile(new URL("../src/components/generation/video-settings-panel.tsx", import.meta.url), "utf8");
const imageComposerSource = await readFile(new URL("../src/app/image/components/image-composer.tsx", import.meta.url), "utf8");
const imagePageSource = await readFile(new URL("../src/app/image/page.tsx", import.meta.url), "utf8");
const logGovernanceSource = await readFile(new URL("../src/app/settings/components/log-governance-card.tsx", import.meta.url), "utf8");
const videoContractsSource = await readFile(new URL("../src/app/settings/components/video-model-contracts-card.tsx", import.meta.url), "utf8");
const settingsPageSource = await readFile(new URL("../src/app/settings/page.tsx", import.meta.url), "utf8");
const settingsStoreSource = await readFile(new URL("../src/app/settings/store.ts", import.meta.url), "utf8");
const settingsConfigSource = await readFile(new URL("../src/app/settings/components/config-card.tsx", import.meta.url), "utf8");
const profileSource = await readFile(new URL("../src/app/profile/page.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const canvasAssetPickerSource = await readFile(new URL("../src/app/canvas/canvas-asset-picker.tsx", import.meta.url), "utf8");
const promptSourceContentDialogSource = await readFile(new URL("../src/app/settings/components/prompt-source-content-dialog.tsx", import.meta.url), "utf8");
const assetDisplaySource = await readFile(new URL("../src/app/assets/asset-display.tsx", import.meta.url), "utf8");
const workflowEditorSource = workflowSource.slice(
  workflowSource.indexOf("function WorkflowEditor"),
  workflowSource.indexOf("function VariableEditor"),
);
const workflowRunnerSource = workflowSource.slice(
  workflowSource.indexOf("function WorkflowRunner"),
  workflowSource.indexOf("function SeriesDraftCard"),
);
const workflowTaskDialogSource = workflowSource.slice(
  workflowSource.indexOf("function WorkflowTaskDialog"),
  workflowSource.indexOf("function WorkflowEditor"),
);

test("custom scroll areas keep native wheel momentum inside the canvas", () => {
  assert.match(scrollAreaSource, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(scrollAreaSource, /root\.closest\("\[data-canvas-export-root\]"\)/);
  assert.doesNotMatch(scrollAreaSource, /wrap\.scrollTop \+ deltaY/);
  assert.doesNotMatch(scrollAreaSource, /event\.preventDefault\(\);\s*wrap\.scrollTop/);
});

test("custom scrollbar dragging follows native scroll state once per frame", () => {
  assert.match(scrollAreaSource, /scrollFrameRef/);
  assert.match(scrollAreaSource, /requestAnimationFrame\(\(\) => \{\s*scrollFrameRef\.current = null;\s*setScroll/);
  assert.match(scrollAreaSource, /wrap\.scrollTo\(\{ top: position\.scrollTop, left: position\.scrollLeft, behavior: "auto" \}\)/);
  assert.match(scrollAreaSource, /transform: `translate3d/);
  assert.match(scrollAreaSource, /touch-none select-none transition-opacity duration-150/);
});

test("scrollbar tracks page like a native scrollbar and fade after input", () => {
  assert.match(scrollAreaSource, /metrics\.viewportHeight \* 0\.9/);
  assert.match(scrollAreaSource, /metrics\.viewportWidth \* 0\.9/);
  assert.match(scrollAreaSource, /scheduleScrollbarHide/);
  assert.match(scrollAreaSource, /}, 700\)/);
  assert.match(scrollAreaSource, /SCROLL_OVERFLOW_TOLERANCE_PX = 1/);
  assert.match(scrollAreaSource, /measuredSize - viewportSize <= SCROLL_OVERFLOW_TOLERANCE_PX \? viewportSize : measuredSize/);
});

test("an open select closes when its trigger is pressed again", () => {
  assert.match(selectSource, /SelectOpenContext/);
  assert.match(selectSource, /if \(!event\.defaultPrevented && select\?\.open\)/);
  assert.match(selectSource, /event\.preventDefault\(\);\s*select\.setOpen\(false\)/);
  assert.match(selectSource, /transition-transform duration-200 ease-in-out/);
  assert.match(selectSource, /select\?\.open && "rotate-180"/);
});

test("controlled selects remain controlled while asynchronous values are empty", () => {
  assert.match(selectSource, /Object\.prototype\.hasOwnProperty\.call\(allProps, "value"\)/);
  assert.match(selectSource, /hasControlledValue \? \{ value: value \?\? "" \} : \{\}/);
});

test("global selects keep the neutral selected treatment shown across settings", () => {
  assert.match(selectSource, /data-\[state=checked\]:bg-accent/);
  assert.match(selectSource, /data-\[state=checked\]:font-medium/);
  assert.match(selectSource, /data-\[state=checked\]:text-accent-foreground/);
  assert.match(selectSource, /viewportClassName="w-full overscroll-contain px-1 py-2"/);
  assert.match(selectSource, /relative my-1 flex w-full/);
  assert.match(selectSource, /first:mt-0 last:mb-0/);
  assert.doesNotMatch(selectSource, /data-\[state=checked\]:bg-\[#eef4ff\]/);
});

test("global tag input supports keyboard, paste, validation, and accessible removal", () => {
  assert.match(inputTagSource, /React\.forwardRef<HTMLInputElement, InputTagProps>/);
  assert.match(inputTagSource, /data-slot="input-tag"/);
  assert.match(inputTagSource, /data-slot="input-tag-item"/);
  assert.match(inputTagSource, /event\.key === "Enter"[\s\S]*event\.key === "，"/);
  assert.match(inputTagSource, /event\.key === "Backspace"[\s\S]*removeTag\(value\.length - 1\)/);
  assert.match(inputTagSource, /composingRef\.current/);
  assert.match(inputTagSource, /event\.clipboardData\.getData\("text"\)/);
  assert.match(inputTagSource, /value\.length === 0 \? "min-w-32" : "min-w-10"/);
  assert.match(inputTagSource, /parentElement\?\.contains\(event\.relatedTarget as Node \| null\)/);
  assert.match(inputTagSource, /onTagRejected\?\.\(tag, "duplicate"\)/);
  assert.match(inputTagSource, /onTagRejected\?\.\(tag, "limit"\)/);
  assert.match(inputTagSource, /aria-label=\{`删除标签 \$\{tag\}`\}/);
});

test("multi select fills available width before collapsing selected tags", () => {
  assert.match(multiSelectSource, /visibleTagCount/);
  assert.match(multiSelectSource, /availableWidth = viewport\.clientWidth/);
  assert.match(multiSelectSource, /candidateWidth \+ gap \+ collapseWidth > availableWidth/);
  assert.match(multiSelectSource, /new ResizeObserver\(measureVisibleTags\)/);
  assert.doesNotMatch(multiSelectSource, /selected\.slice\(0, 1\)/);
});

test("dialog close buttons stay fixed while the body scrollbar updates", () => {
  assert.match(dialogSource, /data-slot="dialog-auto-close"/);
  assert.match(dialogSource, /absolute top-4 right-4 z-30/);
  assert.doesNotMatch(dialogSource, /data-scroll-overflow-y=true[^\n]*dialog-auto-close/);
  assert.match(dialogSource, /transition-\[background-color,opacity\]/);
  assert.doesNotMatch(dialogSource, /transition-\[right,background-color,opacity\]/);
  assert.match(scrollAreaSource, /data-scroll-overflow-y=\{verticalOverflow > 0 \|\| undefined\}/);
  assert.match(dialogSource, /min-w-0 shrink-0 flex flex-col gap-2 pr-20 text-left/);
  assert.match(dialogSource, /min-w-0 break-words text-xl leading-tight/);
  assert.match(scrollAreaSource, /const effectiveAlways = always/);
});

test("dialog scrolling is limited to the body between its fixed header and footer", () => {
  assert.match(dialogSource, /flattenDialogChildren\(children\)/);
  assert.match(dialogSource, /dialogChildren\.filter\(isDialogHeaderElement\)/);
  assert.match(dialogSource, /dialogChildren\.filter\(isDialogFooterElement\)/);
  assert.match(dialogSource, /data-slot="dialog-body"/);
  assert.match(dialogSource, /\{headers\}[\s\S]*?<ScrollArea[\s\S]*?\{body\}[\s\S]*?\{footers\}/);
  assert.doesNotMatch(scrollAreaSource, /closest\('\[data-slot="dialog-content"\]'\)/);
  assert.match(scrollAreaSource, /showScrollbar\(\);\s*scheduleScrollbarHide\(\)/);
});

test("dialog footers share compact inset and full-width fixed styles", () => {
  assert.match(dialogSource, /p-\[var\(--dialog-padding\)\] \[--dialog-padding:1\.25rem\]/);
  assert.match(dialogSource, /sm:\[--dialog-padding:1\.5rem\]/);
  assert.doesNotMatch(dialogSource, /sm:p-6/);
  assert.match(dialogSource, /flush = false/);
  assert.match(dialogSource, /data-flush=\{flush \|\| undefined\}/);
  assert.match(dialogSource, /z-10 flex shrink-0/);
  assert.doesNotMatch(dialogSource, /sticky bottom-0 z-10 flex shrink-0/);
  assert.match(dialogSource, /\[&>\[data-slot=button\]\]:min-w-18/);
  assert.ok(dialogSource.includes("[&:has([data-slot=dialog-footer]:not([data-flush=true]))]:pb-3"));
  assert.match(dialogSource, /min-h-15 border-t border-border bg-card px-5 py-3 sm:px-6/);
  assert.doesNotMatch(dialogSource, /mt-1 pt-1/);
});

test("video contract editor shows configuration and parameter preview side by side", () => {
  assert.match(videoContractsSource, /h-\[min\(90dvh,860px\)\] w-\[min\(96vw,1280px\)\] max-w-none/);
  assert.match(videoContractsSource, /<DialogContent[\s\S]*?scrollable=\{false\}/);
  assert.match(videoContractsSource, /data-video-contract-layout className="[^"]*grid-rows-\[minmax\(0,1fr\)_minmax\(0,1fr\)\][^"]*overflow-hidden/);
  assert.match(videoContractsSource, /<ScrollArea[\s\S]*?data-video-contract-details[\s\S]*?className="h-full min-h-0 min-w-0"[\s\S]*?viewportClassName="h-full overscroll-y-contain pr-3"[\s\S]*?ariaLabel="契约表单"/);
  assert.match(videoContractsSource, /<ScrollArea[\s\S]*?data-video-contract-preview[\s\S]*?className="h-full min-h-0 min-w-0[^"]*"[\s\S]*?viewportClassName="h-full overscroll-y-contain pr-3 lg:pl-5"[\s\S]*?ariaLabel="契约预览"/);
  assert.doesNotMatch(videoContractsSource, /scrollContractViewport|detailsScrollViewportRef|previewScrollViewportRef/);
  assert.match(videoContractsSource, /function normalizeTags\(value: string\[\] \| string \| null \| undefined\)/);
  assert.match(videoContractsSource, /String\(value \|\| ""\)\.split/);
  assert.match(videoContractsSource, /contentClassName="p-0 sm:p-0"/);
  assert.match(videoContractsSource, /divide-y divide-border\/70/);
  assert.match(videoContractsSource, /data-video-contract-layout/);
  assert.match(videoContractsSource, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(300px,20rem\)\]/);
  assert.match(videoContractsSource, /data-video-contract-details[\s\S]*data-video-contract-preview/);
  assert.doesNotMatch(videoContractsSource, /dialogView|role="tablist"|契约查看方式/);
  assert.match(videoContractsSource, /<ContractParameterPreview key=\{parameterPreviewKey\}/);
  assert.match(videoContractsSource, /<VideoSettingsPanel/);
  assert.match(videoContractsSource, /data-contract-material-preview/);
  assert.match(videoContractsSource, /contract\.capability\.first_frame_image_limit/);
  assert.match(videoContractsSource, /referenceLimits\.image > 0 && visible\("reference_image"\) \? uploadPreview\("参考图"/);
  assert.match(videoContractsSource, /referenceLimits\.video > 0 && visible\("reference_video"\) \? uploadPreview\("参考视频"/);
  assert.match(videoContractsSource, /referenceLimits\.audio > 0 && visible\("reference_audio"\) \? uploadPreview\("参考音频"/);
  assert.match(videoContractsSource, /<ContractReferenceMaterialPreview contract=\{contract\} ruleValues=\{ruleValues\} \/>[\s\S]*?<VideoSettingsPanel/);
  assert.match(videoContractsSource, /label="命中后显示"/);
  assert.match(videoContractsSource, /label="命中后隐藏"/);
  assert.match(videoContractsSource, /label="命中后禁用"/);
  assert.match(videoContractsSource, /activeVideoModelContracts\(\)\.filter\(\(item\) => !item\.models\.includes\(CONTRACT_PREVIEW_MODEL\)\)/);
  assert.match(videoContractsSource, /import \{ InputTag \} from "@\/components\/ui\/input-tag"/);
  for (const id of ["models", "sizes", "seconds", "resolutions", "queued-statuses", "processing-statuses", "success-statuses", "failure-statuses", "progress-fields", "result-fields"]) {
    assert.match(videoContractsSource, new RegExp(`<TagListField id="video-contract-${id}"`));
    assert.doesNotMatch(videoContractsSource, new RegExp(`<TextField id="video-contract-${id}"`));
  }
  assert.match(videoContractsSource, /models: \[\.\.\.value\.models\]/);
  assert.match(videoContractsSource, /Array\.isArray\(value\) \? value : String\(value \|\| ""\)\.split/);
  assert.match(videoContractsSource, /value=\{normalizeTags\(value\)\}/);
  assert.match(videoContractsSource, /<Field className="self-start">[\s\S]*?<InputTag[\s\S]*?className="min-h-11"/);
  assert.match(videoContractsSource, /grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3/);
  assert.match(videoContractsSource, /contract\.capability\.seconds = normalizeTags\(draft\.seconds\)/);
  assert.match(videoContractsSource, /<details[^>]*>[\s\S]*原始 JSON[\s\S]*复制 JSON/);
  assert.match(videoContractsSource, /JSON\.stringify\(normalizedContract, null, 2\)/);
  assert.match(videoContractsSource, /navigator\.clipboard\.writeText\(contractJSON\)/);
  assert.doesNotMatch(videoContractsSource, /contractDialogTitleRef|onOpenAutoFocus/);
});

test("video contract help icons explain only technical fields", () => {
  assert.match(videoContractsSource, /function ContractHelpIcon/);
  assert.match(videoContractsSource, /<TooltipHint content=\{help\}>/);
  assert.match(videoContractsSource, /<CircleHelp className="size-3\.5" \/>/);
  assert.doesNotMatch(videoContractsSource, /label="能力配置"/);
  assert.match(videoContractsSource, /label="模型匹配规则" help=/);
  assert.match(videoContractsSource, /label="接口协议" help=/);
  assert.doesNotMatch(videoContractsSource, /Google Gemini Veo 视频协议/);
  assert.doesNotMatch(videoContractsSource, /VIDEO_CONTRACT_DRIVERS\.find\(\(driver\) => driver\.value === draft\.contract\.driver\)\?\.description/);
  for (const driver of ["openai-videos", "xai-videos", "gemini-veo", "vertex-veo", "dashscope-video", "volcengine-video", "kling-video", "minimax-video", "vidu-video", "kie-video", "apimart-video", "custom-video"]) {
    assert.match(videoContractsSource, new RegExp(`value: "${driver}"`));
  }
  for (const adapter of ["OpenAI Videos / Sora", "Kling Video", "MiniMax / Hailuo", "Gemini Veo", "Vertex AI Veo", "Vidu Video", "Seedance / 即梦", "DashScope / 通义万相", "KIE Video", "APIMart Video"]) {
    assert.match(videoContractsSource, new RegExp(adapter));
  }
  assert.match(videoContractsSource, /label="平台本地素材" help=/);
  assert.match(videoContractsSource, /label="multipart 文件字段" help=/);
  assert.match(videoContractsSource, /label="允许重复文件字段" help=/);
  assert.match(videoContractsSource, /label="允许文件与 URL 混用" help=/);
  assert.match(videoContractsSource, /label="默认模式" help=/);
  assert.match(videoContractsSource, /label="模式类型" help=/);
  assert.match(videoContractsSource, /label="允许仅使用参考音频" help=/);
  assert.match(videoContractsSource, /label="至少提供一项"/);
  assert.match(videoContractsSource, /help=\{REQUEST_FIELD_HELP\[key\]\}/);
  for (const label of ["轮询间隔", "超时时间", "任务 ID 路径", "任务状态路径", "任务进度路径", "排队状态", "处理中状态", "成功状态", "失败状态", "未知状态", "错误信息路径", "结果地址路径"]) {
    assert.match(videoContractsSource, new RegExp(`label="${label}" help=`));
  }
  for (const id of ["sizes", "seconds", "resolutions", "default-size", "default-seconds", "default-resolution", "prompt-limit"]) {
    assert.match(videoContractsSource, new RegExp(`id="video-contract-${id}" label="[^"]+" (?!help=)`));
  }
});

test("video contracts support reviewed JSON import and ID-free export", () => {
  assert.match(videoContractsSource, /accept="\.json,application\/json"/);
  assert.match(videoContractsSource, />\s*导入 JSON\s*</);
  assert.match(videoContractsSource, /downloadVideoContractDocument\(videoContractTransferDocument\(items\)/);
  assert.match(videoContractsSource, /downloadVideoContractDocument\(videoContractTransferDocument\(\[item\]\)/);
  assert.match(videoContractsSource, /<DialogTitle>导入视频模型契约<\/DialogTitle>/);
  assert.match(videoContractsSource, /pendingImportSummary\.created/);
  assert.match(videoContractsSource, /pendingImportSummary\.updated/);
  assert.match(videoContractsSource, /同名契约将更新/);
  assert.doesNotMatch(videoContractsSource, /videoContractTransferDocument[\s\S]*created_at/);
});

test("video contract loads reject obsolete sessions and version-history requests", () => {
  assert.match(settingsPageSource, /<VideoModelContractsCard key=\{session\.key\} sessionKey=\{session\.key\} \/>/);
  assert.match(videoContractsSource, /fetchAdminVideoModelContracts\(\{ signal: controller\.signal \}\)/);
  assert.match(videoContractsSource, /contractLoadVersionRef\.current !== requestVersion/);
  assert.match(videoContractsSource, /fetchVideoModelContractVersions\(item\.id, \{ signal: controller\.signal \}\)/);
  assert.match(videoContractsSource, /versionsLoadVersionRef\.current !== requestVersion/);
  assert.match(videoContractsSource, /const closeVersions = \(\) => \{[\s\S]*versionsLoadVersionRef\.current \+= 1;[\s\S]*versionsLoadControllerRef\.current\?\.abort\(\)/);
  assert.match(apiSource, /fetchAdminVideoModelContracts\(options: \{ signal\?: AbortSignal \} = \{\}\)/);
  assert.match(apiSource, /fetchVideoModelContractVersions\(id: string, options: \{ signal\?: AbortSignal \} = \{\}\)/);
});

test("settings saves do not overwrite edits made while the request is pending", () => {
  assert.match(settingsStoreSource, /config: state\.config === config \? normalizeConfig\(data\.config\) : state\.config/);
});

test("video contracts use a responsive management list with prioritized actions", () => {
  assert.match(videoContractsSource, /data-video-contract-toolbar/);
  assert.match(videoContractsSource, /variant="ghost" disabled=\{isJSONImporting\}/);
  assert.match(videoContractsSource, /variant="ghost" disabled=\{items\.length === 0\}/);
  assert.match(videoContractsSource, /variant="outline" onClick=\{openImport\}/);
  assert.match(videoContractsSource, /size="sm" onClick=\{openCreate\}/);
  assert.match(videoContractsSource, /data-video-contract-list/);
  assert.match(videoContractsSource, /契约<\/span>[\s\S]*匹配模型<\/span>[\s\S]*能力范围<\/span>[\s\S]*更新时间<\/span>[\s\S]*操作<\/span>/);
  assert.match(videoContractsSource, /data-video-contract-row/);
  assert.match(videoContractsSource, /xl:grid-cols-\[minmax\(220px,1\.2fr\)_minmax\(180px,0\.95fr\)_minmax\(280px,1\.35fr\)_150px_210px\]/);
  assert.match(videoContractsSource, /保存草稿/);
  assert.match(videoContractsSource, /发布新版本/);
  assert.match(videoContractsSource, /请求与响应模拟/);
  assert.match(videoContractsSource, /版本历史/);
  assert.match(videoContractsSource, /<Switch[\s\S]*?onCheckedChange=\{\(\) => void toggleEnabled\(item\)\}/);
  assert.match(videoContractsSource, /item\.contract\.models\.slice\(0, 2\)/);
  assert.match(videoContractsSource, /formatDurationRange\(item\.contract\.capability\.seconds\)/);
  assert.match(videoContractsSource, /<time dateTime=\{item\.updated_at\}/);
});

test("large dialog pagination and actions use the shared footer layouts", () => {
  assert.match(canvasAssetPickerSource, /<DialogFooter flush className="flex-row justify-center/);
  assert.match(promptSourceContentDialogSource, /<DialogFooter flush className="flex-row justify-center/);
  assert.match(assetDisplaySource, /<DialogFooter>/);
  assert.doesNotMatch(assetDisplaySource, /flex justify-end gap-2 border-t border-border pt-4/);
});

test("prompt source content rejects stale source and closed-dialog responses", () => {
  assert.match(promptSourceContentDialogSource, /loadGenerationRef\.current !== loadGeneration/);
  assert.match(promptSourceContentDialogSource, /currentSourceIDRef\.current !== sourceID/);
  assert.match(promptSourceContentDialogSource, /!openRef\.current/);
});

test("workflow runner keeps its header and actions outside the scrolling form", () => {
  assert.match(workflowRunnerSource, /<DialogContent scrollable=\{false\} className="h-\[min\(92dvh,900px\)\]/);
  assert.match(workflowRunnerSource, /<DialogHeader className="border-b border-border/);
  assert.match(workflowRunnerSource, /<ScrollArea className="min-h-0 flex-1" viewportClassName="overscroll-contain p-5 sm:p-6"/);
  assert.match(workflowRunnerSource, /<DialogFooter flush className="flex-row">/);
  assert.match(workflowRunnerSource, /<Button variant="outline" onClick=\{onClose\}>取消<\/Button>/);
});

test("workflow runner prioritizes inputs and prompt preview over read-only settings", () => {
  assert.match(workflowRunnerSource, />填写生成内容</);
  assert.match(workflowRunnerSource, /必填 \{completedRequiredVariables\}\/\{requiredVariables\.length\}/);
  assert.match(workflowRunnerSource, />生成提示词预览</);
  assert.match(workflowRunnerSource, /aria-expanded=\{settingsOpen\}/);
  assert.match(workflowRunnerSource, /showHeading=\{false\}/);
  assert.match(workflowRunnerSource, /lg:grid-cols-\[minmax\(0,1\.15fr\)_minmax\(340px,0\.85fr\)\]/);
});

test("multi-image workflow runner exposes a full-width guided review workspace", () => {
  assert.match(workflowRunnerSource, /data-workflow-series-workspace/);
  assert.match(workflowRunnerSource, /lg:col-span-2/);
  assert.match(workflowRunnerSource, /data-workflow-series-steps/);
  assert.match(workflowRunnerSource, /\["填写内容", "生成提示词", "审核提示词", "生成图片"\]/);
  assert.match(workflowRunnerSource, /seriesNextStep/);
  assert.match(workflowRunnerSource, /viewClass="grid gap-3 2xl:grid-cols-2"/);
  assert.match(workflowSource, /data-series-draft-card/);
  assert.match(workflowSource, /const resultURL = draft\.result_ids\?\.\[0\] \|\| ""/);
  assert.match(workflowSource, /<AuthenticatedImage src=\{resultURL\}/);
  assert.match(workflowSource, /<PromptTextareaFrame className="h-32 min-h-32">/);
  assert.doesNotMatch(workflowSource, /<ImageLightbox[\s\S]*?src: resultURL/);
  assert.match(workflowSource, />正在生成图片</);
  assert.match(workflowSource, />生成结果</);
  assert.match(workflowSource, /生成此图/);
});

test("workflow completion merges last-run metadata without replacing current content", () => {
  assert.match(workflowSource, /touchWorkflowLastRun\(workflow\.id, timestamp\)/);
  assert.match(workflowSource, /mergeWorkflowRunMetadata\(item, touched\)/);
  assert.match(workflowSource, /mergeWorkflowRunMetadata\(current, touched\)/);
  assert.doesNotMatch(workflowSource, /saveWorkflow\((?:completed|updated)\)/);
});

test("workflow editor keeps its header and footer outside the scrolling form", () => {
  assert.match(workflowEditorSource, /<DialogContent scrollable=\{false\} className="h-\[min\(92dvh,920px\)\]/);
  assert.match(workflowSource, /<ScrollArea className="min-h-0 flex-1" viewportClassName="overscroll-contain p-5 sm:p-6"/);
  assert.match(workflowEditorSource, /<DialogFooter flush className="flex-row">/);
});

test("workflow editor keeps multi-image planning in the main flow and a stable settings rail", () => {
  assert.match(workflowEditorSource, />基本信息</);
  assert.match(workflowEditorSource, />输入变量</);
  assert.match(workflowEditorSource, />提示词模板</);
  assert.match(workflowEditorSource, />多图提示词规划</);
  assert.match(workflowEditorSource, /viewClass="space-y-6"/);
  assert.match(workflowEditorSource, /lg:grid-cols-\[minmax\(0,1fr\)_340px\]/);
  assert.match(workflowEditorSource, /bg-card shadow-sm lg:sticky lg:top-0/);
  assert.ok(workflowEditorSource.indexOf("多图提示词规划") < workflowEditorSource.indexOf("<aside className"));
  assert.match(workflowEditorSource, /<Field label="工作流名称">/);
  assert.match(workflowEditorSource, /<Field label="用户提示词模板">/);
  assert.match(workflowSource, /function VariableEditor\(\{ index,/);
  assert.match(workflowSource, />变量 \{index \+ 1\}</);
  assert.match(workflowSource, /sm:grid-cols-2 xl:grid-cols-3/);
});

test("workflow editor reuses the image workbench settings component", () => {
  assert.match(workflowSource, /import \{\s*ImageSettingsPanel,/);
  assert.match(workflowEditorSource, /<WorkflowImageSettings/);
  assert.match(workflowEditorSource, /workflowImageSettings\(workflow\.config\)/);
  assert.match(workflowEditorSource, /patchConfig\(\{ model, image_model: model \}\)/);
  assert.match(workflowSource, /<ImageSettingsPanel/);
  assert.doesNotMatch(workflowSource, /function GlobalGenerationSummary/);
});

test("workflow runner shows the saved template settings as read only", () => {
  assert.match(workflowRunnerSource, /workflowImageSettings\(workflow\.config\)/);
  assert.match(workflowRunnerSource, /<WorkflowImageSettings[\s\S]*?readOnly/);
  assert.doesNotMatch(workflowRunnerSource, /onImageSettingsChange|onImageModelChange/);
  assert.match(workflowSource, /<ImageSettingsPanel disabled=\{readOnly\}/);
  assert.match(imageSettingsPanelSource, /disabled\s*\? "cursor-not-allowed border-border\/60 bg-muted\/50 dark:bg-muted\/40"/);
  assert.match(imageSettingsPanelSource, /disabled:bg-transparent disabled:opacity-100/);
});

test("workflow tasks expose a complete details dialog", () => {
  assert.match(workflowSource, /function WorkflowTaskDialog/);
  assert.match(workflowTaskDialogSource, /const activeImagePrompt = activeImage\?\.prompt \|\| task\.prompt/);
  assert.match(workflowTaskDialogSource, />当前图片提示词</);
  assert.match(workflowTaskDialogSource, /navigator\.clipboard\.writeText\(activeImagePrompt\)/);
  assert.match(workflowTaskDialogSource, /<AuthenticatedImage src=\{activeImage\.url\}/);
  assert.match(workflowSource, />输入变量</);
  assert.match(workflowSource, />创作参数快照</);
  assert.match(workflowSource, />执行信息</);
  assert.doesNotMatch(workflowTaskDialogSource, />生成结果</);
  assert.match(workflowTaskDialogSource, /<DialogFooter flush className="flex-row justify-end sm:justify-end">[\s\S]*?>关闭<[\s\S]*?<Download \/>下载当前图片/);
});

test("workflow task history stays out of the template page and opens on demand", () => {
  assert.match(workflowSource, /function WorkflowTaskHistoryDialog/);
  assert.match(workflowSource, /role="tablist" aria-label="任务状态"/);
  assert.match(workflowSource, /<WorkflowTaskHistoryDialog[\s\S]*?onOpenTask=/);
  assert.doesNotMatch(workflowSource, /<section aria-labelledby="workflow-task-title"/);
});

test("multi-image workflow history uses one durable batch and persistent clearing", () => {
  assert.match(workflowSource, /const seriesRun: WorkflowSeriesRun = \{[\s\S]*?id: taskID\("workflow-series-images"\)/);
  assert.match(workflowSource, /batch_task_id: localTaskID,[\s\S]*?batch_index: batchIndex,[\s\S]*?batch_count: batchCount/);
  assert.match(workflowSource, /await deleteCreationTasks\(backendTaskIDs\)/);
  assert.match(workflowSource, />一并删除关联素材</);
  assert.match(workflowSource, /onClearCompleted: \(includeAssets: boolean\) => Promise<boolean>/);
  assert.match(workflowSource, /getManagedImagePathFromUrl\(image\.url\)/);
  assert.match(workflowSource, /await deleteManagedImages\(assetPaths\)/);
  assert.match(workflowSource, /clearAssets \? "清理记录和素材" : "仅清理记录"/);
  assert.doesNotMatch(workflowSource, /onClearCompleted=\{\(\) => setTasks/);
});

test("single-image workflow closes its runner after task submission starts", () => {
  assert.match(workflowSource, /const workflow = running;\s*const prompt = renderedPrompt;\s*closeRunner\(\);\s*try \{\s*await executeImageTask\(workflow, prompt\)/);
});

test("workflow tasks stay isolated from creation workbench history and queue", () => {
  assert.doesNotMatch(workflowPageSource, /saveImageConversation|workflow-image-history/);
  assert.match(imageTaskQueueSource, /isWorkflowImageConversation/);
  assert.match(imageTaskQueueSource, /deleteImageConversation/);
});

test("the global task queue uses a compact flat list", () => {
  assert.match(imageTaskQueueSource, />任务队列</);
  assert.match(imageTaskQueueSource, /w-\[min\(calc\(100vw-2rem\),420px\)\] overflow-hidden rounded-lg p-0/);
  assert.doesNotMatch(imageTaskQueueSource, />打开创作台</);
  assert.doesNotMatch(imageTaskQueueSource, /pointer-events-none absolute -inset-1/);
});

test("interactive controls share a visible global disabled state", () => {
  assert.match(globalStylesSource, /\[aria-disabled="true"\]/);
  assert.match(globalStylesSource, /\[data-disabled\]:not\(\[data-disabled="false"\]\)/);
  assert.match(globalStylesSource, /cursor: not-allowed/);
  assert.doesNotMatch(globalStylesSource, /\[data-disabled\][\s\S]{0,180}pointer-events: none/);
  assert.match(globalStylesSource, /:where\(input, textarea, select\):disabled/);
  assert.match(globalStylesSource, /background-color: color-mix\(in srgb, var\(--muted\)/);
  assert.match(globalStylesSource, /fieldset:disabled/);
  assert.match(videoContractsSource, /data-disabled=\{disabled \|\| undefined\}/);
  assert.match(videoContractsSource, /disabled && "border-border\/60 bg-muted\/50 text-muted-foreground"/);
  assert.match(videoContractsSource, /<ContractCheckboxField id="video-contract-watermark"/);
});

test("shared generation parameter buttons expose their disabled state", () => {
  assert.match(aspectRatioOptionSource, /export function AspectRatioOptionButton/);
  assert.match(imageParameterStylesSource, /disabled:cursor-not-allowed/);
  assert.match(imageParameterStylesSource, /disabled:opacity-50/);
  assert.match(aspectRatioOptionSource, /disabled:cursor-not-allowed/);
  assert.match(aspectRatioOptionSource, /disabled:opacity-50/);
});

test("image and video generation share one aspect ratio option", () => {
  assert.match(imageSettingsPanelSource, /<ImageSizePresetControls/);
  assert.match(imageSizePresetControlsSource, /<AspectRatioOptionButton/);
  assert.match(videoSettingsPanelSource, /<AspectRatioOptionButton/);
  assert.match(aspectRatioOptionSource, /return "自动"/);
  assert.match(aspectRatioOptionSource, /"自动匹配"/);
  assert.match(videoSettingsPanelSource, /画幅比例/);
});

test("video composer places reference materials before settings and uses video task copy", () => {
  assert.doesNotMatch(imageComposerSource, /activeVideoSupportsFrames \? <section className="order-40/);
  assert.doesNotMatch(imageComposerSource, /activeVideoMaterialSections\.image \? <section className="order-50/);
  assert.match(imageComposerSource, /activeVideoSupportsFrames[\s\S]*activeVideoMaterialSections\.image[\s\S]*<VideoSettingsPanel/);
  assert.match(imagePageSource, /message: "正在生成视频"/);
  assert.match(imagePageSource, /activeTurn\.mode === "video" \? "生成视频失败" : "生成图片失败"/);
});

test("image ratio cards combine shape and resolution while video shows a size badge", () => {
  assert.match(imageSizePresetControlsSource, />宽高比<\/ImageParameterLabel>/);
  assert.match(imageSizePresetControlsSource, /IMAGE_ASPECT_RATIO_PRESET_OPTIONS\.map/);
  assert.match(imageSizePresetControlsSource, /layout="visual"/);
  assert.match(imageSizePresetControlsSource, /label=\{automatic \? "自动" : option\.label\}/);
  assert.match(videoSettingsPanelSource, />画幅比例<\/ImageParameterLabel>/);
  assert.match(videoSettingsPanelSource, /<GenerationSizeBadge>\{videoSizePreview\}<\/GenerationSizeBadge>/);
  assert.match(videoSettingsPanelSource, /description=\{ratio === "adaptive" \? "自动匹配" : ratio\}/);
  assert.doesNotMatch(videoSettingsPanelSource, /description=\{videoComposerSizeDescription/);
  assert.doesNotMatch(videoSettingsPanelSource, /`\$\{ratio\} · \$\{size\}`/);
});

test("manual video duration keeps an editing buffer until commit", () => {
  assert.match(videoSettingsPanelSource, /function VideoDurationInput/);
  assert.match(videoSettingsPanelSource, /const \[draft, setDraft\] = useState\(value\)/);
  assert.match(videoSettingsPanelSource, /onChange=\{\(event\) => setDraft\(event\.target\.value\.replace\(\/\\D\/g, ""\)\)\}/);
  assert.match(videoSettingsPanelSource, /onBlur=\{\(\) => \{ commit\(\); setEditing\(false\); \}\}/);
  assert.doesNotMatch(videoSettingsPanelSource, /onChange=\{\(event\) => onChange\(\{ seconds: event\.target\.value \}\)\}/);
});

test("log governance exposes a persisted daily cleanup schedule", () => {
  assert.match(logGovernanceSource, /定时清理/);
  assert.match(logGovernanceSource, /settings-log-cleanup-hour/);
  assert.match(logGovernanceSource, /服务器本地时间/);
  assert.match(settingsStoreSource, /setLogCleanupScheduleEnabled/);
  assert.match(settingsStoreSource, /setLogCleanupHour/);
  assert.match(apiSource, /log_cleanup_schedule_enabled/);
  assert.match(apiSource, /log_cleanup_hour/);
});

test("key preferences expose scoped custom API configuration without revealing saved keys", () => {
  assert.match(profileSource, /<DialogTitle>\{title\}自定义 API 配置<\/DialogTitle>/);
  assert.match(profileSource, /已配置，留空保持原 Key/);
  assert.match(profileSource, /createCustomRelayConfig/);
  assert.match(profileSource, /updateCustomRelayConfig/);
  assert.match(profileSource, /deleteCustomRelayConfig/);
  assert.match(profileSource, /selectedTokenNames=\{selectedTokenNames\[kind\]\}/);
  assert.match(profileSource, /<MultiSelect/);
  assert.match(profileSource, /collapseTags/);
  assert.match(profileSource, /collapseTagsTooltip/);
  assert.match(profileSource, /aria-label="查看 Key 匹配顺序说明"/);
  assert.match(profileSource, /<TooltipHint content="按选择顺序匹配模型，前面的 Key 优先。">/);
  assert.match(settingsConfigSource, /允许自定义 API 配置/);
  assert.match(settingsStoreSource, /allow_user_custom_relay_config/);
  assert.match(apiSource, /\/api\/profile\/custom-relay-configs/);
});

test("multi-select owns one viewport and only scrolls when options exceed available space", () => {
  assert.match(multiSelectSource, /<PopoverContent scrollable=\{false\}/);
  assert.match(multiSelectSource, /maxHeight="min\(20rem, calc\(var\(--radix-popover-content-available-height\) - 0\.75rem\)\)"/);
  assert.doesNotMatch(multiSelectSource, /className="max-h-64"/);
});

test("creation preferences pull each model kind with its selected key", () => {
  assert.match(profileSource, /fetchRelayModels\(\{ tokenName, signal: controller\.signal \}\)/);
  assert.match(profileSource, /filterModelsByCapability/);
  assert.match(profileSource, /modelConfig\[kind\]\.models\.filter/);
  assert.match(profileSource, /按当前 Key 拉取\$\{label\}/);
  assert.match(profileSource, /Promise\.all\(tokenNames\.map\(\(tokenName\) => fetchRelayModels\(\{ tokenName, signal: controller\.signal \}\)\)\)/);
  assert.match(profileSource, /modelPullVersionRef\.current !== requestVersion/);
  assert.match(profileSource, /currentSessionKeyRef\.current !== requestSessionKey/);
  assert.match(profileSource, /JSON\.stringify\(currentRelayTokenNamesRef\.current\[kind\]\) !== tokenSelectionKey/);
  assert.match(profileSource, /tokenNameForModel\("audio", selectedAudioModel\)/);
  assert.match(profileSource, /\.\.\.relayTokenPreferencesFromNames\(relayTokenNames\)/);
});

test("settings model discovery rejects responses from an obsolete key, kind, or session", async () => {
  const modelConfigSource = await readFile(new URL("../src/app/settings/components/model-config-card.tsx", import.meta.url), "utf8");
  assert.match(modelConfigSource, /fetchRelayModels\(\{ tokenName: requestTokenName, signal: controller\.signal \}\)/);
  assert.match(modelConfigSource, /modelLoadVersionRef\.current !== requestVersion/);
  assert.match(modelConfigSource, /currentSessionKeyRef\.current !== requestSessionKey/);
  assert.match(modelConfigSource, /function selectTokenName[\s\S]*?invalidateModelLoad\(\)/);
  assert.match(modelConfigSource, /function selectModelKind[\s\S]*?invalidateModelLoad\(\)/);
});

test("task queue keeps video copy and the last successful snapshot", () => {
  assert.match(imageTaskQueueSource, /mode === "video"[\s\S]*return "视频生成"/);
  assert.match(imageTaskQueueSource, /item\.turn\.mode === "video" \? "等待视频处理" : "等待图片处理"/);
  assert.match(imageTaskQueueSource, /item\.turn\.mode === "video" \? "个视频" : "张图片"/);
  const loader = imageTaskQueueSource.slice(
    imageTaskQueueSource.indexOf("function useImageConversationsForQueue"),
    imageTaskQueueSource.indexOf("function QueueItem"),
  );
  assert.doesNotMatch(loader, /catch\s*\{[\s\S]*setConversations\(\[\]\)/);
});

test("video progress hover does not resize or shift the progress track", () => {
  assert.match(globalStylesSource, /\.xgplayer-progress\.active \.xgplayer-progress-outer\s*\{[^}]*height:\s*4px[^}]*margin-bottom:\s*0[^}]*transition:\s*none/s);
  assert.doesNotMatch(globalStylesSource, /\.xgplayer-progress:hover\s*\{[^}]*height:/s);
});

test("video playback rate and download controls use the localized player treatment", () => {
  assert.match(globalStylesSource, /\.xgplayer-playbackrate \.btn-text span/);
  assert.match(globalStylesSource, /\.xg-options-list li\.selected\s*\{[^}]*background-color:\s*rgba\(20, 86, 240, 0\.24\)/s);
  assert.match(globalStylesSource, /\.xgplayer-download\s*\{/);
});

test("creation composer toolbar does not show redundant tooltips", () => {
  assert.doesNotMatch(imageComposerSource, /tooltip="图片生成"/);
  assert.doesNotMatch(imageComposerSource, /tooltip="视频生成"/);
  assert.doesNotMatch(imageComposerSource, /tooltip=\{`模型：/);
  assert.doesNotMatch(imageComposerSource, /tooltip="提示词"/);
  assert.doesNotMatch(imageComposerSource, /tooltip=\{isImageSettingsOpen \? "收起参数"/);
  assert.doesNotMatch(imageComposerSource, /tooltip=\{relayApiKeyMissing/);
  assert.match(imageComposerSource, /aria-label=\{`选择模型，当前 \$\{imageModelLabel\}`\}/);
  assert.match(imageComposerSource, /aria-label=\{submitLabel\}/);
});

test("creation conversation cards keep spacing inside the scroll viewport", () => {
  assert.match(imageSidebarSource, /<ScrollArea[\s\S]*?<div className=\{cn\("flex min-h-full flex-col gap-2"/);
  assert.doesNotMatch(imageSidebarSource, /hideActionButtons \? "flex flex-col gap-1 pr-0"/);
});

test("creation composer model picker reuses the global select treatment", () => {
  assert.match(imageComposerSource, /<Select[\s\S]*value=\{activeModel\}/);
  assert.match(imageComposerSource, /<SelectTrigger[\s\S]*选择模型，当前/);
  assert.match(imageComposerSource, /<SelectContent[\s\S]*side="top"/);
  assert.doesNotMatch(imageComposerSource, /data-\[state=checked\]:bg-\[#eef4ff\]/);
  assert.doesNotMatch(imageComposerSource, /<SelectContent[\s\S]{0,160}className=/);
  assert.doesNotMatch(imageComposerSource, /<SelectItem[\s\S]{0,160}className=/);
  assert.doesNotMatch(imageComposerSource, /modelMenuRef/);
  assert.doesNotMatch(imageComposerSource, /rounded-\[20px\][^\n]*activeModelOptions/);
});
