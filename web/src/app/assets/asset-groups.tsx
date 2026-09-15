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
    toast.success(dialog === "delete" ? "标签已删除，素材已保留" : dialog === "create" ? "标签已创建" : "标签已重命名");
    setDialog(null);
  }

  return <>
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5" data-asset-group-toolbar>
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <Select value={filter} onValueChange={onFilterChange} disabled={disabled}>
        <SelectTrigger className="h-9 w-[180px] max-w-full" aria-label="筛选素材标签"><SelectValue placeholder="素材标签" /></SelectTrigger>
        <SelectContent><SelectItem value="all">全部标签</SelectItem><SelectItem value="ungrouped">未标签</SelectItem>{state.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}（{group.assetKeys.filter((key) => availableKeys.has(key)).length}）</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="ghost" size="icon" className="size-9" disabled={disabled} aria-label="新建标签" title="新建标签" onClick={() => { setName(""); setCreatingKeys([...selectedKeys]); setDialog("create"); }}><FolderPlus className="size-4" /></Button>
      {current ? <><Button variant="ghost" size="icon" className="size-9" disabled={disabled} aria-label="重命名标签" title="重命名标签" onClick={() => { setGroupID(current.id); setName(current.name); setDialog("rename"); }}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" className="size-9" disabled={disabled} aria-label="删除标签" title="删除标签" onClick={() => { setGroupID(current.id); setDialog("delete"); }}><Trash2 className="size-4" /></Button></> : null}
      {state.loading ? <span className="text-xs text-muted-foreground">正在加载标签...</span> : state.error ? <div role="alert" className="flex min-w-0 items-center gap-2 text-xs text-destructive"><span className="break-words">标签读取失败</span><Button variant="ghost" size="icon" className="size-9" title="重试读取标签" aria-label="重试读取标签" onClick={state.reload}><RefreshCw className="size-4" /></Button></div> : null}
      {selectedKeys.length > 0 ? <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <Select value="" disabled={disabled || !state.groups.length} onValueChange={async (id) => { if (await state.mutate("PATCH", { id, add: selectedKeys })) toast.success(`已添加 ${selectedKeys.length} 个素材到标签`); }}>
          <SelectTrigger className="h-9 w-[160px]" aria-label="将所选素材添加到标签"><SelectValue placeholder="添加到标签" /></SelectTrigger>
          <SelectContent>{state.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent>
        </Select>
        {current ? <Button variant="outline" size="sm" className="h-9" disabled={disabled || !selectedKeys.some((key) => current.assetKeys.includes(key))} onClick={async () => { if (await state.mutate("PATCH", { id: current.id, remove: selectedKeys })) toast.success("已从标签移出所选素材"); }}>移出标签</Button> : null}
      </div> : null}
    </div>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !state.busy) setDialog(null); }}>
      <DialogContent className="w-[min(92vw,420px)]">
        <DialogHeader><DialogTitle>{dialog === "create" ? "新建标签" : dialog === "rename" ? "重命名标签" : "删除标签？"}</DialogTitle><DialogDescription className={dialog === "rename" ? "sr-only" : ""}>{dialog === "delete" ? `确定删除“${target?.name}”？标签中的素材会保留。` : dialog === "create" ? `已选择 ${creatingKeys.length} 个素材` : "标签名称"}</DialogDescription></DialogHeader>
        {dialog !== "delete" ? <form id="asset-group-form" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !disabled) void save(); }}><label className="grid gap-2 text-sm">标签名称<Input value={name} maxLength={80} disabled={state.busy} onChange={(event) => setName(event.target.value)} placeholder="输入标签名称" /></label></form> : null}
        <DialogFooter><Button variant="outline" disabled={state.busy} onClick={() => setDialog(null)}>取消</Button><Button variant={dialog === "delete" ? "destructive" : "default"} disabled={disabled || (dialog !== "delete" && !name.trim())} type={dialog === "delete" ? "button" : "submit"} form={dialog === "delete" ? undefined : "asset-group-form"} onClick={dialog === "delete" ? () => void save() : undefined}>{state.busy ? "保存中..." : dialog === "delete" ? "删除标签" : "保存"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
