import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const viteConfigSource = readSource("../vite.config.ts");
const imagePageSource = readSource("../src/app/image/page.tsx");
const imageResultsSource = readSource("../src/app/image/components/image-results.tsx");
const mediaVideoPlayerSource = readSource("../src/components/media-video-player.tsx");
const assetDisplaySource = readSource("../src/app/assets/asset-display.tsx");
const settingsPageSource = readSource("../src/app/settings/page.tsx");
const sectionNavigationSource = readSource("../src/components/section-navigation.tsx");
const topNavSource = readSource("../src/components/top-nav.tsx");
const settingsConfigSource = readSource("../src/app/settings/components/config-card.tsx");
const settingsUISource = readSource("../src/app/settings/components/settings-ui.tsx");
const modelConfigSource = readSource("../src/app/settings/components/model-config-card.tsx");
const storageProvidersSource = readSource("../src/app/settings/components/storage-providers-card.tsx");
const profilePageSource = readSource("../src/app/profile/page.tsx");
const profilePreferencesSource = profilePageSource.slice(
  profilePageSource.indexOf("function ImageGenerationPreferencesCard"),
  profilePageSource.indexOf("function AccountOverviewCard"),
);
const permissionEditorSource = readSource("../src/components/permission-editor.tsx");
const logsPageSource = readSource("../src/app/logs/page.tsx");

test("creative workbench uses the full shell and increases useful wide-screen density", () => {
  assert.doesNotMatch(imagePageSource, /max-w-\[1380px\]/);
  assert.match(imagePageSource, /2xl:grid-cols-\[260px_minmax\(0,1fr\)\]/);
  assert.match(imagePageSource, /2xl:max-w-\[1180px\]/);
  assert.match(imageResultsSource, /max-w-\[1120px\]/);
  assert.match(imageResultsSource, /lg:grid-cols-3/);
  assert.match(imageResultsSource, /max-w-\[1180px\]/);
});

test("video generation results use a dedicated compact result workspace", () => {
  assert.match(imageResultsSource, /data-video-result-summary/);
  assert.match(imageResultsSource, /data-video-result-card/);
  assert.match(imageResultsSource, /下载全部视频/);
  assert.match(imageResultsSource, /isVideoTurn \? "max-w-\[960px\]"/);
  assert.match(imageResultsSource, /!isVideoTurn && successfulVisualImages\.length > 0/);
  assert.match(imageResultsSource, /视频 \{index \+ 1\}/);
  assert.match(imageResultsSource, /<MediaVideoPlayer/);
  assert.match(imageResultsSource, /generationFrameAspectRatio\(turn\)/);
  assert.match(imageResultsSource, /aspectRatio=\{turnFrameAspectRatio\}/);
  assert.match(imageResultsSource, /aspectRatio: turnFrameAspectRatio/);
  assert.doesNotMatch(imageResultsSource, /<video[\s\S]{0,120}controls/);
  assert.match(mediaVideoPlayerSource, /Player from "xgplayer"/);
  assert.match(mediaVideoPlayerSource, /new Player/);
  assert.match(mediaVideoPlayerSource, /data-app-video-player/);
  assert.match(mediaVideoPlayerSource, /lang: "zh-cn"/);
  assert.match(mediaVideoPlayerSource, /playbackRate: \{/);
  assert.match(mediaVideoPlayerSource, /toggleMode: "click"/);
  assert.match(mediaVideoPlayerSource, /\{ rate: 1, text: "正常", iconText: "1x" \}/);
  assert.match(mediaVideoPlayerSource, /download: true/);
  assert.match(mediaVideoPlayerSource, /controls: \{\s*autoHide: false,\s*initShow: true,/);
  assert.match(mediaVideoPlayerSource, /cssFullscreen: true/);
  assert.match(mediaVideoPlayerSource, /enableContextmenu: false/);
  assert.match(mediaVideoPlayerSource, /videoFillMode: "contain"/);
  assert.match(mediaVideoPlayerSource, /playedColor: "#1456f0"/);
  assert.match(assetDisplaySource, /<MediaVideoPlayer src=\{mediaURL\}/);
  assert.doesNotMatch(assetDisplaySource, /asset\?\.kind === "video" \? <video src=\{mediaURL\} controls/);
});

test("xgplayer stays in one production chunk so its class hierarchy initializes together", () => {
  const mediaVendorGroup = viteConfigSource.slice(
    viteConfigSource.indexOf('name: "media-vendor"'),
    viteConfigSource.indexOf('name: "vendor"'),
  );
  assert.match(mediaVendorGroup, /node_modules\[\\\\\/\]xgplayer/);
  assert.match(mediaVendorGroup, /priority: 10/);
  assert.doesNotMatch(mediaVendorGroup, /maxSize/);
});

test("settings and profile pages no longer retain their previous centered caps", () => {
  assert.doesNotMatch(settingsPageSource, /max-w-\[1240px\]/);
  assert.match(settingsPageSource, /2xl:grid-cols-\[240px_minmax\(0,1fr\)\]/);
  assert.match(settingsConfigSource, /2xl:grid-cols-3/);
  assert.match(storageProvidersSource, /setting\.providers\.map/);
  assert.match(storageProvidersSource, /md:grid-cols-2/);

  assert.doesNotMatch(profilePageSource, /max-w-\[1280px\]/);
  assert.match(profilePageSource, /data-profile-layout/);
  assert.match(profilePageSource, /2xl:grid-cols-\[240px_minmax\(0,1fr\)\]/);
  assert.match(profilePageSource, /xl:grid-cols-3/);
  for (const source of [settingsPageSource, profilePageSource]) {
    assert.match(source, /<SectionNavigation/);
    assert.doesNotMatch(source, /<aside className="rounded-lg border border-border bg-background/);
  }
  assert.match(sectionNavigationSource, /data-section-navigation/);
  assert.match(sectionNavigationSource, /card-surface rounded-xl border border-border\/80/);
  assert.match(sectionNavigationSource, /aria-current=\{active \? "page" : undefined\}/);
});

test("admin navigation stays in two rows until every menu and action can fit", () => {
  assert.match(topNavSource, /xl:grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(topNavSource, /xl:col-start-2 xl:row-start-1/);
  assert.match(topNavSource, /xl:w-full xl:justify-self-stretch/);
  assert.doesNotMatch(topNavSource, /lg:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
});

test("settings section titles and actions stay visible while their content scrolls", () => {
  assert.match(settingsPageSource, /viewportClassName="pr-4 lg:pr-0"/);
  assert.match(settingsPageSource, /viewStyle=\{\{ height: "100%", minHeight: "100%" \}\}/);
  assert.match(settingsPageSource, /lg:h-full lg:min-h-0 lg:grid-cols/);
  assert.doesNotMatch(settingsPageSource, /data-settings-layout className="w-full pr-1"/);
  assert.match(settingsUISource, /data-settings-card-header-frame/);
  assert.match(settingsUISource, /data-settings-card-body/);
  assert.match(settingsUISource, /className="min-h-0 lg:flex-1"/);
  assert.match(settingsUISource, /viewportClassName="pr-4"/);
  assert.match(settingsUISource, /className="shrink-0 bg-card"/);
  assert.match(settingsUISource, /data-settings-card-header/);
  assert.match(settingsUISource, /border-b border-border\/80 bg-card/);
  assert.match(settingsUISource, /overflow-hidden rounded-xl border-border\/80 lg:h-full lg:min-h-0/);
  assert.doesNotMatch(settingsUISource, /sticky top-0/);
  assert.doesNotMatch(settingsUISource, /-mx-px -mt-px/);
});

test("profile creation title and save action stay visible while preferences scroll", () => {
  assert.match(profilePageSource, /viewportClassName="pr-4 lg:pr-0"/);
  assert.match(profilePageSource, /viewStyle=\{\{ height: "100%", minHeight: "100%" \}\}/);
  assert.match(profilePageSource, /data-profile-layout className="grid min-h-full[^"]*lg:h-full lg:min-h-0/);
  assert.match(profilePreferencesSource, /data-profile-preferences-card/);
  assert.match(profilePreferencesSource, /data-profile-preferences-header/);
  assert.match(profilePreferencesSource, /className="shrink-0 border-b border-border\/80 bg-card/);
  assert.match(profilePreferencesSource, /data-profile-preferences-body/);
  assert.match(profilePreferencesSource, /className="min-h-0 lg:flex-1"/);
  assert.match(profilePreferencesSource, /data-profile-preferences-header[\s\S]*保存设置[\s\S]*data-profile-preferences-body/);
  assert.doesNotMatch(profilePreferencesSource, /data-profile-preferences-header[\s\S]{0,180}sticky top-0/);
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
  assert.match(permissionEditorSource, /md:grid-cols-2 2xl:grid-cols-3/);
  assert.match(logsPageSource, /data-logs-layout/);
  assert.match(logsPageSource, /更多筛选/);
  assert.match(logsPageSource, /慢请求（≥ 3 秒）/);
  assert.match(logsPageSource, /pageSizeOptions/);
  assert.match(logsPageSource, /min-w-\[1040px\]/);
});
