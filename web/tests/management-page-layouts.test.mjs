import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const managementSource = readSource("../src/components/management-page.tsx");
const assetsSource = readSource("../src/app/assets/page.tsx");
const usersSource = readSource("../src/app/users/page.tsx");
const rbacSource = readSource("../src/app/rbac/page.tsx");
const permissionEditorSource = readSource("../src/components/permission-editor.tsx");
const logsSource = readSource("../src/app/logs/page.tsx");
const apiSource = readSource("../src/lib/api.ts");
const workflowsSource = readSource("../src/app/workflows/creative-workflow-workspace.tsx");
const emptyStateSource = readSource("../src/components/ui/empty-state.tsx");

test("management pages share one page and panel layout contract", () => {
  for (const source of [assetsSource, usersSource, rbacSource, logsSource]) {
    assert.match(source, /<ManagementPage/);
    assert.match(source, /<ManagementPanel/);
  }
  for (const source of [usersSource, rbacSource, logsSource]) {
    assert.match(source, /<ManagementToolbar/);
  }

  assert.match(managementSource, /data-management-page/);
  assert.match(managementSource, /gap-\[var\(--page-section-gap\)\]/);
  assert.match(managementSource, /data-management-panel/);
  assert.match(managementSource, /card-surface[\s\S]*border border-border\/80/);
  assert.doesNotMatch(managementSource, /data-management-panel[\s\S]{0,240}bg-background/);
  assert.doesNotMatch(managementSource, /components\/ui\/card/);
  assert.match(managementSource, /data-management-toolbar/);
});

test("assets, users, and logs use the same responsive pagination contract", () => {
  assert.match(assetsSource, /<ManagementPagination/);
  assert.match(usersSource, /<ManagementPagination/);
  assert.match(logsSource, /<ManagementPagination/);
  assert.doesNotMatch(assetsSource, /aria-label="上一页"/);
  assert.doesNotMatch(usersSource, /aria-label="上一页"/);
  assert.doesNotMatch(logsSource, /aria-label="上一页"/);

  assert.match(managementSource, /data-management-pagination/);
  assert.match(
    managementSource,
    /grid-cols-\[1fr_auto\][\s\S]*sm:grid-cols-\[1fr_auto_1fr\]/
  );
  assert.match(
    managementSource,
    /disabled=\{!hasItems \|\| page <= 1 \|\| props\.disabled\}/
  );
  assert.match(
    managementSource,
    /第 \{hasItems \? page : 0\} \/ \{hasItems \? totalPages : 0\} 页/
  );
});

test("user toolbar leaves totals and empty selection state to pagination and row controls", () => {
  assert.match(usersSource, /data-user-toolbar/);
  assert.doesNotMatch(usersSource, /共 \{total\} 个用户|未选择用户/);
});

test("every page-level pagination stays fixed to the bottom of its full-height panel", () => {
  assert.match(managementSource, /data-management-pagination[\s\S]*className="mt-auto/);
  for (const source of [assetsSource, usersSource, logsSource]) {
    assert.match(source, /<ManagementPanel className="flex-1">/);
    assert.match(source, /<ManagementPagination/);
  }
  for (const source of [usersSource, logsSource]) {
    assert.match(source, /<ScrollArea className="min-h-0 flex-1">/);
  }
});

test("role panels use the full shared management content height", () => {
  assert.doesNotMatch(rbacSource, /max-h-\[calc\(100dvh-/);
  assert.match(rbacSource, /min-h-\[940px\] lg:min-h-\[720px\] xl:min-h-0/);
});

test("role authorization separates permission types and supports focused review", () => {
  assert.match(permissionEditorSource, /data-permission-editor/);
  assert.match(permissionEditorSource, /菜单访问/);
  assert.match(permissionEditorSource, /功能权限/);
  assert.match(permissionEditorSource, /toggleListValues/);
  assert.match(permissionEditorSource, /disabled=\{disabled\}/);
  assert.match(permissionEditorSource, /lg:grid-cols-\[300px_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(permissionEditorSource, /仅看已选|setSection/);
});

test("switching roles protects unsaved authorization changes", () => {
  assert.match(rbacSource, /requestRoleSelection/);
  assert.match(rbacSource, /setPendingRole\(role\)/);
  assert.match(rbacSource, /放弃未保存的修改/);
  assert.match(rbacSource, /撤销未保存修改/);
});

test("management actions share the same row as their filters", () => {
  assert.match(assetsSource, /data-asset-filter-bar[\s\S]*新增素材/);
  assert.match(usersSource, /data-user-toolbar[\s\S]*刷新[\s\S]*创建用户/);
  assert.match(logsSource, /<ManagementToolbar>[\s\S]*刷新[\s\S]*<\/ManagementToolbar>/);
  assert.match(rbacSource, /<ManagementToolbar className="flex items-center gap-2">[\s\S]*刷新角色权限[\s\S]*创建角色/);
  for (const source of [assetsSource, usersSource, rbacSource, logsSource]) {
    assert.doesNotMatch(source, /<ManagementPage[\s\S]{0,120}actions=\{/);
  }
  assert.equal(
    (logsSource.match(/onClick=\{\(\) => void loadLogs\(query\)\}/g) || [])
      .length,
    1
  );
});

test("log queries abort stale loads and only the latest request updates state", () => {
  assert.match(logsSource, /loadLogsAbortRef = useRef<AbortController \| null>/);
  assert.match(logsSource, /loadLogsRequestRef = useRef\(0\)/);
  assert.match(logsSource, /loadLogsAbortRef\.current\?\.abort\(\)/);
  assert.match(logsSource, /fetchSystemLogs\(nextQuery, \{ signal: controller\.signal \}\)/);
  assert.match(logsSource, /requestID !== loadLogsRequestRef\.current/);
  assert.match(logsSource, /requestID === loadLogsRequestRef\.current/);
  assert.match(logsSource, /return \(\) => \{[\s\S]*loadLogsRequestRef\.current \+= 1;[\s\S]*loadLogsAbortRef\.current\?\.abort\(\)/);
  assert.match(apiSource, /fetchSystemLogs\(filters: SystemLogFilters, options: \{ signal\?: AbortSignal \} = \{\}\)/);
  assert.match(apiSource, /`\/api\/logs[\s\S]*\{ signal: options\.signal \}/);
});

test("role permission queries abort stale loads and preserve the latest selection", () => {
  assert.match(rbacSource, /loadRBACAbortRef = useRef<AbortController \| null>/);
  assert.match(rbacSource, /loadRBACRequestRef = useRef\(0\)/);
  assert.match(rbacSource, /fetchManagedRoles\(\{ signal: controller\.signal \}\)/);
  assert.match(rbacSource, /fetchPermissionCatalog\(\{ signal: controller\.signal \}\)/);
  assert.match(rbacSource, /requestID !== loadRBACRequestRef\.current/);
  assert.match(rbacSource, /loadRBACRequestRef\.current \+= 1;[\s\S]*loadRBACAbortRef\.current\?\.abort\(\)/);
  assert.match(rbacSource, /selectedRoleIdRef\.current = roleID;[\s\S]*setSelectedRoleId\(roleID\)/);
  assert.match(rbacSource, /const savingRoleID = selectedRole\.id/);
  assert.match(rbacSource, /const savingDraftVersion = draftVersionRef\.current/);
  assert.match(rbacSource, /selectedRoleIdRef\.current === savingRoleID[\s\S]*draftVersionRef\.current === savingDraftVersion[\s\S]*applySelectedRole/);
  assert.match(rbacSource, /const applySelectedRole = useCallback[\s\S]{0,180}draftVersionRef\.current \+= 1/);
  assert.match(rbacSource, /onChange=\{\(event\) => \{\s*draftVersionRef\.current \+= 1;\s*setRoleName\(event\.target\.value\)/);
  assert.match(rbacSource, /onMenuPathsChange=\{\(paths\) => \{\s*draftVersionRef\.current \+= 1;\s*setSelectedMenuPaths\(paths\)/);
  assert.match(rbacSource, /onApiPermissionsChange=\{\(permissions\) => \{\s*draftVersionRef\.current \+= 1;\s*setSelectedApiPermissions\(permissions\)/);
  assert.match(apiSource, /fetchManagedRoles\(options: \{ signal\?: AbortSignal \} = \{\}\)/);
  assert.match(apiSource, /fetchPermissionCatalog\(options: \{ signal\?: AbortSignal \} = \{\}\)/);
});

test("log detail header reserves the global dialog close-button area", () => {
  assert.match(logsSource, /<DialogHeader className="border-b border-border py-5 pl-6 pr-20">/);
  assert.match(logsSource, /className="h-9 shrink-0 self-start rounded-lg px-3"[\s\S]*?复制 JSON/);
  assert.doesNotMatch(logsSource, /<DialogHeader className="[^"]*px-6[^"]*">[\s\S]*?复制 JSON/);
});

test("major libraries and management pages share one page-level empty state", () => {
  assert.match(emptyStateSource, /data-empty-state/);
  assert.match(emptyStateSource, /compact \? "min-h-32 py-8" : "min-h-44 py-10"/);
  for (const source of [assetsSource, usersSource, rbacSource, logsSource, workflowsSource]) {
    assert.match(source, /<EmptyState/);
  }
  assert.doesNotMatch(usersSource, /px-6 py-14 text-center text-sm text-stone-500/);
  assert.doesNotMatch(rbacSource, /px-5 py-12 text-center text-sm text-muted-foreground/);
});
