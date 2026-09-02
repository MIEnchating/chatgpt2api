"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { ManagementPage, ManagementPanel, ManagementToolbar } from "@/components/management-page";
import { PermissionEditor } from "@/components/permission-editor";
import { EmptyState } from "@/components/ui/empty-state";
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
import { ScrollArea } from "@/components/ui/scroll-area";
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
    void loadRBAC();
    return () => {
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
    if (!selectedRole || isSaving) {
      return;
    }
    const nextName = roleName.trim();
    if (!nextName) {
      toast.error("角色名称不能为空");
      return;
    }
    const savingRoleID = selectedRole.id;
    const savingDraftVersion = draftVersionRef.current;
    setIsSaving(true);
    try {
      const data = await updateManagedRole(savingRoleID, {
        name: nextName,
        description: roleDescription.trim(),
        menu_paths: selectedMenuPaths,
        api_permissions: selectedApiPermissions,
      });
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
      toast.error(error instanceof Error ? error.message : "保存角色失败");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreate = async () => {
    const nextName = createName.trim();
    if (!nextName) {
      toast.error("角色名称不能为空");
      return;
    }
    setIsCreating(true);
    try {
      const data = await createManagedRole({
        name: nextName,
        description: createDescription.trim(),
      });
      const nextRoles = normalizeManagedRoles(data.items);
      setRoles(nextRoles);
      applySelectedRole(nextRoles.find((role) => role.id === data.item.id) || data.item);
      setCreateName("");
      setCreateDescription("");
      setIsCreateDialogOpen(false);
      toast.success("角色已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建角色失败");
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingRole || isDeleting) {
      return;
    }
    setIsDeleting(true);
    try {
      const data = await deleteManagedRole(deletingRole.id);
      const nextRoles = normalizeManagedRoles(data.items);
      setRoles(nextRoles);
      applySelectedRole(nextRoles.find((role) => role.id === selectedRoleId) || nextRoles[0] || null);
      setDeletingRole(null);
      toast.success("角色已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除角色失败");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <ManagementPage data-rbac-layout>
      <div className="grid min-h-0 flex-1 gap-[var(--page-section-gap)] overflow-y-auto xl:grid-cols-[320px_minmax(0,1fr)] xl:overflow-hidden">
        <ManagementPanel className="min-h-[420px] xl:min-h-0">
            <ManagementToolbar className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="搜索角色"
                  className="h-10 rounded-lg pl-9"
                />
              </div>
            <Button
              variant="outline"
              size="icon"
              title="刷新角色权限"
              onClick={() => void loadRBAC()}
              disabled={isLoading || isDirty}
              className="size-10 rounded-lg"
            >
              <RefreshCw className={cn("size-4", isLoading ? "animate-spin" : "")} />
            </Button>
            <Button
              size="icon"
              title="创建角色"
              onClick={() => setIsCreateDialogOpen(true)}
              disabled={isLoading}
              className="size-10 rounded-lg"
            >
              <Plus className="size-4" />
            </Button>
            </ManagementToolbar>
            <ScrollArea className="min-h-0 flex-1">
              {isLoading ? (
                <div className="flex min-h-[320px] items-center justify-center">
                  <LoaderCircle className="size-5 animate-spin text-stone-400" />
                </div>
              ) : null}
              {!isLoading && filteredRoles.length === 0 ? (
                <EmptyState compact icon={ShieldCheck} title="暂无角色" description="创建角色后可配置菜单与功能权限" />
              ) : null}
              {!isLoading
                ? filteredRoles.map((role) => {
                    const active = role.id === selectedRoleId;
                    return (
                      <button
                        key={role.id}
                        type="button"
                        className={cn(
                          "relative block w-full border-b border-border px-5 py-4 text-left transition hover:bg-muted/50",
                          active ? "bg-primary/[0.045] before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-r before:bg-primary" : "",
                        )}
                        aria-pressed={active}
                        onClick={() => requestRoleSelection(role)}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-foreground">{role.name}</div>
                            <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{role.id}</code>
                          </div>
                          {role.builtin ? (
                            <Badge variant="secondary" className="shrink-0 rounded-md">
                              内置
                            </Badge>
                          ) : null}
                        </div>
                        {role.description ? (
                          <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{role.description}</p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{permissionCountLabel(role)}</span>
                          <span className="flex items-center gap-1">
                            <Users className="size-3.5" />
                            {role.user_count || 0}
                          </span>
                        </div>
                      </button>
                    );
                  })
                : null}
            </ScrollArea>
        </ManagementPanel>

        <ManagementPanel className="min-h-[940px] lg:min-h-[720px] xl:min-h-0">
            <ManagementToolbar className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <ShieldCheck className="size-5 shrink-0 text-[#1456f0]" />
                    <h2 className="truncate text-base font-semibold text-foreground">
                      {selectedRole?.name || "未选择角色"}
                    </h2>
                  </div>
                  <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                    {selectedRole?.id || "-"}
                  </code>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isDirty ? (
                    <Badge variant="warning" className="w-fit rounded-md">
                      未保存
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="w-fit rounded-md">
                      已同步
                    </Badge>
                  )}
                  {isDirty ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title="撤销未保存修改"
                      className="size-9 rounded-lg"
                      disabled={isSaving}
                      onClick={() => applySelectedRole(selectedRole)}
                    >
                      <Undo2 className="size-4" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title={selectedRole?.builtin ? "内置角色不能删除" : selectedRole?.user_count ? "请先解除该角色绑定的用户" : "删除角色"}
                    className="size-9 rounded-lg border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                    disabled={!selectedRole || Boolean(selectedRole.builtin) || Boolean(selectedRole.user_count)}
                    onClick={() => selectedRole ? setDeletingRole(selectedRole) : null}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                  <Button
                    onClick={() => void handleSave()}
                    disabled={!selectedRole || !isDirty || isSaving || isLoading}
                    className="h-9 rounded-lg"
                  >
                    {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                    保存
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  角色名称
                  <Input
                    value={roleName}
                    onChange={(event) => {
                      draftVersionRef.current += 1;
                      setRoleName(event.target.value);
                    }}
                    placeholder="角色名称"
                    disabled={!selectedRole || isLoading || isSaving}
                    className="h-10 rounded-lg text-foreground"
                  />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  角色说明
                  <Input
                    value={roleDescription}
                    onChange={(event) => {
                      draftVersionRef.current += 1;
                      setRoleDescription(event.target.value);
                    }}
                    placeholder="说明角色职责或适用范围"
                    disabled={!selectedRole || isLoading || isSaving}
                    className="h-10 rounded-lg text-foreground"
                  />
                </label>
              </div>
            </ManagementToolbar>
            <div className="min-h-0 flex-1 overflow-hidden">
              {isLoading ? (
                <div className="flex min-h-[420px] items-center justify-center">
                  <LoaderCircle className="size-5 animate-spin text-stone-400" />
                </div>
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
                  disabled={isSaving}
                />
              ) : (
                <EmptyState icon={ShieldCheck} title="暂无角色" description="请先创建或选择一个角色" className="min-h-[420px]" />
              )}
            </div>
        </ManagementPanel>
      </div>

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="rounded-lg p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>创建角色</DialogTitle>
            <DialogDescription className="text-sm leading-6">新角色会复制默认用户权限，创建后可继续调整。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium text-stone-700 dark:text-foreground">名称</label>
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="例如：运营人员"
              className="h-11 rounded-lg"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-stone-700 dark:text-foreground">描述</label>
            <Input
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder="角色职责或使用范围"
              className="h-11 rounded-lg"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" className="h-10 rounded-lg px-5" onClick={() => setIsCreateDialogOpen(false)} disabled={isCreating}>
              取消
            </Button>
            <Button type="button" className="h-10 rounded-lg px-5" onClick={() => void handleCreate()} disabled={isCreating}>
              {isCreating ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingRole)} onOpenChange={(open) => (!open ? setDeletingRole(null) : null)}>
        <DialogContent className="rounded-lg p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>删除角色</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              确认删除「{deletingRole?.name}」吗？只有未绑定用户的自定义角色可以删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" className="h-10 rounded-lg px-5" onClick={() => setDeletingRole(null)} disabled={isDeleting}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-10 rounded-lg px-5"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingRole)} onOpenChange={(open) => (!open ? setPendingRole(null) : null)}>
        <DialogContent className="rounded-lg p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>放弃未保存的修改？</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              当前角色的名称、说明或权限已经修改。切换到「{pendingRole?.name}」后，这些修改不会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" className="h-10 rounded-lg px-5" onClick={() => setPendingRole(null)}>
              继续编辑
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-10 rounded-lg px-5"
              onClick={() => {
                applySelectedRole(pendingRole);
                setPendingRole(null);
              }}
            >
              放弃并切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ManagementPage>
  );
}

export default function RBACPage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/rbac");
  if (isCheckingAuth || !session) {
    return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-stone-400" /></div>;
  }
  return <RBACContent key={session.key} />;
}
