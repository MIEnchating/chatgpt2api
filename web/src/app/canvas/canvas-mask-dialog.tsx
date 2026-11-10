import { ModelPicker } from "@/components/model-picker";
import { LabeledField } from "@/components/labeled-field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ItemMedia } from "@/components/ui/item";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Brush, Eraser, RotateCcw, WandSparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { PromptInput } from "@/components/ai-elements/prompt-input";
import { useEditableImageSource } from "@/components/use-editable-image-source";
import { EditableImageFrame } from "@/components/editable-image-frame";

export type CanvasMaskEditPayload = { prompt: string; markedDataURL: string; model: string };

export function CanvasMaskDialog({ sourceURL, open, busy, model, models, onModelChange, onClose, onConfirm }: {
  sourceURL: string;
  open: boolean;
  busy: boolean;
  model: string;
  models: string[];
  onModelChange: (model: string) => void;
  onClose: () => void;
  onConfirm: (payload: CanvasMaskEditPayload) => void | Promise<void>;
}) {
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const brushCursorRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
  const source = useEditableImageSource(sourceURL, open);
  const dimensions = source;
  const [prompt, setPrompt] = useState("");
  const [brushSize, setBrushSize] = useState(100);
  const [mode, setMode] = useState<"paint" | "erase">("paint");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;
  const modelOptions = Array.from(new Set(models.map((value) => value.trim()).filter(Boolean)));
  const modelAvailable = modelOptions.includes(model.trim());
  useEffect(() => { if (open) { setPrompt(""); setBrushSize(100); setMode("paint"); setError(""); setSubmitting(false); } }, [open, sourceURL]);
  useEffect(() => {
    drawingRef.current = { active: false, last: null };
    clearCanvas(maskRef.current);
    clearCanvas(previewRef.current);
  }, [source.url]);
  const preparedURL = source.url;
  const imageReady = Boolean(preparedURL);
  function hideBrushCursor() {
    if (brushCursorRef.current) brushCursorRef.current.hidden = true;
  }
  function updateBrushCursor(event: ReactPointerEvent<HTMLCanvasElement>) {
    const cursor = brushCursorRef.current;
    if (!cursor) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    cursor.hidden = disabled || event.pointerType === "touch" || x < 0 || y < 0 || x > rect.width || y > rect.height;
    cursor.style.width = `${brushSize * rect.width / dimensions.width}px`;
    cursor.style.height = `${brushSize * rect.height / dimensions.height}px`;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
  }
  function draw(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = maskRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const point = canvasPoint(event.currentTarget, event.clientX, event.clientY);
    context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = brushSize; context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out"; context.strokeStyle = "#000"; context.fillStyle = "#000";
    const previous = drawingRef.current.last || point; maskStroke(context, previous, point, brushSize); drawingRef.current.last = point; renderMask(canvas, previewRef.current); if (mode === "paint") setError("");
  }
  function startDraw(event: ReactPointerEvent<HTMLCanvasElement>) { if (disabled || event.button !== 0) return; event.preventDefault(); updateBrushCursor(event); event.currentTarget.setPointerCapture(event.pointerId); drawingRef.current = { active: true, last: null }; draw(event); }
  function stopDraw() { drawingRef.current = { active: false, last: null }; if (maskRef.current) renderMask(maskRef.current, previewRef.current, true); }
  async function submit() {
    const canvas = maskRef.current;
    if (!imageReady) return;
    if (!prompt.trim()) return setError("请输入修改要求");
    if (!canvas || !hasMask(canvas)) return setError("请先涂抹局部区域");
    if (!modelAvailable) return setError("请选择全局模型设置中已启用的图片模型");
    setSubmitting(true);
    try {
      await onConfirm({ prompt: prompt.trim(), markedDataURL: await buildMarkedReference(preparedURL, canvas), model: model.trim() });
    } catch (error) {
      setError(error instanceof Error ? error.message : "局部编辑失败");
    } finally {
      setSubmitting(false);
    }
  }
  if (!sourceURL) return null;
  return (
    <Dialog open={open} onOpenChange={(value) => !value && !disabled && onClose()}>
      <DialogContent className="w-[min(96vw,1040px)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center"><ItemMedia variant="icon" className="flex size-8 items-center justify-center"><WandSparkles className="size-4" /></ItemMedia>局部重绘</DialogTitle>
          <DialogDescription>涂抹选中区域，再描述你想要的变化。</DialogDescription>
        </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(360px,1fr)_280px]">
          <Card className="min-w-0 overflow-hidden gap-0 p-0">
            <div className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-card/70 p-3">
            <div role="group" aria-label="蒙版工具" className="grid shrink-0 grid-cols-2 gap-1 p-1">
              <Toggle type="button" size="sm"  disabled={!imageReady || disabled} pressed={mode === "paint"}  onClick={() => setMode("paint")}><Brush  />画笔</Toggle>
              <Toggle type="button" size="sm"  disabled={!imageReady || disabled} pressed={mode === "erase"}  onClick={() => setMode("erase")}><Eraser  />擦除</Toggle>
            </div>
            <LabeledField className="min-w-32 flex-1 gap-1 text-sm" label="笔刷大小" meta={`${brushSize} px`}>{(fieldId) => <><Slider id={fieldId} min={8} max={160} step={2} value={[brushSize]} disabled={!imageReady || disabled} onValueChange={([nextValue]) => setBrushSize(Number(String(nextValue)))} aria-label="笔刷大小" /></>}</LabeledField>
            </div>
          <EditableImageFrame source={source} className="h-[min(38dvh,320px)] sm:h-[min(56dvh,500px)]" loadingHint="可以先填写修改要求">
            {preparedURL ? (
              <div className="relative inline-block max-w-full overflow-hidden rounded-lg">
                <img
                  key={preparedURL}
                  src={preparedURL}
                  alt="待局部修改的原图"
                  className="block max-h-[min(38dvh,320px)] max-w-full sm:max-h-[min(56dvh,500px)]"
                  draggable={false}
                />
                {imageReady ? <>
                  <canvas ref={maskRef} width={dimensions.width} height={dimensions.height} className="hidden" />
                  <canvas
                    ref={previewRef}
                    width={dimensions.width}
                    height={dimensions.height}
                    className={`absolute inset-0 size-full touch-none ${disabled ? "cursor-wait" : "cursor-none"}`}
                    onPointerEnter={updateBrushCursor}
                    onPointerDown={startDraw}
                    onPointerMove={(event) => { updateBrushCursor(event); if (drawingRef.current.active && !disabled) draw(event); }}
                    onPointerLeave={hideBrushCursor}
                    onPointerUp={stopDraw}
                    onPointerCancel={() => { stopDraw(); hideBrushCursor(); }}
                    onLostPointerCapture={stopDraw}
                  />
                  <div
                    ref={brushCursorRef}
                    hidden
                    aria-hidden="true"
                    data-brush-mode={mode}
                    className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border shadow-[0_0_0_1px_rgba(0,0,0,0.65)] ${mode === "paint" ? "border-white bg-blue-500/15" : "border-dashed border-white bg-transparent"}`}
                  />
                </> : null}
              </div>
            ) : null}
          </EditableImageFrame>
            <p className="flex items-center gap-2 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground"><span className="size-2 rounded-full bg-blue-500/70" />蓝色仅标记需要修改的区域</p>
          </Card>
          <Card className="flex min-w-0 flex-col gap-4 p-4">
            <LabeledField className="flex min-h-0 flex-1 flex-col gap-2 text-sm" label={<span className="font-medium">修改要求</span>}>{(fieldId) => <PromptInput className="min-h-32 flex-1"><InputGroupTextarea id={fieldId} value={prompt} disabled={disabled} onChange={(event) => { setPrompt(event.target.value); setError(""); }} placeholder="例如：把选中区域改成金属材质，保持原图光影" className="min-h-32 flex-1 resize-none" /></PromptInput>}</LabeledField>
            <LabeledField label="模型">{(fieldId) => <ModelPicker id={fieldId} label="局部重绘模型" value={model} options={modelOptions} disabled={disabled} onValueChange={onModelChange} />}</LabeledField>
            {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
            <Button type="button" variant="ghost" size="sm" className="self-start" disabled={disabled || !imageReady} onClick={() => { clearCanvas(maskRef.current); clearCanvas(previewRef.current); setError(""); }}><RotateCcw  />重置蒙版</Button>
          </Card>
        </div>
        </ScrollArea><DialogFooter className="flex-row justify-end">
          <Button type="button" variant="outline" disabled={disabled} onClick={onClose}><X />取消</Button>
          <Button type="button" disabled={disabled || !imageReady || !modelAvailable} onClick={() => void submit()}>{disabled ? "处理中" : <><WandSparkles />AI 修改</>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function clearCanvas(canvas: HTMLCanvasElement | null) { const context = canvas?.getContext("2d"); if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height); }
function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) { const rect = canvas.getBoundingClientRect(); return { x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width, y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height }; }
function maskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) { context.beginPath(); if (from.x === to.x && from.y === to.y) { context.arc(to.x, to.y, size / 2, 0, Math.PI * 2); context.fill(); } else { context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); } }
function hasMask(canvas: HTMLCanvasElement) { const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data; if (!data) return false; for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return true; return false; }
const MASK_FILL_COLOR = "rgba(37, 99, 235, .38)";
const MASK_BORDER_COLOR = "rgba(255, 255, 255, .72)";

function renderMask(mask: HTMLCanvasElement, preview: HTMLCanvasElement | null, border = false) {
  const context = preview?.getContext("2d");
  if (!preview || !context) return;
  context.clearRect(0, 0, preview.width, preview.height);
  context.fillStyle = MASK_FILL_COLOR;
  context.fillRect(0, 0, preview.width, preview.height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(mask, 0, 0);
  context.globalCompositeOperation = "source-over";
  if (border) drawDashedMaskBorder(context, mask);
}

function drawDashedMaskBorder(context: CanvasRenderingContext2D, mask: HTMLCanvasElement) {
  const maskContext = mask.getContext("2d");
  if (!maskContext) return;
  const { width, height } = mask;
  const data = maskContext.getImageData(0, 0, width, height).data;
  const step = Math.max(1, Math.round(Math.max(width, height) / 1200));
  const dash = step * 8;
  const period = dash + step * 5;
  context.save();
  context.fillStyle = MASK_BORDER_COLOR;
  context.shadowColor = "rgba(0, 0, 0, .24)";
  context.shadowBlur = step * 1.5;
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const offset = (y * width + x) * 4 + 3;
      if (data[offset] === 0 || !isMaskEdge(data, width, x, y, step) || (x + y) % period > dash) continue;
      context.fillRect(x - step / 2, y - step / 2, Math.max(1.5, step), Math.max(1.5, step));
    }
  }
  context.restore();
}

function isMaskEdge(data: Uint8ClampedArray, width: number, x: number, y: number, step: number) {
  return data[((y - step) * width + x) * 4 + 3] === 0
    || data[((y + step) * width + x) * 4 + 3] === 0
    || data[(y * width + x - step) * 4 + 3] === 0
    || data[(y * width + x + step) * 4 + 3] === 0;
}

async function buildMarkedReference(sourceURL: string, selection: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = selection.width;
  canvas.height = selection.height;
  const context = canvas.getContext("2d");
  if (!context) return selection.toDataURL("image/png");
  const image = await loadCanvasImage(sourceURL);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.fillStyle = MASK_FILL_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(selection, 0, 0);
  context.globalCompositeOperation = "destination-over";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

function loadCanvasImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("读取图片失败"));
    image.src = src;
  });
}
