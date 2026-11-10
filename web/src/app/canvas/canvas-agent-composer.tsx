import { Spinner } from "@/components/ui/spinner";
import { useRef } from "react";
import { FolderOpen, Plus, Upload } from "lucide-react";
import { InputGroupButton } from "@/components/ui/input-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TooltipHint } from "@/components/ui/tooltip";

export function CanvasAgentAssetMenu({ disabled, uploading = false, onUpload, onOpenAssets }: {
  disabled: boolean;
  uploading?: boolean;
  onUpload: () => void;
  onOpenAssets: () => void;
}) {
  const actionSelectedRef = useRef(false);
  return <DropdownMenu onOpenChange={(open) => { if (open) actionSelectedRef.current = false; }}>
    <TooltipHint content={"添加素材"}><span className="inline-flex shrink-0"><DropdownMenuTrigger asChild><InputGroupButton type="button" size="icon-sm" variant="outline" className="shrink-0" aria-label="添加 Agent 素材" disabled={disabled}><Plus /></InputGroupButton></DropdownMenuTrigger></span></TooltipHint>
    <DropdownMenuContent side="top" align="start" className="w-40" onCloseAutoFocus={(event) => { if (actionSelectedRef.current) event.preventDefault(); }}>
      <DropdownMenuItem disabled={disabled || uploading} onSelect={() => { actionSelectedRef.current = true; onUpload(); }}>{uploading ? <Spinner aria-hidden="true" /> : <Upload />}上传文件</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => { actionSelectedRef.current = true; onOpenAssets(); }}><FolderOpen />我的素材</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
