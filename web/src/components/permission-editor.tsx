"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Item } from "@/components/ui/item";

import { useMemo } from "react";
import { KeyRound, Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import type { ApiPermission, PermissionMenu } from "@/lib/api";
import { cn } from "@/lib/utils";

function flattenMenuPermissions(items: PermissionMenu[] | null | undefined): PermissionMenu[] {
  const out: PermissionMenu[] = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    out.push(item);
    out.push(...flattenMenuPermissions(item.children));
  });
  return out;
}

function groupApiPermissions(items: ApiPermission[]) {
  return items.reduce<Array<{ group: string; items: ApiPermission[] }>>((groups, item) => {
    const group = item.group || "其他";
    const existing = groups.find((entry) => entry.group === group);
    if (existing) {
      existing.items.push(item);
      return groups;
    }
    groups.push({ group, items: [item] });
    return groups;
  }, []);
}

function toggleListValue(values: string[], value: string, checked: boolean) {
  const current = new Set(values);
  if (checked) current.add(value);
  else current.delete(value);
  return Array.from(current).sort();
}

function toggleListValues(values: string[], targets: string[], checked: boolean) {
  const current = new Set(values);
  targets.forEach((target) => {
    if (checked) current.add(target);
    else current.delete(target);
  });
  return Array.from(current).sort();
}

type PermissionEditorProps = {
  menus: PermissionMenu[];
  apis: ApiPermission[];
  selectedMenuPaths: string[];
  selectedApiPermissions: string[];
  onMenuPathsChange: (paths: string[]) => void;
  onApiPermissionsChange: (permissions: string[]) => void;
  disabled?: boolean;
  className?: string;
};

export function PermissionEditor({
  menus,
  apis,
  selectedMenuPaths,
  selectedApiPermissions,
  onMenuPathsChange,
  onApiPermissionsChange,
  disabled = false,
  className,
}: PermissionEditorProps) {
  const menuPermissions = useMemo(() => flattenMenuPermissions(menus), [menus]);
  const apiPermissionGroups = useMemo(() => groupApiPermissions(apis), [apis]);
  const allMenuPaths = useMemo(() => menuPermissions.map((item) => item.path), [menuPermissions]);
  const allApiPermissionKeys = useMemo(() => apis.map((item) => item.key), [apis]);

  return (
    <Tabs
      defaultValue="menus"
      data-permission-editor
      className={cn("h-full min-h-0 min-w-0 gap-0", className)}
      aria-busy={disabled}
    >
      <TabsList aria-label="权限分类" className="mx-4 my-3 w-auto shrink-0 xl:hidden">
        <TabsTrigger value="menus">菜单访问 {selectedMenuPaths.length}</TabsTrigger>
        <TabsTrigger value="apis">功能权限 {selectedApiPermissions.length}</TabsTrigger>
      </TabsList>
      <div className="grid min-h-0 min-w-0 flex-1 xl:grid-cols-[minmax(220px,0.7fr)_minmax(0,2fr)]">
      <TabsContent value="menus" forceMount asChild>
      <section className="flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden xl:border-r xl:data-[state=inactive]:flex">
        <div className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/15 px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Menu className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">菜单访问</h3>
              <p className="text-xs tabular-nums text-muted-foreground">{selectedMenuPaths.length} / {allMenuPaths.length}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm"  disabled={disabled || selectedMenuPaths.length === allMenuPaths.length} onClick={() => onMenuPathsChange(allMenuPaths)}>全选</Button>
            <Button type="button" variant="ghost" size="sm"  disabled={disabled || selectedMenuPaths.length === 0} onClick={() => onMenuPathsChange([])}>清空</Button>
          </div>
        </div>
        <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0">
          {menuPermissions.length ? (
            <div className="divide-y divide-border">
              {menuPermissions.map((item) => {
                const checked = selectedMenuPaths.includes(item.path);
                return (
                  <Item key={item.path} asChild><Label data-selected={checked} className="min-h-[58px] cursor-pointer">
                    <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onMenuPathsChange(toggleListValue(selectedMenuPaths, item.path, Boolean(value)))} />
                    <div className="min-w-0">
                      <div className="break-words text-sm font-medium leading-5 text-foreground">{item.label}</div>
                      <code className="mt-0.5 block font-mono [overflow-wrap:anywhere] text-[11px] text-muted-foreground">{item.path}</code>
                    </div>
                  </Label></Item>
                );
              })}
            </div>
          ) : <EmptyState compact icon={Menu} title="暂无菜单权限" className="min-h-48" />}
        </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
      </section>
      </TabsContent>

      <TabsContent value="apis" forceMount asChild>
      <section className="flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden xl:data-[state=inactive]:flex">
        <div className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/15 px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">功能权限</h3>
              <p className="text-xs tabular-nums text-muted-foreground">{selectedApiPermissions.length} / {allApiPermissionKeys.length}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm"  disabled={disabled || selectedApiPermissions.length === allApiPermissionKeys.length} onClick={() => onApiPermissionsChange(allApiPermissionKeys)}>全选</Button>
            <Button type="button" variant="ghost" size="sm"  disabled={disabled || selectedApiPermissions.length === 0} onClick={() => onApiPermissionsChange([])}>清空</Button>
          </div>
        </div>
        <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0 p-4 sm:p-5">
          {apiPermissionGroups.length ? (
            <div className="space-y-6">
              {apiPermissionGroups.map((group) => {
                const groupKeys = group.items.map((item) => item.key);
                const selectedCount = groupKeys.filter((key) => selectedApiPermissions.includes(key)).length;
                const groupChecked = selectedCount === groupKeys.length ? true : selectedCount > 0 ? "indeterminate" : false;
                return (
                  <section key={group.group} className="min-w-0">
                    <Item variant="muted" className="mb-3 flex flex-wrap items-center justify-between gap-2 px-2.5 py-2">
                      <Label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                        <Checkbox checked={groupChecked} disabled={disabled} onCheckedChange={(value) => onApiPermissionsChange(toggleListValues(selectedApiPermissions, groupKeys, Boolean(value)))} />
                        <h4 className="truncate text-xs font-semibold text-foreground">{group.group}</h4>
                      </Label>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{selectedCount} / {group.items.length}</span>
                    </Item>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
                      {group.items.map((permission) => {
                        const checked = selectedApiPermissions.includes(permission.key);
                        return (
                          <Item key={permission.key} variant="outline" asChild><Label data-selected={checked} className="flex min-h-[76px] cursor-pointer items-start gap-3 px-3.5 py-3">
                            <Checkbox checked={checked} disabled={disabled} className="mt-0.5" onCheckedChange={(value) => onApiPermissionsChange(toggleListValue(selectedApiPermissions, permission.key, Boolean(value)))} />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <Badge variant="secondary" className="shrink-0 font-mono">{permission.method}</Badge>
                                <span className="text-xs font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{permission.label}</span>
                              </div>
                              <code className="mt-1.5 block font-mono text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{permission.path}{permission.subtree ? "/*" : ""}</code>
                            </div>
                          </Label></Item>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : <EmptyState compact icon={KeyRound} title="暂无功能权限" className="min-h-48" />}
        </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
      </section>
      </TabsContent>
      </div>
    </Tabs>
  );
}
