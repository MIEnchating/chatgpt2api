import { Camera } from "lucide-react";

import {
  APERTURES,
  APERTURE_META,
  CAMERA_PROFILES,
  DEFAULT_CAMERA_CONTROL,
  FOCAL_LENGTHS,
  FOCAL_LENGTH_META,
  LENS_PROFILES,
  type CanvasCameraControlOptions,
} from "@/app/canvas/canvas-camera";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";
import type { CanvasNode } from "@/services/api/canvas";
import { cn } from "@/lib/utils";

export function CanvasCameraControl({
  value,
  onChange,
  className,
}: {
  value?: CanvasNode["camera_control"];
  onChange: (value: CanvasCameraControlOptions) => void;
  className?: string;
}) {
  const control = { ...DEFAULT_CAMERA_CONTROL, ...value };
  const update = (patch: Partial<CanvasCameraControlOptions>) => onChange({ ...control, ...patch });
  const focalMeta = FOCAL_LENGTH_META[control.focal_length];
  const apertureMeta = APERTURE_META[control.aperture];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("justify-start", value?.enabled && "border-brand text-brand", className)}
        >
          <Camera />摄像机
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="max-h-[min(80dvh,var(--radix-popover-content-available-height))] w-[min(680px,calc(100vw-1rem))] overflow-y-auto p-4">
        <div className="mb-4 flex items-start justify-between gap-4 border-b border-border pb-3">
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold">摄像机控制</h3>
            <p className="text-xs leading-5 text-muted-foreground">选择相机与镜头，启用后将这些参数加入生成提示词。</p>
          </div>
          <Switch className="mt-1 shrink-0" checked={control.enabled} aria-label="摄像机控制" onCheckedChange={(enabled) => update({ enabled })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <CameraSelect
            label="相机"
            value={control.camera}
            onChange={(camera) => update({ camera })}
            options={CAMERA_PROFILES.map((profile) => ({
              value: profile.id,
              label: `${profile.zhName} · ${profile.label}`,
              title: `${profile.description} 使用场景：${profile.useCase}`,
            }))}
          />
          <CameraSelect
            label="镜头"
            value={control.lens}
            onChange={(lens) => update({ lens })}
            options={LENS_PROFILES.map((profile) => ({
              value: profile.id,
              label: `${profile.zhName} · ${profile.label}`,
              title: `${profile.description} 使用场景：${profile.useCase}`,
            }))}
          />
          <CameraSelect
            label="焦距"
            value={String(control.focal_length)}
            onChange={(value) => update({ focal_length: Number(value) })}
            options={FOCAL_LENGTHS.map((value) => ({
              value: String(value),
              label: `${value}mm · ${FOCAL_LENGTH_META[value].zhName}`,
              title: `${FOCAL_LENGTH_META[value].description} 使用场景：${FOCAL_LENGTH_META[value].useCase}`,
            }))}
          />
          <CameraSelect
            label="光圈"
            value={String(control.aperture)}
            onChange={(value) => update({ aperture: Number(value) })}
            options={APERTURES.map((value) => ({
              value: String(value),
              label: `f/${value} · ${APERTURE_META[value].zhName}`,
              title: `${APERTURE_META[value].description} 使用场景：${APERTURE_META[value].useCase}`,
            }))}
          />
        </div>
        <div className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground" aria-live="polite">
          {control.enabled ? "已启用" : "未启用"} · {focalMeta?.zhName} · {apertureMeta?.zhName}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CameraSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; title: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option.value} value={option.value}><TooltipHint content={option.title}><span className="block w-full">{option.label}</span></TooltipHint></SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}
