import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const imagePageSource = readSource("../src/app/image/page.tsx");
const imageResultsSource = readSource("../src/app/image/components/image-results.tsx");
const mediaVideoPlayerSource = readSource("../src/components/media-video-player.tsx");
const assetDisplaySource = readSource("../src/app/assets/asset-display.tsx");
const settingsPageSource = readSource("../src/app/settings/page.tsx");
const sectionNavigationSource = readSource("../src/components/section-navigation.tsx");
const topNavSource = readSource("../src/components/top-nav.tsx");
const settingsPanelSource = readSource("../src/components/settings-panel.tsx");
const modelConfigSource = readSource("../src/app/settings/components/model-config-card.tsx");
const storageProvidersSource = readSource("../src/app/settings/components/storage-providers-card.tsx");
const profilePageSource = readSource("../src/app/profile/page.tsx");
const profilePreferencesSource = profilePageSource.slice(
  profilePageSource.indexOf("function ImageGenerationPreferencesCard"),
  profilePageSource.indexOf("function AccountOverviewCard"),
);
const permissionEditorSource = readSource("../src/components/permission-editor.tsx");
const logsPageSource = readSource("../src/app/logs/page.tsx");

test("creative workbench separates the conversation sidebar from the centered workspace", () => {
  assert.doesNotMatch(imagePageSource, /max-w-\[1380px\]/);
  assert.match(imagePageSource, /data-studio-workspace/);
  assert.match(imagePageSource, /data-studio-suggestions/);
  assert.match(imageResultsSource, /max-w-4xl/);
});

test("video generation results use a dedicated compact result workspace", () => {
  assert.match(imageResultsSource, /data-video-result-summary/);
  assert.match(imageResultsSource, /data-video-result-card/);
  assert.match(imageResultsSource, /下载已选/);
  assert.match(imageResultsSource, /!isVideoTurn && successfulVisualImages\.length > 0/);
  assert.match(imageResultsSource, /<MediaVideoPlayer/);
  assert.match(imageResultsSource, /generationFrameAspectRatio\(turn\)/);
  assert.match(imageResultsSource, /aspectRatio=\{turnFrameAspectRatio\}/);
  assert.match(imageResultsSource, /aspectRatio: turnFrameAspectRatio/);
  assert.doesNotMatch(imageResultsSource, /<video[\s\S]{0,120}controls/);
  assert.match(mediaVideoPlayerSource, /VideoPlayer, VideoSkin/);
  assert.match(mediaVideoPlayerSource, /data-app-video-player/);
  assert.match(assetDisplaySource, /<MediaVideoPlayer src=\{mediaURL\}/);
  assert.doesNotMatch(assetDisplaySource, /asset\?\.kind === "video" \? <video src=\{mediaURL\} controls/);
});

test("personal and system settings share one categorized workspace", () => {
  for (const source of [settingsPageSource, profilePageSource]) assert.match(source, /<SettingsWorkspace/);
  assert.match(storageProvidersSource, /setting\.providers\.map/);
  assert.match(sectionNavigationSource, /data-section-navigation/);
  assert.match(sectionNavigationSource, /aria-current=\{active \? "page" : undefined\}/);
});

test("application navigation exposes a desktop rail and a mobile menu", () => {
  assert.match(topNavSource, /aria-label="主导航"/);
  assert.match(topNavSource, /aria-label="移动端主导航"/);
  assert.match(topNavSource, /aria-label="打开导航菜单"/);
  assert.match(topNavSource, /canAccessPath\(session, item.href\)/);
});

test("settings section titles and actions stay visible while their content scrolls", () => {
  assert.match(settingsPanelSource, /data-settings-panel-header/);
  assert.match(settingsPanelSource, /data-settings-panel-body/);
  assert.match(settingsPanelSource, /className="[^"]*min-h-0[^"]*min-w-0[^"]*flex-1"/);
  assert.match(settingsPanelSource, /<header data-settings-panel-header/);
  assert.doesNotMatch(settingsPanelSource, /sticky top-0/);
});

test("profile creation keeps pending preferences mounted across category changes", () => {
  assert.match(profilePageSource, /hidden=\{activeSection !== "creation"\}/);
  assert.match(profilePreferencesSource, /data-profile-preferences-card/);
  assert.match(profilePreferencesSource, /<SettingsPanel[\s\S]*action=\{<Button[\s\S]*保存设置/);
  assert.match(settingsPanelSource, /className="[^"]*min-h-0[^"]*flex-1"/);
});

test("external storage uses a compact overview and policy layout", () => {
  assert.match(storageProvidersSource, /data-storage-provider-toolbar/);
  assert.match(storageProvidersSource, /data-storage-provider-overview/);
  assert.match(storageProvidersSource, /data-storage-provider-policy/);
  assert.match(storageProvidersSource, /data-storage-provider-empty/);
  assert.match(storageProvidersSource, /每个外部存储的容量上限/);
  assert.doesNotMatch(storageProvidersSource, /grid border-y border-border\/70 lg:grid-cols-2 lg:divide-x/);
});

test("global model groups can be explicitly cleared", () => {
  assert.match(modelConfigSource, />\s*清空\s*</);
  assert.match(modelConfigSource, /onClear=\{\(\) => updateModels\("text", \[\]\)\}/);
  assert.match(modelConfigSource, /暂无模型，点击“添加”进行配置/);
  assert.doesNotMatch(modelConfigSource, /if \(normalized\.length === 0\) return/);
  assert.doesNotMatch(modelConfigSource, /disabled=\{models\.length === 1\}/);
  assert.doesNotMatch(modelConfigSource, /每类至少保留一个模型/);
});

test("management pages add density without removing their table overflow guards", () => {
  assert.match(permissionEditorSource, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,240px\),1fr\)\)\]/);
  assert.match(logsPageSource, /data-logs-layout/);
  assert.match(logsPageSource, /更多筛选/);
  assert.match(logsPageSource, /慢请求（≥ 3 秒）/);
  assert.match(logsPageSource, /pageSizeOptions/);
  assert.match(logsPageSource, /min-w-\[1040px\]/);
});
