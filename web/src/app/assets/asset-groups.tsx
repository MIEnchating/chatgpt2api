import { LabeledField } from "@/components/labeled-field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useId, useState } from "react";
import { ChevronDown, FolderMinus, FolderPlus, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, Tags } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createMyAssetId } from "@/lib/my-assets-core";
import type { AssetGroup } from "@/lib/asset-groups";
import type { useAssetGroups } from "@/lib/use-asset-groups";

export function AssetGroupMenu({
  state,
  filter,
  onFilterChange,
  selectedKeys,
  availableKeys,
  group,
}: {
  state: ReturnType<typeof useAssetGroups>;
  filter: string;
  onFilterChange: (value: string) => void;
  selectedKeys: string[];
  availableKeys: Set<string>;
  group?: AssetGroup;
}) {
  const formID = useId();
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
    if (dialog === "create") onFilterChange(id);
    else if (dialog === "delete" && filter === id) onFilterChange("all");
    toast.success(dialog === "delete" ? "标签已删除，素材已保留" : dialog === "create" ? "标签已创建" : "标签已重命名");
    setDialog(null);
  }

  return (
    <>
      {selectedKeys.length > 0 ? (
        <>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setName("");
              setCreatingKeys([...selectedKeys]);
              setDialog("create");
            }}
          >
            <FolderPlus />
            新建标签
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={disabled || !state.groups.length}>
                <Tags />
                添加到标签
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
              {state.groups.map((group) => (
                <DropdownMenuItem
                  key={group.id}
                  disabled={disabled}
                  onSelect={() => {
                    void state.mutate("PATCH", { id: group.id, add: selectedKeys }).then((ok) => {
                      if (ok) toast.success(`已添加 ${selectedKeys.length} 个素材到标签`);
                    });
                  }}
                >
                  <span className="min-w-0 flex-1 break-words">{group.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {group.assetKeys.filter((key) => availableKeys.has(key)).length}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {current ? (
            <Button
              variant="outline"
              disabled={disabled || !selectedKeys.some((key) => current.assetKeys.includes(key))}
              onClick={() => {
                void state.mutate("PATCH", { id: current.id, remove: selectedKeys }).then((ok) => {
                  if (ok) toast.success("已从标签移出所选素材");
                });
              }}
            >
              <FolderMinus />
              移出当前标签
            </Button>
          ) : null}
          {state.error ? (
            <Button variant="outline" disabled={state.loading || state.busy} onClick={state.reload}>
              <RefreshCw />
              重试读取标签
            </Button>
          ) : null}
        </>
      ) : group ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={`标签“${group.name}”的操作`}
              disabled={state.loading || state.busy}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48" data-asset-group-toolbar>
            <DropdownMenuItem
              disabled={disabled}
              onSelect={() => {
                setGroupID(group.id);
                setName(group.name);
                setDialog("rename");
              }}
            >
              <Pencil />
              重命名标签
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={disabled}
              onSelect={() => {
                setGroupID(group.id);
                setDialog("delete");
              }}
            >
              <Trash2 />
              删除标签
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="新建标签"
          disabled={disabled}
          onClick={() => {
            setName("");
            setCreatingKeys([]);
            setDialog("create");
          }}
        >
          <Plus />
        </Button>
      )}
      <ConfirmDialog
        open={dialog === "delete"}
        title={`删除标签“${target?.name ?? ""}”？`}
        description="仅删除这个标签，所有素材和其他标签都会保留。"
        confirmLabel="删除此标签"
        destructive
        busy={state.busy}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        onConfirm={() => { if (!disabled && target) void save(); }}
      />
      <Dialog
        open={dialog === "create" || dialog === "rename"}
        onOpenChange={(open) => {
          if (!open && !state.busy) setDialog(null);
        }}
      >
        <DialogContent className="w-[min(92vw,420px)] sm:max-w-none">
          <DialogHeader>
            <DialogTitle>
              {dialog === "create" ? "新建标签" : "重命名标签"}
            </DialogTitle>
            <DialogDescription className={dialog === "rename" ? "sr-only" : undefined}>
              {dialog === "create"
                  ? `已选择 ${creatingKeys.length} 个素材`
                  : "标签名称"}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
            <form
              id={formID}
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim() && !disabled) void save();
              }}
            >
              <LabeledField className="grid gap-2 text-sm" label="标签名称">{(fieldId) => <><Input id={fieldId}
                  value={name}
                  maxLength={80}
                  disabled={state.busy}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="输入标签名称"
                /></>}</LabeledField>
            </form>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" disabled={state.busy} onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              disabled={disabled || !name.trim()}
              type="submit"
              form={formID}
            >
              {state.busy ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
