import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scrollAreaSource = await readFile(new URL("../src/components/ui/scroll-area.tsx", import.meta.url), "utf8");
const selectSource = await readFile(new URL("../src/components/ui/select.tsx", import.meta.url), "utf8");
const dialogSource = await readFile(new URL("../src/components/ui/dialog.tsx", import.meta.url), "utf8");
const workflowSource = await readFile(new URL("../src/components/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8");
const workflowPageSource = await readFile(new URL("../src/app/workflows/page.tsx", import.meta.url), "utf8");
const imageTaskQueueSource = await readFile(new URL("../src/components/image-task-queue.tsx", import.meta.url), "utf8");
const globalStylesSource = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
const imageParameterStylesSource = await readFile(new URL("../src/app/image/components/image-parameter-styles.ts", import.meta.url), "utf8");
const imageParameterUISource = await readFile(new URL("../src/app/image/components/image-parameter-ui.tsx", import.meta.url), "utf8");
const imageSettingsPanelSource = await readFile(new URL("../src/components/generation/image-settings-panel.tsx", import.meta.url), "utf8");
const logGovernanceSource = await readFile(new URL("../src/app/settings/components/log-governance-card.tsx", import.meta.url), "utf8");
const settingsStoreSource = await readFile(new URL("../src/app/settings/store.ts", import.meta.url), "utf8");
const settingsConfigSource = await readFile(new URL("../src/app/settings/components/config-card.tsx", import.meta.url), "utf8");
const profileSource = await readFile(new URL("../src/app/profile/page.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
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
});

test("an open select closes when its trigger is pressed again", () => {
  assert.match(selectSource, /SelectOpenContext/);
  assert.match(selectSource, /if \(!event\.defaultPrevented && select\?\.open\)/);
  assert.match(selectSource, /event\.preventDefault\(\);\s*select\.setOpen\(false\)/);
  assert.match(selectSource, /transition-transform duration-200 ease-in-out/);
  assert.match(selectSource, /select\?\.open && "rotate-180"/);
});

test("dialog titles and close buttons stay clear of the scrollbar", () => {
  assert.match(dialogSource, /absolute top-4 right-6 z-30/);
  assert.match(dialogSource, /min-w-0 shrink-0 flex flex-col gap-2 pr-12 text-left/);
  assert.match(dialogSource, /min-w-0 break-words text-xl leading-tight/);
});

test("workflow editor keeps its header and footer outside the scrolling form", () => {
  assert.match(workflowSource, /<DialogContent scrollable=\{false\} className="h-\[min\(92dvh,900px\)\]/);
  assert.match(workflowSource, /<ScrollArea className="min-h-0 flex-1" viewportClassName="overscroll-contain p-5 sm:p-6"/);
  assert.match(workflowSource, /<DialogFooter className="shrink-0 border-t border-border bg-background/);
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
  assert.match(workflowSource, />完整提示词</);
  assert.match(workflowSource, />输入变量</);
  assert.match(workflowSource, />创作参数快照</);
  assert.match(workflowSource, />执行信息</);
  assert.doesNotMatch(workflowTaskDialogSource, />生成结果</);
  assert.match(workflowTaskDialogSource, /<DialogFooter[\s\S]*?<Download \/>下载/);
});

test("workflow task history stays out of the template page and opens on demand", () => {
  assert.match(workflowSource, /function WorkflowTaskHistoryDialog/);
  assert.match(workflowSource, /role="tablist" aria-label="任务状态"/);
  assert.match(workflowSource, /<WorkflowTaskHistoryDialog[\s\S]*?onOpenTask=/);
  assert.doesNotMatch(workflowSource, /<section aria-labelledby="workflow-task-title"/);
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
});

test("shared generation parameter buttons expose their disabled state", () => {
  assert.match(imageParameterStylesSource, /disabled:cursor-not-allowed/);
  assert.match(imageParameterStylesSource, /disabled:opacity-50/);
  assert.match(imageParameterUISource, /disabled:cursor-not-allowed/);
  assert.match(imageParameterUISource, /disabled:opacity-50/);
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
  assert.match(profileSource, /title="自定义 API 配置"/);
  assert.match(profileSource, /已配置，留空保持原 Key/);
  assert.match(profileSource, /保存并使用/);
  assert.match(profileSource, /deleteCustomRelayConfig/);
  assert.match(settingsConfigSource, /允许自定义 API 配置/);
  assert.match(settingsStoreSource, /allow_user_custom_relay_config/);
  assert.match(apiSource, /\/api\/profile\/custom-relay-configs/);
});

test("creation preferences pull each model kind with its selected key", () => {
  assert.match(profileSource, /fetchRelayModels\(\{ tokenName \}\)/);
  assert.match(profileSource, /filterModelsByCapability/);
  assert.match(profileSource, /modelConfig\[kind\]\.models\.filter/);
  assert.match(profileSource, /按当前 Key 拉取\$\{label\}/);
  assert.match(profileSource, /relayTokenNames=\{selectedTokenNames\}/);
});
