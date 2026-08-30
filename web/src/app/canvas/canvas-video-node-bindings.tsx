import type { CanvasConfigInput } from "./canvas-config-inputs";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supportsVideoFrameReferences } from "@/lib/video-model-capabilities";
import type { CanvasNode } from "@/services/api/canvas";

const EMPTY_NODE_ID = "__none__";

export function CanvasVideoNodeBindings({ node, inputs, firstFrameDisabled = false, lastFrameDisabled = false, showFirstFrame = true, showLastFrame = true, onChange }: {
  node: CanvasNode;
  inputs: readonly CanvasConfigInput[];
  firstFrameDisabled?: boolean;
  lastFrameDisabled?: boolean;
  showFirstFrame?: boolean;
  showLastFrame?: boolean;
  onChange: (patch: Partial<CanvasNode>) => void;
}) {
  const model = node.generation_video_model || "";
  const imageInputs = inputs.filter((input) => input.type === "image" && input.url);

  return (
    <div className="space-y-3 rounded-xl border border-border/80 bg-muted/15 p-3">
      <label className="flex items-center justify-between gap-3 text-xs">
        <span>排除上游文本</span>
        <Checkbox checked={Boolean(node.exclude_upstream_text)} onCheckedChange={(checked) => onChange({ exclude_upstream_text: checked === true })} />
      </label>

      {supportsVideoFrameReferences(model) && (showFirstFrame || showLastFrame) ? (
        <div className={showFirstFrame && showLastFrame ? "grid grid-cols-2 gap-2" : "grid grid-cols-1 gap-2"}>
          {showFirstFrame ? <NodeSelect label="首帧" value={node.generation_video_first_frame_node_id || ""} inputs={imageInputs} disabled={firstFrameDisabled} onChange={(nodeID) => onChange({ generation_video_first_frame_node_id: nodeID || undefined })} /> : null}
          {showLastFrame ? <NodeSelect label="尾帧" value={node.generation_video_last_frame_node_id || ""} inputs={imageInputs} disabled={lastFrameDisabled} onChange={(nodeID) => onChange({ generation_video_last_frame_node_id: nodeID || undefined })} /> : null}
        </div>
      ) : null}

    </div>
  );
}

function NodeSelect({ label, value, inputs, disabled, onChange }: {
  label: string;
  value: string;
  inputs: readonly CanvasConfigInput[];
  disabled: boolean;
  onChange: (nodeID: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <Select value={value || EMPTY_NODE_ID} disabled={disabled} onValueChange={(next) => onChange(next === EMPTY_NODE_ID ? "" : next)}>
        <SelectTrigger className="h-9 min-w-0 px-2 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={EMPTY_NODE_ID}>不指定</SelectItem>
          {inputs.map((input) => <SelectItem key={input.nodeID} value={input.nodeID}>{input.title}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}
