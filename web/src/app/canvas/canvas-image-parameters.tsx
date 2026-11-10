import { SlidersHorizontal } from "lucide-react";

import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { CanvasParameterPopover } from "@/app/canvas/canvas-parameter-popover";
import {
  buildImageSize,
  formatImageSizeDisplay,
  getImageSizeSelectionFromSize,
} from "@/lib/image-options";
import {
  ImageSettingsPanel,
  type ImageSettingsValue,
} from "@/components/generation/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { imageOutputCountLimit } from "@/lib/api";
import type { CanvasNode } from "@/services/api/canvas";

import { CanvasParameterHeader } from "@/app/canvas/canvas-parameter-header";

type CanvasImageParameterPatch = Partial<Pick<CanvasNode,
  | "generation_size"
  | "generation_resolution"
  | "generation_quality"
  | "generation_count"
  | "generation_image_options"
  | "generation_output_format"
  | "generation_output_compression"
  | "generation_stream"
  | "generation_partial_images"
  | "generation_snap_to_multiple_16"
  | "generation_model"
>>;

export function CanvasImageParameterPopover({ node, imageModel, imageModels = [], onChange, expanded = false, showModel = true, showSize = true, showCount = true }: { node: CanvasNode; imageModel: string; imageModels?: string[]; onChange: (patch: CanvasImageParameterPatch) => void; expanded?: boolean; showModel?: boolean; showSize?: boolean; showCount?: boolean }) {
  const defaults = defaultCanvasImageParameters();
  const size = node.generation_size ?? defaults.generation_size ?? "";
  const selection = getImageSizeSelectionFromSize(
    size,
    node.generation_resolution ?? defaults.generation_resolution,
  );
  const quality = node.generation_quality ?? defaults.generation_quality ?? "";
  const selectedModel = node.generation_model?.trim() || imageModel;
  const modelOptions = Array.from(new Set(imageModels.map((model) => model.trim()).filter(Boolean)));
  const countLimit = imageOutputCountLimit(selectedModel);
  const count = Math.max(1, Math.min(countLimit, node.generation_count ?? defaults.generation_count ?? 1));
  const snapToMultiple16 = node.generation_snap_to_multiple_16 ?? defaults.generation_snap_to_multiple_16 ?? true;
  const calculatedSize = buildImageSize(selection, { snapToMultiple16 });
  const sizeLabel = selection.mode !== "auto" && calculatedSize ? formatImageSizeDisplay(calculatedSize) : "自动";

  const settingsValue: ImageSettingsValue = {
    ...selection,
    snapToMultiple16,
    quality,
    imageOptions: node.generation_image_options,
    outputFormat: node.generation_output_format || "png",
    count,
  };

  function updateSettings(patch: Partial<ImageSettingsValue>) {
    const next = { ...settingsValue, ...patch };
    const editingCustomDimension = "customWidth" in patch || "customHeight" in patch;
    const nextSize = buildImageSize(next, {
      // Keep the input stable while typing; DimensionInput applies alignment
      // on blur, matching the creation workbench behavior.
      snapToMultiple16: editingCustomDimension ? false : next.snapToMultiple16,
    });
    onChange({
      generation_size: next.mode === "auto" ? "" : nextSize,
      generation_resolution: next.resolution,
      generation_quality: next.quality || undefined,
      generation_image_options: next.imageOptions,
      generation_output_format: next.outputFormat,
      generation_count: next.count,
      generation_snap_to_multiple_16: next.snapToMultiple16,
    });
  }

  const parameterFields = (
    <div className="flex flex-col gap-3.5">
      {showModel ? <section className="order-0 space-y-1.5">
        <ImageParameterLabel help="选择当前图片节点使用的生成模型。">模型</ImageParameterLabel>
        <ModelPicker label="图片生成模型" value={selectedModel} options={modelOptions} onValueChange={(value) => onChange({ generation_model: value })} />
      </section> : null}
      <ImageSettingsPanel model={selectedModel} value={settingsValue} onChange={updateSettings} showSize={showSize} showCount={showCount} />
    </div>
  );

  if (expanded) {
    return (
      <section className="space-y-3 border-t border-border/80 pt-3">
        <div className="flex items-center justify-between gap-3">
          <CanvasParameterHeader summary={`${showSize ? `${sizeLabel} · ` : ""}${count} 张`} />
        </div>
        {parameterFields}
      </section>
    );
  }

  return (
    <CanvasParameterPopover
      icon={<SlidersHorizontal />}
      label="图片参数"
      width={360}
      summary={<>{showSize ? <>{sizeLabel} · </> : null}{count} 张</>}
    >
      {parameterFields}
    </CanvasParameterPopover>
  );
}
