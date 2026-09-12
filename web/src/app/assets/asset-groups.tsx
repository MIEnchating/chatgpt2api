import { useState } from "react";
import { Folder, FolderPlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createMyAssetId } from "@/lib/my-assets-core";
import type { useAssetGroups } from "@/lib/use-asset-groups";

export function AssetGroupToolbar({ state, filter, onFilterChange, selectedKeys, availableKeys }: {
  state: ReturnType<typeof useAssetGroups>;
  filter: string;
  onFilterChange: (value: string) => void;
  selectedKeys: string[];
  availableKeys: Set<string>;
}) {
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [groupID, setGroupID] = useState("");
  const [creatingKeys, setCreatingKeys] = useState<string[]>([]);
  const current = state.groups.find((group) => group.id === filter);
  const target = state.groups.find((group) => group.id === groupID);
  const disabled = state.loading || state.busy || Boolean(state.error);

  async function save() {
    const id = dialog === "create" ? createMyAssetId() : groupID;
    const ok = await state.mutate(dialog === "create" ? "POST" : dialog === "delete" ? "DELETE" : "PATCH", {
      id,
      ...(dialog !== "delete" ? { name: name.trim() } : {}),
      ...(dialog === "create" ? { add: creatingKeys } : {}),
    });
    if (!ok) return;
    onFilterChange(dialog === "delete" ? "all" : id);
    toast.success(dialog === "delete" ? "分组已删除，素材已保留" : dialog === "create" ? "分组已创建" : "分组已重命名");
    setDialog(null);
  }

  return <>
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3 sm:px-8" data-asset-group-toolbar>
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <Select value={filter} onValueChange={onFilterChange} disabled={disabled}>
        <SelectTrigger className="h-8 w-[180px] max-w-full" aria-label="筛选素材分组"><SelectValue placeholder="素材分组" /></SelectTrigger>
        <SelectContent><SelectItem value="all">全部分组</SelectItem><SelectItem value="ungrouped">未分组</SelectItem>{state.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}（{group.assetKeys.filter((key) => availableKeys.has(key)).length}）</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="ghost" size="icon" className="size-8" disabled={disabled} aria-label="新建分组" title="新建分组" onClick={() => { setName(""); setCreatingKeys([...selectedKeys]); setDialog("create"); }}><FolderPlus className="size-4" /></Button>
      {current ? <><Button variant="ghost" size="icon" className="size-8" disabled={disabled} aria-label="重命名分组" title="重命名分组" onClick={() => { setGroupID(current.id); setName(current.name); setDialog("rename"); }}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8" disabled={disabled} aria-label="删除分组" title="删除分组" onClick={() => { setGroupID(current.id); setDialog("delete"); }}><Trash2 className="size-4" /></Button></> : null}
      {state.loading ? <span className="text-xs text-muted-foreground">正在加载分组...</span> : state.error ? <div role="alert" className="flex min-w-0 items-center gap-2 text-xs text-destructive"><span className="break-words">分组读取失败</span><Button variant="ghost" size="icon" className="size-8" title="重试读取分组" aria-label="重试读取分组" onClick={state.reload}><RefreshCw className="size-4" /></Button></div> : null}
      {selectedKeys.length > 0 ? <div className="ml-auto flex flex-wrap items-center gap-2">
        <Select value="" disabled={disabled || !state.groups.length} onValueChange={async (id) => { if (await state.mutate("PATCH", { id, add: selectedKeys })) toast.success(`已添加 ${selectedKeys.length} 个素材到分组`); }}>
          <SelectTrigger className="h-8 w-[160px]" aria-label="将所选素材添加到分组"><SelectValue placeholder="添加到分组" /></SelectTrigger>
          <SelectContent>{state.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent>
        </Select>
        {current ? <Button variant="outline" size="sm" className="h-8" disabled={disabled || !selectedKeys.some((key) => current.assetKeys.includes(key))} onClick={async () => { if (await state.mutate("PATCH", { id: current.id, remove: selectedKeys })) toast.success("已从分组移出所选素材"); }}>移出分组</Button> : null}
      </div> : null}
    </div>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !state.busy) setDialog(null); }}>
      <DialogContent className="w-[min(92vw,420px)]">
        <DialogHeader><DialogTitle>{dialog === "create" ? "新建分组" : dialog === "rename" ? "重命名分组" : "删除分组？"}</DialogTitle><DialogDescription className={dialog === "rename" ? "sr-only" : ""}>{dialog === "delete" ? `确定删除“${target?.name}”？分组中的素材会保留。` : dialog === "create" ? `已选择 ${creatingKeys.length} 个素材` : "分组名称"}</DialogDescription></DialogHeader>
        {dialog !== "delete" ? <form id="asset-group-form" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !disabled) void save(); }}><label className="grid gap-2 text-sm">分组名称<Input value={name} maxLength={80} disabled={state.busy} onChange={(event) => setName(event.target.value)} placeholder="输入分组名称" /></label></form> : null}
        <DialogFooter><Button variant="outline" disabled={state.busy} onClick={() => setDialog(null)}>取消</Button><Button variant={dialog === "delete" ? "destructive" : "default"} disabled={disabled || (dialog !== "delete" && !name.trim())} type={dialog === "delete" ? "button" : "submit"} form={dialog === "delete" ? undefined : "asset-group-form"} onClick={dialog === "delete" ? () => void save() : undefined}>{state.busy ? "保存中..." : dialog === "delete" ? "删除分组" : "保存"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
