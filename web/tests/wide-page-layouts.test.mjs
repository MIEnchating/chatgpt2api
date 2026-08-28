import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const imagePageSource = readSource("../src/app/image/page.tsx");
const imageResultsSource = readSource("../src/app/image/components/image-results.tsx");
const settingsPageSource = readSource("../src/app/settings/page.tsx");
const settingsConfigSource = readSource("../src/app/settings/components/config-card.tsx");
const storageProvidersSource = readSource("../src/app/settings/components/storage-providers-card.tsx");
const profilePageSource = readSource("../src/app/profile/page.tsx");
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
});

test("management pages add density without removing their table overflow guards", () => {
  assert.match(permissionEditorSource, /md:grid-cols-2 2xl:grid-cols-3/);
  assert.match(logsPageSource, /data-logs-layout/);
  assert.match(logsPageSource, /更多筛选/);
  assert.match(logsPageSource, /慢请求（≥ 3 秒）/);
  assert.match(logsPageSource, /pageSizeOptions/);
  assert.match(logsPageSource, /min-w-\[1040px\]/);
});
