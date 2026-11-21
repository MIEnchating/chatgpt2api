import { ModelPicker } from "@/components/model-picker";
import { Settings2 } from "lucide-react";
import { isWorkflowModelConfigured } from "@/app/workflows/workflow-runtime";
import { FieldSet } from "@/components/ui/field";
import { ImageSettingsPanel, type ImageSettingsValue } from "@/components/generation/image-settings-panel";
import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import type { ModelConfig } from "@/lib/api";
import { cn } from "@/lib/utils";
import { configuredModelNames } from "@/lib/model-config-selection";

export function WorkflowImageSettings({
  models,
  model,
  value,
  className,
  readOnly = false,
  showHeading = true,
  onModelChange,
  onChange,
}: {
  models: ModelConfig | null;
  model: string;
  value: ImageSettingsValue;
  className?: string;
  readOnly?: boolean;
  showHeading?: boolean;
  onModelChange?: (model: string) => void;
  onChange?: (patch: Partial<ImageSettingsValue>) => void;
}) {
  const modelOptions = configuredModelNames(models?.image_models);
  const modelAvailable = isWorkflowModelConfigured(model, modelOptions);
  return (
    <section data-workbench-generation-settings data-read-only={readOnly || undefined} className={cn("space-y-3", className)}>
      {showHeading ? (
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Settings2 className="size-4" />
          创作参数
        </h3>
      ) : null}
      <div className="space-y-1.5">
        <ImageParameterLabel>图片模型</ImageParameterLabel>
        <ModelPicker label="图片模型" value={model} options={modelOptions} disabled={readOnly} onValueChange={(next) => onModelChange?.(next)} />
      </div>
      <FieldSet disabled={readOnly || !modelAvailable} className={cn(readOnly && "[&_button]:cursor-default [&_input]:cursor-default")}>
        <ImageSettingsPanel disabled={readOnly || !modelAvailable} model={model} value={value} showSnapToMultiple16={false} onChange={(patch) => onChange?.(patch)} />
      </FieldSet>
    </section>
  );
}
