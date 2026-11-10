// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/checkpoint
import { GitBranch } from "lucide-react";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Button } from "@/components/ui/button";
export function Checkpoint({
  disabled = false,
  editing = false,
  onEdit,
}: {
  disabled?: boolean;
  editing?: boolean;
  onEdit: () => void;
}) {
  return (
    <Marker data-ai-element="checkpoint" variant="separator">
      <MarkerContent className="inline-flex items-center gap-2">
        <GitBranch className="size-3.5" />
        <span>对话检查点</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={onEdit}
        >
          {editing ? "正在编辑" : "编辑并继续"}
        </Button>
      </MarkerContent>
    </Marker>
  );
}
