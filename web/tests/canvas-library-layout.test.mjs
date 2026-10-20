import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/app/canvas/library-page.tsx", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("../src/app/app-shell.tsx", import.meta.url), "utf8");
const assetsSource = readFileSync(new URL("../src/app/assets/page.tsx", import.meta.url), "utf8");
const usersSource = readFileSync(new URL("../src/app/users/page.tsx", import.meta.url), "utf8");
const rbacSource = readFileSync(new URL("../src/app/rbac/page.tsx", import.meta.url), "utf8");
const managementPageSource = readFileSync(new URL("../src/components/management-page.tsx", import.meta.url), "utf8");
const logsSource = readFileSync(new URL("../src/app/logs/page.tsx", import.meta.url), "utf8");
const globalStylesSource = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("every page shares the same full-width application shell", () => {
  assert.match(appShellSource, /w-full max-w-none flex-col gap-\[var\(--page-section-gap\)\]/);
  assert.doesNotMatch(appShellSource, /max-w-\[1480px\]/);
  assert.doesNotMatch(appShellSource, /useLocation/);
});

test("navigation and content sections share one vertical spacing token", () => {
  assert.match(globalStylesSource, /--page-section-gap: 1rem/);
  for (const pageSource of [source, managementPageSource]) {
    assert.match(pageSource, /flex h-full min-h-0(?: min-w-0)? flex-col gap-\[var\(--page-section-gap\)\]/);
  }
  for (const pageSource of [assetsSource, usersSource, rbacSource]) {
    assert.match(pageSource, /<ManagementPage/);
  }
});

test("management pages use navigation labels without duplicate page headers", () => {
  for (const pageSource of [assetsSource, usersSource, rbacSource, logsSource]) {
    assert.match(pageSource, /<ManagementPage[^>]+aria-label=/);
    assert.doesNotMatch(pageSource, /<ManagementPage[^>]+\btitle=/);
  }
  assert.doesNotMatch(managementPageSource, /PageHeader|data-page-header/);
  assert.match(managementPageSource, /\{\.\.\.props\}\s*>\s*\{children\}/);
});

test("canvas project actions and counts stay inside the search toolbar", () => {
  assert.doesNotMatch(source, /PageHeader|data-page-header/);
  const toolbar = source.slice(source.indexOf("data-canvas-project-toolbar"), source.indexOf('<ScrollArea className="min-h-0 flex-1">'));
  assert.match(toolbar, /min-w-0 shrink-0 flex-wrap/);
  assert.match(toolbar, /placeholder="搜索画布名称"/);
  assert.match(toolbar, /共 \$\{visibleProjects.length\} 个画布/);
  assert.match(toolbar, /data-canvas-project-actions className="ml-auto flex min-w-0 flex-wrap/);
  for (const action of ["导入画布", "导出选中", "删除选中", "取消选择", "Agent", "新建画布", "全选当前结果"]) {
    assert.ok(toolbar.includes(action), `Missing canvas toolbar action: ${action}`);
  }
});

test("canvas project cards use a stable responsive four-column wide-screen grid", () => {
  assert.match(source, /data-canvas-project-content className="w-full p-4 sm:p-5"/);
  assert.doesNotMatch(source, /max-w-\[1600px\]/);
  assert.match(source, /data-canvas-project-grid/);
  assert.match(source, /grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4/);
  assert.doesNotMatch(source, /auto-fill/);
});

test("canvas project card content keeps compact explicit spacing", () => {
  assert.match(source, /data-canvas-project-card/);
  assert.match(source, /data-selected=\{selectedProjectIDs\.has\(project\.id\)\}/);
  assert.match(source, /data-interaction="trigger"/);
  assert.match(source, /className="interactive-card group/);
  assert.match(source, /className="interactive-card-trigger min-w-0 flex-1/);
  assert.match(source, /className="selection-control"/);
  assert.match(source, /mb-3 flex min-h-5/);
  assert.match(source, /mt-3 flex min-w-0 flex-wrap/);
  assert.match(source, /mt-4 flex items-center justify-end/);
});
