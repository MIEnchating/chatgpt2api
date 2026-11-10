"use client";

import { LabeledField } from "@/components/labeled-field";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";


import { TooltipHint } from "@/components/ui/tooltip";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Save, ShieldCheck, Trash2, Undo2, Users } from "lucide-react";
import { toast } from "sonner";

import { ManagementHeader, ManagementPage, ManagementPanel, ManagementToolbar } from "@/components/management-page";
import { PermissionEditor } from "@/components/permission-editor";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import {
  createManagedRole,
  deleteManagedRole,
  fetchManagedRoles,
  fetchPermissionCatalog,
  updateManagedRole,
  type ApiPermission,
  type ManagedRole,
  type PermissionMenu,
} from "@/lib/api";
import { LoadingState } from "@/components/ui/loading-state";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

function normalizeManagedRoles(items: ManagedRole[] | null | undefined) {
  return Array.isArray(items) ? items : [];
}

function uniqueSortedStrings(values: string[] | null | undefined) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function sameStringSet(left: string[], right: string[] | null | undefined) {
  const normalizedLeft = uniqueSortedStrings(left);
  const normalizedRight = uniqueSortedStrings(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function roleSearchText(role: ManagedRole) {
  return [role.id, role.name, role.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function permissionCountLabel(role: ManagedRole) {
  return `${uniqueSortedStrings(role.menu_paths).length} 菜单 / ${uniqueSortedStrings(role.api_permissions).length} API`;
}

function RBACContent() {
  const pageActiveRef = useRef(true);
  const mutationPendingRef = useRef(false);
  const selectedRoleIdRef = useRef("");
  const draftVersionRef = useRef(0);
  const loadRBACAbortRef = useRef<AbortController | null>(null);
  const loadRBACRequestRef = useRef(0);
  const [roles, setRoles] = useState<ManagedRole[]>([]);
  const [catalog, setCatalog] = useState<{ menus: PermissionMenu[]; apis: ApiPermission[] }>({ menus: [], apis: [] });
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [selectedMenuPaths, setSelectedMenuPaths] = useState<string[]>([]);
  const [selectedApiPermissions, setSelectedApiPermissions] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deletingRole, setDeletingRole] = useState<ManagedRole | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingRole, setPendingRole] = useState<ManagedRole | null>(null);
  const isMutating = isSaving || isCreating || isDeleting;

  const applySelectedRole = useCallback((role: ManagedRole | null | undefined) => {
    const roleID = role?.id || "";
    draftVersionRef.current += 1;
    selectedRoleIdRef.current = roleID;
    setSelectedRoleId(roleID);
    setRoleName(role?.name || "");
    setRoleDescription(role?.description || "");
    setSelectedMenuPaths(uniqueSortedStrings(role?.menu_paths));
    setSelectedApiPermissions(uniqueSortedStrings(role?.api_permissions));
  }, []);

  const loadRBAC = useCallback(async () => {
    if (!pageActiveRef.current || mutationPendingRef.current) return;
    const requestID = loadRBACRequestRef.current + 1;
    loadRBACRequestRef.current = requestID;
    loadRBACAbortRef.current?.abort();
    const controller = new AbortController();
    loadRBACAbortRef.current = controller;
    setIsLoading(true);
    try {
      const [rolesData, catalogData] = await Promise.all([
        fetchManagedRoles({ signal: controller.signal }),
        fetchPermissionCatalog({ signal: controller.signal }),
      ]);
      if (requestID !== loadRBACRequestRef.current) return;
      const nextRoles = normalizeManagedRoles(rolesData.items);
      const nextCatalog = {
        menus: Array.isArray(catalogData.menus) ? catalogData.menus : [],
        apis: Array.isArray(catalogData.apis) ? catalogData.apis : [],
      };
      const currentID = selectedRoleIdRef.current;
      const nextSelected = nextRoles.find((role) => role.id === currentID) || nextRoles[0] || null;
      setRoles(nextRoles);
      setCatalog(nextCatalog);
      applySelectedRole(nextSelected);
    } catch (error) {
      if (controller.signal.aborted || requestID !== loadRBACRequestRef.current) return;
      toast.error(error instanceof Error ? error.message : "加载角色权限失败");
    } finally {
      if (requestID === loadRBACRequestRef.current) {
        setIsLoading(false);
        if (loadRBACAbortRef.current === controller) loadRBACAbortRef.current = null;
      }
    }
  }, [applySelectedRole]);

  useEffect(() => {
    pageActiveRef.current = true;
    void loadRBAC();
    return () => {
      pageActiveRef.current = false;
      loadRBACRequestRef.current += 1;
      loadRBACAbortRef.current?.abort();
    };
  }, [loadRBAC]);

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) || null,
    [roles, selectedRoleId],
  );

  const filteredRoles = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) {
      return roles;
    }
    return roles.filter((role) => roleSearchText(role).includes(keyword));
  }, [roles, searchText]);

  const isDirty = Boolean(selectedRole)
    && (roleName.trim() !== (selectedRole?.name || "")
      || roleDescription.trim() !== (selectedRole?.description || "")
      || !sameStringSet(selectedMenuPaths, selectedRole?.menu_paths)
      || !sameStringSet(selectedApiPermissions, selectedRole?.api_permissions));

  const requestRoleSelection = (role: ManagedRole) => {
    if (role.id === selectedRoleId) {
      return;
    }
    if (isDirty) {
      setPendingRole(role);
      return;
    }
    applySelectedRole(role);
  };

  const handleSave = async () => {
    if (!pageActiveRef.current || !selectedRole || mutationPendingRef.current) {
      return;
    }
    const nextName = roleName.trim();
    if (!nextName) {
      toast.error("角色名称不能为空");
      return;
    }
    const savingRoleID = selectedRole.id;
    const savingDraftVersion = draftVersionRef.current;
    mutationPendingRef.current = true;
    loadRBACRequestRef.current += 1;
    loadRBACAbortRef.current?.abort();
    setIsLoading(false);
    setIsSaving(true);
    try {
      const data = await updateManagedRole(savingRoleID, {
        name: nextName,
        description: roleDescription.trim(),
        menu_paths: selectedMenuPaths,
        api_permissions: selectedApiPermissions,
      });
      if (!pageActiveRef.current) return;
      const nextRoles = normalizeManagedRoles(data.items);
      setRoles(nextRoles);
      if (
        selectedRoleIdRef.current === savingRoleID
        && draftVersionRef.current === savingDraftVersion
      ) {
        applySelectedRole(nextRoles.find((role) => role.id === data.item.id) || data.item);
      }
      toast.success("角色已保存");
    } catch (error) {
      if (!pageActiveRef.current) return;
      toast.error(error instanceof Error ? error.message : "保存角色失败");
    } finally {
      mutationPendingRef.current = false;
      if (pageActiveRef.current) setIsSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!pageActiveRef.current || mutationPendingRef.current) return;
    const nextName = createName.trim();
    if (!nextName) {
      toast.error("角色名称不能为空");
      return;
    }
    mutationPendingRef.current = true;
    loadRBACRequestRef.current += 1;
    loadRBACAbortRef.current?.abort();
    setIsLoading(false);
    setIsCreating(true);
    try {
      const data = await createManagedRole({
        name: nextName,
        description: createDescription.trim(),
      });
      if (!pageActiveRef.current) return;
      const nextRoles = normalizeManagedRoles(data.items);
      setRoles(nextRoles);
      applySelectedRole(nextRoles.find((role) => role.id === data.item.id) || data.item);
      setCreateName("");
      setCreateDescription("");
      setIsCreateDialogOpen(false);
      toast.success("角色已创建");
    } catch (error) {
      if (!pageActiveRef.current) return;
      toast.error(error instanceof Error ? error.message : "创建角色失败");
    } finally {
      mutationPendingRef.current = false;
      if (pageActiveRef.current) setIsCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!pageActiveRef.current || !deletingRole || mutationPendingRef.current) {
      return;
    }
    mutationPendingRef.current = true;
    loadRBACRequestRef.current += 1;
    loadRBACAbortRef.current?.abort();
    setIsLoading(false);
    setIsDeleting(true);
    try {
      const data = await deleteManagedRole(deletingRole.id);
      if (!pageActiveRef.current) return;
      const nextRoles = normalizeManagedRoles(data.items);
      setRoles(nextRoles);
      if (selectedRoleIdRef.current === deletingRole.id) {
        applySelectedRole(nextRoles[0] || null);
      }
      setDeletingRole(null);
      toast.success("角色已删除");
    } catch (error) {
      if (!pageActiveRef.current) return;
      toast.error(error instanceof Error ? error.message : "删除角色失败");
    } finally {
      mutationPendingRef.current = false;
      if (pageActiveRef.current) setIsDeleting(false);
    }
  };

  return (
    <ManagementPage data-rbac-layout aria-label="角色权限" className="p-4 sm:p-6">
      <ManagementHeader title="角色权限" description="管理角色可访问的页面与 API 权限。" className="px-0 pt-0 sm:px-0" />
      {/* Bound Radix's content wrapper so nested panels keep their own scroll height. */}
      <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain xl:h-full [&>div]:block! xl:[&>div]:h-full"><div className="min-w-0 grid content-start gap-[var(--page-section-gap)] xl:h-full xl:content-stretch xl:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)]">
        <ManagementPanel className="h-56 min-h-48 sm:h-64 xl:h-auto xl:min-h-0">
            <ManagementToolbar className="flex items-center gap-2 px-4 py-3">
              <div className="relative min-w-0 flex-1">
                <SearchInput value={searchText} onValueChange={setSearchText} placeholder="搜索角色" />
              </div>
            <TooltipHint content={"刷新角色权限"}><Button aria-label="刷新角色权限"
              variant="outline"
              size="icon"
              onClick={() => void loadRBAC()}
              disabled={isLoading || isDirty || isMutating}

            >
              {isLoading ? <Spinner /> : <RefreshCw />}
            </Button></TooltipHint>
            <TooltipHint content={"创建角色"}><Button aria-label="创建角色"
              size="icon"
              onClick={() => setIsCreateDialogOpen(true)}
              disabled={isLoading || isMutating}

            >
              <Plus  />
            </Button></TooltipHint>
            </ManagementToolbar>
            <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0">
              {isLoading ? (
                <LoadingState className="min-h-[320px]" label="正在加载角色" />
              ) : null}
              {!isLoading && filteredRoles.length === 0 ? (
                <EmptyState compact icon={ShieldCheck} title={searchText.trim() ? "没有匹配的角色" : "暂无角色"} description={searchText.trim() ? "换个关键词，或清除搜索查看全部角色。" : "创建角色后可配置菜单与功能权限"} action={searchText.trim() ? <Button variant="outline" size="sm" onClick={() => setSearchText("")}>清除搜索</Button> : undefined} />
              ) : null}
              {!isLoading
                ? filteredRoles.map((role) => {
                    const active = role.id === selectedRoleId;
                    return (
                      <Toggle variant="outline"
                        key={role.id}
                        type="button"
                        className={cn("block h-auto justify-start whitespace-normal p-0", cn("group relative block w-full px-4 py-3 text-left sm:px-5 xl:py-4", active ? "before:absolute before:inset-y-3 before:left-0 before:w-1" : undefined))}
                        pressed={active}
                        onClick={() => requestRoleSelection(role)}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-foreground">{role.name}</div>
                            <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{role.id}</code>
                          </div>
                          {role.builtin ? (
                            <Badge variant="secondary" className="shrink-0">
                              内置
                            </Badge>
                          ) : null}
                        </div>
                        {role.description ? (
                          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground xl:mt-2 xl:line-clamp-2">{role.description}</p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">{permissionCountLabel(role)}</Badge>
                          <span className="flex items-center gap-1">
                            <Badge variant="secondary" className="flex items-center gap-1">
                            <Users  />
                            {role.user_count || 0}
                            </Badge>
                          </span>
                        </div>
                      </Toggle>
                    );
                  })
                : null}
            </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
        </ManagementPanel>

        <ManagementPanel className="h-[max(42rem,80dvh)] min-h-0 xl:h-auto">
            <ManagementToolbar className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <ShieldCheck className="size-5 shrink-0 text-primary" />
                    <h2 className="truncate text-lg font-semibold text-foreground">
                      {selectedRole?.name || "未选择角色"}
                    </h2>
                  </div>
                  <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                    {selectedRole?.id || "-"}
                  </code>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isDirty ? (
                    <Badge variant="outline" className="w-fit">
                      未保存
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="w-fit">
                      已同步
                    </Badge>
                  )}
                  {isDirty ? (
                    <TooltipHint content={"撤销未保存修改"}><Button aria-label="撤销未保存修改"
                      type="button"
                      variant="outline"
                      size="icon"

                      disabled={isMutating}
                      onClick={() => applySelectedRole(selectedRole)}
                    >
                      <Undo2  />
                    </Button></TooltipHint>
                  ) : null}
                  <TooltipHint content={selectedRole?.builtin ? "内置角色不能删除" : selectedRole?.user_count ? "请先解除该角色绑定的用户" : "删除角色"}><Button aria-label={selectedRole?.builtin ? "内置角色不能删除" : selectedRole?.user_count ? "请先解除该角色绑定的用户" : "删除角色"}
                    type="button"
                    variant="outline"
                    size="icon"

                    disabled={!selectedRole || Boolean(selectedRole.builtin) || Boolean(selectedRole.user_count) || isLoading || isMutating}
                    onClick={() => selectedRole ? setDeletingRole(selectedRole) : null}
                  >
                    <Trash2  />
                  </Button></TooltipHint>
                  <Button
                    onClick={() => void handleSave()}
                    disabled={!selectedRole || !isDirty || isMutating || isLoading}

                  >
                    {isSaving ? <Spinner /> : <Save  />}
                    保存
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                <LabeledField className="grid gap-1.5 text-xs font-medium text-muted-foreground" label="角色名称">{(fieldId) => <><Input id={fieldId}
                    value={roleName}
                    onChange={(event) => {
                      draftVersionRef.current += 1;
                      setRoleName(event.target.value);
                    }}
                    placeholder="角色名称"
                    disabled={!selectedRole || isLoading || isMutating}

                  /></>}</LabeledField>
                <LabeledField className="grid gap-1.5 text-xs font-medium text-muted-foreground" label="角色说明">{(fieldId) => <><Input id={fieldId}
                    value={roleDescription}
                    onChange={(event) => {
                      draftVersionRef.current += 1;
                      setRoleDescription(event.target.value);
                    }}
                    placeholder="说明角色职责或适用范围"
                    disabled={!selectedRole || isLoading || isMutating}

                  /></>}</LabeledField>
              </div>
            </ManagementToolbar>
            <div className="min-h-0 flex-1 overflow-hidden">
              {isLoading ? (
                <LoadingState className="min-h-[420px]" label="正在加载权限" />
              ) : selectedRole ? (
                <PermissionEditor
                  menus={catalog.menus}
                  apis={catalog.apis}
                  selectedMenuPaths={selectedMenuPaths}
                  selectedApiPermissions={selectedApiPermissions}
                  onMenuPathsChange={(paths) => {
                    draftVersionRef.current += 1;
                    setSelectedMenuPaths(paths);
                  }}
                  onApiPermissionsChange={(permissions) => {
                    draftVersionRef.current += 1;
                    setSelectedApiPermissions(permissions);
                  }}
                  disabled={isMutating}
                />
              ) : (
                <EmptyState icon={ShieldCheck} title="暂无角色" description="请先创建或选择一个角色" className="min-h-[420px]" />
              )}
            </div>
        </ManagementPanel>
      </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>

      <Dialog open={isCreateDialogOpen} onOpenChange={(open) => { if (!mutationPendingRef.current) setIsCreateDialogOpen(open); }}>
        <DialogContent>
          <DialogHeader >
            <DialogTitle>创建角色</DialogTitle>
            <DialogDescription >新角色会复制默认用户权限，创建后可继续调整。</DialogDescription>
          </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <LabeledField className="gap-2" label="名称">{(fieldId) => <><Input id={fieldId}
              value={createName}
              disabled={isCreating}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="例如：运营人员"

            /></>}</LabeledField>
          <LabeledField className="gap-2" label="描述">{(fieldId) => <><Input id={fieldId}
              value={createDescription}
              disabled={isCreating}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder="角色职责或使用范围"

            /></>}</LabeledField>
          </ScrollArea><DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setIsCreateDialogOpen(false)} disabled={isCreating}>
              取消
            </Button>
            <Button type="button" onClick={() => void handleCreate()} disabled={isMutating}>
              {isCreating ? <Spinner /> : <Plus  />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deletingRole)}
        title="删除角色"
        description={`确认删除「${deletingRole?.name ?? ""}」吗？只有未绑定用户的自定义角色可以删除。`}
        confirmLabel="删除"
        destructive
        busy={isMutating}
        onOpenChange={(open) => {
          if (!open) setDeletingRole(null);
        }}
        onConfirm={() => void handleDelete()}
      />

      <ConfirmDialog
        open={Boolean(pendingRole)}
        title="放弃未保存的修改？"
        description={`当前角色的名称、说明或权限已经修改。切换到「${pendingRole?.name}」后，这些修改不会保留。`}
        confirmLabel="放弃并切换"
        cancelLabel="继续编辑"
        destructive
        onOpenChange={(open) => { if (!open) setPendingRole(null); }}
        onConfirm={() => {
          applySelectedRole(pendingRole);
          setPendingRole(null);
        }}
      />
    </ManagementPage>
  );
}

export default function RBACPage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/rbac");
  if (isCheckingAuth || !session) {
    return <LoadingState label="正在加载角色权限" />;
  }
  return <RBACContent key={session.key} />;
}
