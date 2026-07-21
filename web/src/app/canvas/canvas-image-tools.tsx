import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Brush, Camera, Check, Eraser, Grid2X2, ListRestart, Lock, LockOpen, PanelTop, RotateCcw, Rows3, Trash2, WandSparkles, X, ZoomIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { buildCanvasGridLines, canvasImageAngleLabel, clampCanvasGrid, CANVAS_MAX_UPSCALE_LONG_EDGE, findCanvasGridLineSpot, nextCanvasUpscaleTarget, resolveCanvasUpscaleSize, type CanvasImageAngleParams, type CanvasImageCropRect, type CanvasImageSplitParams, type CanvasImageUpscaleAlgorithm, type CanvasImageUpscaleParams } from "@/app/canvas/canvas-image-data";

const defaultCrop: CanvasImageCropRect = { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };
const cropHandles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export function CanvasCropDialog({ sourceURL, open, busy, onClose, onConfirm }: { sourceURL: string; open: boolean; busy: boolean; onClose: () => void; onConfirm: (crop: CanvasImageCropRect) => void }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [crop, setCrop] = useState(defaultCrop);
  const [locked, setLocked] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => { if (open) setCrop(defaultCrop); }, [open, sourceURL]);

  function startDrag(mode: "move" | "resize", event: ReactPointerEvent, handle = "se") {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, crop };
    const move = (nextEvent: PointerEvent) => {
      const dx = (nextEvent.clientX - start.x) / frame.width;
      const dy = (nextEvent.clientY - start.y) / frame.height;
      setCrop(mode === "move" ? moveCrop(start.crop, dx, dy) : resizeCrop(start.crop, dx, dy, handle, locked, frame));
    };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  const cropWidth = dimensions.width ? Math.round(crop.width * dimensions.width) : 0;
  const cropHeight = dimensions.height ? Math.round(crop.height * dimensions.height) : 0;
  if (!sourceURL) return null;
  return (
    <Dialog open={open && Boolean(sourceURL)} onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="w-[min(94vw,780px)]">
        <DialogHeader><DialogTitle>裁剪图片</DialogTitle><DialogDescription>拖动裁剪框选择要保留的区域。</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div ref={frameRef} className="relative mx-auto w-fit max-w-full overflow-hidden rounded-xl bg-black/90">
            <img src={sourceURL} alt="" className="block max-h-[58vh] max-w-full select-none object-contain opacity-90" draggable={false} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
            <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/55" style={{ height: `${crop.y * 100}%` }} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/55" style={{ height: `${(1 - crop.y - crop.height) * 100}%` }} />
            <div className="pointer-events-none absolute bg-black/55" style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` }} />
            <div className="pointer-events-none absolute bg-black/55" style={{ right: 0, top: `${crop.y * 100}%`, width: `${(1 - crop.x - crop.width) * 100}%`, height: `${crop.height * 100}%` }} />
            <div className="absolute cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.4)]" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => startDrag("move", event)}>
              <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/50" /><div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/50" /><div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/50" /><div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/50" />
              {cropHandles.map((handle) => <button key={handle} type="button" aria-label="调整裁剪框" className="pointer-events-auto absolute size-3 rounded-full border border-black bg-white" style={cropHandleStyle(handle)} onPointerDown={(event) => startDrag("resize", event, handle)} />)}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground"><span>裁剪尺寸：{cropWidth && cropHeight ? `${cropWidth} × ${cropHeight}` : "读取中"}</span><span>原图：{dimensions.width ? `${dimensions.width} × ${dimensions.height}` : "读取中"}</span><Button type="button" variant="outline" size="sm" onClick={() => setLocked((value) => !value)}>{locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}{locked ? "锁定比例" : "自由比例"}</Button></div>
        </div>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setCrop(defaultCrop)}><RotateCcw />重置</Button><Button type="button" variant="outline" disabled={busy} onClick={onClose}><X />取消</Button><Button type="button" disabled={busy} onClick={() => onConfirm(crop)}>{busy ? "处理中" : <><Check />确认裁剪</>}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CanvasSplitDialog({ sourceURL, open, busy, onClose, onConfirm }: { sourceURL: string; open: boolean; busy: boolean; onClose: () => void; onConfirm: (params: CanvasImageSplitParams) => void }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [horizontalLines, setHorizontalLines] = useState([0.5]);
  const [verticalLines, setVerticalLines] = useState([0.5]);
  const [activeLine, setActiveLine] = useState<{ axis: "horizontal" | "vertical"; index: number } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const rows = horizontalLines.length + 1;
  const columns = verticalLines.length + 1;

  useEffect(() => {
    if (!open) return;
    setHorizontalLines([0.5]);
    setVerticalLines([0.5]);
    setActiveLine(null);
    setDimensions({ width: 0, height: 0 });
  }, [open, sourceURL]);

  function updateGrid(axis: "rows" | "columns", value: string) {
    const count = clampCanvasGrid(Number(value));
    setActiveLine(null);
    if (axis === "rows") setHorizontalLines(buildCanvasGridLines(count));
    else setVerticalLines(buildCanvasGridLines(count));
  }

  function addLine(axis: "horizontal" | "vertical") {
    const lines = axis === "horizontal" ? horizontalLines : verticalLines;
    if (lines.length >= 11) return;
    const next = [...lines, findCanvasGridLineSpot(lines)].sort((a, b) => a - b);
    if (axis === "horizontal") setHorizontalLines(next);
    else setVerticalLines(next);
    setActiveLine({ axis, index: next.indexOf(findCanvasGridLineSpot(lines)) });
  }

  function deleteActiveLine() {
    if (!activeLine) return;
    if (activeLine.axis === "horizontal") setHorizontalLines((lines) => lines.filter((_, index) => index !== activeLine.index));
    else setVerticalLines((lines) => lines.filter((_, index) => index !== activeLine.index));
    setActiveLine(null);
  }

  function startLine(axis: "horizontal" | "vertical", index: number, event: ReactPointerEvent) {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveLine({ axis, index });
    const move = (nextEvent: PointerEvent) => {
      const value = axis === "horizontal" ? (nextEvent.clientY - frame.top) / frame.height : (nextEvent.clientX - frame.left) / frame.width;
      if (axis === "horizontal") setHorizontalLines((lines) => updateLine(lines, index, value));
      else setVerticalLines((lines) => updateLine(lines, index, value));
    };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  }

  const total = rows * columns;
  const pieceSize = dimensions.width
    ? { width: Math.max(1, Math.floor(dimensions.width / columns)), height: Math.max(1, Math.floor(dimensions.height / rows)) }
    : null;
  if (!sourceURL) return null;
  return (
    <Dialog open={open && Boolean(sourceURL)} onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="w-[min(94vw,820px)]">
        <DialogHeader><DialogTitle>切分图片</DialogTitle><DialogDescription>生成 {total} 个图片子节点，并按原图网格排列到画布右侧。</DialogDescription></DialogHeader>
        <div className="grid gap-5 md:grid-cols-[minmax(260px,1fr)_260px]">
          <div className="rounded-xl border border-border p-3">
            <div className="grid min-h-[280px] place-items-center rounded-lg bg-black/10">
              <div ref={frameRef} className="relative inline-block max-w-full overflow-hidden rounded-lg bg-black shadow-xl">
                <img src={sourceURL} alt="" className="block max-h-[48vh] max-w-full object-contain opacity-95" draggable={false} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
                <div className="pointer-events-none absolute inset-0">
                  {verticalLines.map((line, index) => <div key={`v-${index}`} className="pointer-events-auto absolute inset-y-0 -ml-2 w-4 cursor-ew-resize" style={{ left: `${line * 100}%` }} onPointerDown={(event) => startLine("vertical", index, event)}><div className={activeLine?.axis === "vertical" && activeLine.index === index ? "absolute left-1/2 h-full border-l-2 border-amber-300 shadow" : "absolute left-1/2 h-full border-l-2 border-white shadow"} /></div>)}
                  {horizontalLines.map((line, index) => <div key={`h-${index}`} className="pointer-events-auto absolute inset-x-0 -mt-2 h-4 cursor-ns-resize" style={{ top: `${line * 100}%` }} onPointerDown={(event) => startLine("horizontal", index, event)}><div className={activeLine?.axis === "horizontal" && activeLine.index === index ? "absolute top-1/2 w-full border-t-2 border-amber-300 shadow" : "absolute top-1/2 w-full border-t-2 border-white shadow"} /></div>)}
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">原图：{dimensions.width ? `${dimensions.width} × ${dimensions.height}` : "读取中"}</p>
          </div>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm"><span>行数</span><Input type="number" min={1} max={12} value={rows} onChange={(event) => updateGrid("rows", event.target.value)} /></label>
            <label className="block space-y-1.5 text-sm"><span>列数</span><Input type="number" min={1} max={12} value={columns} onChange={(event) => updateGrid("columns", event.target.value)} /></label>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" disabled={rows >= 12} onClick={() => addLine("horizontal")}><Rows3 />横向线</Button>
              <Button type="button" variant="outline" disabled={columns >= 12} onClick={() => addLine("vertical")}><PanelTop className="rotate-90" />纵向线</Button>
              <Button type="button" variant="outline" disabled={!activeLine} onClick={deleteActiveLine}><Trash2 />删除线</Button>
              <Button type="button" variant="outline" onClick={() => { setActiveLine(null); setHorizontalLines(buildCanvasGridLines(rows)); setVerticalLines(buildCanvasGridLines(columns)); }}><ListRestart />重置线</Button>
            </div>
            <div className="space-y-2 rounded-xl border border-border px-3 py-3 text-sm">
              <div><span className="text-muted-foreground">切片数量</span><strong className="float-right">{total} 个</strong></div>
              <div><span className="text-muted-foreground">平均约</span><strong className="float-right">{pieceSize ? `${pieceSize.width} × ${pieceSize.height}` : "读取中"}</strong></div>
            </div>
          </div>
        </div>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="button" disabled={busy} onClick={() => onConfirm({ rows, columns, horizontalLines, verticalLines })}>{busy ? "处理中" : <><Grid2X2 />生成子节点</>}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CanvasUpscaleDialog({ sourceURL, open, busy, onClose, onConfirm }: { sourceURL: string; open: boolean; busy: boolean; onClose: () => void; onConfirm: (params: CanvasImageUpscaleParams) => void }) {
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [target, setTarget] = useState(2048);
  const [algorithm, setAlgorithm] = useState<CanvasImageUpscaleAlgorithm>("high");
  useEffect(() => { if (open) { setTarget(2048); setAlgorithm("high"); setDimensions({ width: 0, height: 0 }); } }, [open, sourceURL]);
  const sourceLong = Math.max(dimensions.width, dimensions.height);
  const outputSize = dimensions.width ? resolveCanvasUpscaleSize(dimensions.width, dimensions.height, target) : null;
  const disabled = !sourceLong || sourceLong >= target || sourceLong >= CANVAS_MAX_UPSCALE_LONG_EDGE;
  if (!sourceURL) return null;
  const algorithms: Array<{ value: CanvasImageUpscaleAlgorithm; title: string; description: string }> = [
    { value: "high", title: "高清插值", description: "适合照片和细节图" },
    { value: "bilinear", title: "双线性", description: "平滑、速度快" },
    { value: "nearest", title: "最近邻", description: "适合像素风格" },
  ];
  return (
    <Dialog open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="w-[min(94vw,820px)]">
        <DialogHeader><DialogTitle>图片放大</DialogTitle><DialogDescription>生成更高分辨率的独立图片节点。</DialogDescription></DialogHeader>
        <div className="grid gap-5 md:grid-cols-[minmax(260px,1fr)_340px]">
          <div className="rounded-xl border border-border p-3">
            <div className="grid min-h-[280px] place-items-center rounded-lg bg-black/10">
              <img
                src={sourceURL}
                alt=""
                className="max-h-[42vh] max-w-full rounded-lg object-contain shadow-xl"
                draggable={false}
                onLoad={(event) => {
                  const next = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
                  setDimensions(next);
                  setTarget(nextCanvasUpscaleTarget(Math.max(next.width, next.height)));
                }}
              />
            </div>
            <p className="mt-2 flex justify-between text-xs text-muted-foreground"><span>源图</span><strong className="text-foreground">{dimensions.width ? `${dimensions.width} × ${dimensions.height} px` : "读取中"}</strong></p>
          </div>
          <div className="space-y-5 py-1">
            <div className="space-y-2 text-sm">
              <span className="font-medium">目标像素</span>
              <div className="grid grid-cols-3 gap-1.5">{[1024, 2048, 4096].map((value) => <Button key={value} type="button" variant={target === value ? "default" : "outline"} size="sm" disabled={Boolean(sourceLong && sourceLong >= value)} onClick={() => setTarget(value)}>{value / 1024}K · {value}px</Button>)}</div>
              {sourceLong >= CANVAS_MAX_UPSCALE_LONG_EDGE ? <p className="text-xs font-medium text-rose-600">图片已达到 4K，无需放大</p> : null}
            </div>
            <div className="space-y-2 text-sm">
              <span className="font-medium">放大算法</span>
              <div className="grid gap-1.5">{algorithms.map((item) => <Button key={item.value} type="button" variant={algorithm === item.value ? "default" : "outline"} className="h-auto justify-start py-2 text-left" onClick={() => setAlgorithm(item.value)}><span className="grid"><strong>{item.title}</strong><span className={algorithm === item.value ? "text-xs font-normal text-primary-foreground/75" : "text-xs font-normal text-muted-foreground"}>{item.description}</span></span></Button>)}</div>
            </div>
            <div className="rounded-xl border border-border px-3 py-3 text-sm"><span className="text-muted-foreground">输出尺寸</span><strong className="float-right">{outputSize ? `${outputSize.width} × ${outputSize.height} px` : "读取中"}</strong></div>
          </div>
        </div>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="button" disabled={disabled || busy} onClick={() => onConfirm({ targetLongEdge: target, algorithm })}>{busy ? "处理中" : <><ZoomIn />生成放大图</>}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type CanvasMaskEditPayload = { prompt: string; maskDataURL: string };

export function CanvasMaskDialog({ sourceURL, open, busy, onClose, onConfirm }: { sourceURL: string; open: boolean; busy: boolean; onClose: () => void; onConfirm: (payload: CanvasMaskEditPayload) => void }) {
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [prompt, setPrompt] = useState("");
  const [brushSize, setBrushSize] = useState(100);
  const [mode, setMode] = useState<"paint" | "erase">("paint");
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setPrompt(""); setBrushSize(100); setMode("paint"); setError(""); setDimensions({ width: 0, height: 0 }); } }, [open, sourceURL]);
  useEffect(() => { clearCanvas(maskRef.current); clearCanvas(previewRef.current); }, [dimensions]);
  function draw(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = maskRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const point = canvasPoint(event.currentTarget, event.clientX, event.clientY);
    context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = brushSize; context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out"; context.strokeStyle = "#000"; context.fillStyle = "#000";
    const previous = drawingRef.current.last || point; maskStroke(context, previous, point, brushSize); drawingRef.current.last = point; renderMask(canvas, previewRef.current); if (mode === "paint") setError("");
  }
  function startDraw(event: ReactPointerEvent<HTMLCanvasElement>) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drawingRef.current = { active: true, last: null }; draw(event); }
  function stopDraw() { drawingRef.current = { active: false, last: null }; if (maskRef.current) renderMask(maskRef.current, previewRef.current, true); }
  function submit() { const canvas = maskRef.current; if (!prompt.trim()) return setError("请输入修改要求"); if (!canvas || !hasMask(canvas)) return setError("请先涂抹局部区域"); onConfirm({ prompt: prompt.trim(), maskDataURL: buildEditMask(canvas) }); }
  if (!sourceURL) return null;
  return <Dialog open={open && Boolean(sourceURL)} onOpenChange={(value) => !value && !busy && onClose()}><DialogContent className="w-[min(94vw,980px)]"><DialogHeader><DialogTitle>局部遮罩编辑</DialogTitle><DialogDescription>涂抹需要修改的区域，未选区域会尽量保持不变。</DialogDescription></DialogHeader><div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_280px]"><div className="flex min-h-[320px] items-center justify-center rounded-xl border border-border bg-black/5"><div className="relative inline-block max-w-full overflow-hidden rounded-lg"><img src={sourceURL} alt="" className="block max-h-[60vh] max-w-full" draggable={false} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />{dimensions.width ? <><canvas ref={maskRef} width={dimensions.width} height={dimensions.height} className="hidden" /><canvas ref={previewRef} width={dimensions.width} height={dimensions.height} className="absolute inset-0 size-full cursor-crosshair touch-none" onPointerDown={startDraw} onPointerMove={(event) => drawingRef.current.active && draw(event)} onPointerUp={stopDraw} onPointerCancel={stopDraw} /></> : null}</div></div><div className="flex flex-col gap-4"><div className="grid grid-cols-2 gap-2"><Button type="button" variant={mode === "paint" ? "default" : "outline"} onClick={() => setMode("paint")}><Brush />画笔</Button><Button type="button" variant={mode === "erase" ? "default" : "outline"} onClick={() => setMode("erase")}><Eraser />擦除</Button></div><label className="space-y-2 text-sm"><span className="flex justify-between"><span>笔刷大小</span><strong>{brushSize}px</strong></span><input type="range" min="8" max="160" step="2" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} className="w-full accent-[#1456f0]" /></label><label className="space-y-2 text-sm"><span>修改要求</span><Textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); setError(""); }} placeholder="例如：把选中区域改成金属材质" className="min-h-32 resize-y" /></label>{error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}<Button type="button" variant="outline" disabled={busy} onClick={() => { clearCanvas(maskRef.current); clearCanvas(previewRef.current); setError(""); }}><RotateCcw />重置蒙版</Button></div></div><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}><X />取消</Button><Button type="button" disabled={busy} onClick={submit}>{busy ? "处理中" : <><WandSparkles />AI 修改</>}</Button></DialogFooter></DialogContent></Dialog>;
}

export function CanvasAngleDialog({ sourceURL, open, busy, onClose, onConfirm }: { sourceURL: string; open: boolean; busy: boolean; onClose: () => void; onConfirm: (params: CanvasImageAngleParams) => void }) {
  const [params, setParams] = useState<CanvasImageAngleParams>({ horizontalAngle: 0, pitchAngle: 9, cameraDistance: 4.8, wideAngle: false });
  useEffect(() => { if (open) setParams({ horizontalAngle: 0, pitchAngle: 9, cameraDistance: 4.8, wideAngle: false }); }, [open, sourceURL]);
  const update = <K extends keyof CanvasImageAngleParams>(key: K, value: CanvasImageAngleParams[K]) => setParams((current) => ({ ...current, [key]: value }));
  if (!sourceURL) return null;
  return <Dialog open={open && Boolean(sourceURL)} onOpenChange={(value) => !value && !busy && onClose()}><DialogContent className="w-[min(94vw,860px)]"><DialogHeader><DialogTitle>AI 多角度</DialogTitle><DialogDescription>基于原图生成同一主体的新视角。</DialogDescription></DialogHeader><div className="grid gap-5 md:grid-cols-[minmax(240px,1fr)_320px]"><div className="flex min-h-[280px] items-center justify-center rounded-xl border border-border bg-black/5"><img src={sourceURL} alt="" className="size-52 rounded-2xl object-contain shadow-xl" draggable={false} style={{ transform: anglePreviewTransform(params) }} /></div><div className="space-y-5"><AngleControl label="左右角度" value={params.horizontalAngle} min={-60} max={60} step={1} suffix="°" onChange={(value) => update("horizontalAngle", value)} /><AngleControl label="俯仰角度" value={params.pitchAngle} min={-45} max={45} step={1} suffix="°" onChange={(value) => update("pitchAngle", value)} /><AngleControl label="镜头距离" value={params.cameraDistance} min={1} max={10} step={0.1} suffix="" onChange={(value) => update("cameraDistance", value)} /><div className="flex items-center justify-between gap-3 text-sm"><span>镜头</span><div className="flex gap-1.5"><Button type="button" size="sm" variant={!params.wideAngle ? "default" : "outline"} onClick={() => update("wideAngle", false)}>标准</Button><Button type="button" size="sm" variant={params.wideAngle ? "default" : "outline"} onClick={() => update("wideAngle", true)}>广角</Button></div></div><p className="text-xs text-muted-foreground">{canvasImageAngleLabel(params)}</p></div></div><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="button" disabled={busy} onClick={() => onConfirm(params)}>{busy ? "处理中" : <><Camera />AI 生成</>}</Button></DialogFooter></DialogContent></Dialog>;
}

function AngleControl({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) { return <label className="grid grid-cols-[72px_1fr_56px] items-center gap-3 text-sm"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="accent-[#1456f0]" /><strong className="text-right">{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}</strong></label>; }
function anglePreviewTransform(params: CanvasImageAngleParams) { const scale = 1.08 - params.cameraDistance * 0.035 + (params.wideAngle ? -0.08 : 0); return `perspective(520px) rotateY(${params.horizontalAngle * -0.45}deg) rotateX(${params.pitchAngle * 0.35}deg) scale(${Math.max(0.72, Math.min(1.08, scale))})`; }
function clearCanvas(canvas: HTMLCanvasElement | null) { const context = canvas?.getContext("2d"); if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height); }
function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) { const rect = canvas.getBoundingClientRect(); return { x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width, y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height }; }
function maskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) { context.beginPath(); if (from.x === to.x && from.y === to.y) { context.arc(to.x, to.y, size / 2, 0, Math.PI * 2); context.fill(); } else { context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); } }
function hasMask(canvas: HTMLCanvasElement) { const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data; if (!data) return false; for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return true; return false; }
function renderMask(mask: HTMLCanvasElement, preview: HTMLCanvasElement | null, border = false) { const context = preview?.getContext("2d"); if (!preview || !context) return; context.clearRect(0, 0, preview.width, preview.height); context.fillStyle = "rgba(37,99,235,.38)"; context.fillRect(0, 0, preview.width, preview.height); context.globalCompositeOperation = "destination-in"; context.drawImage(mask, 0, 0); context.globalCompositeOperation = "source-over"; if (border) { context.strokeStyle = "rgba(255,255,255,.8)"; context.lineWidth = Math.max(2, Math.round(Math.max(mask.width, mask.height) / 400)); context.setLineDash([12, 8]); context.strokeRect(1, 1, mask.width - 2, mask.height - 2); context.setLineDash([]); } }
function buildEditMask(selection: HTMLCanvasElement) { const canvas = document.createElement("canvas"); canvas.width = selection.width; canvas.height = selection.height; const context = canvas.getContext("2d"); const selectionContext = selection.getContext("2d"); if (!context || !selectionContext) return selection.toDataURL("image/png"); context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); const selected = selectionContext.getImageData(0, 0, canvas.width, canvas.height); const mask = context.getImageData(0, 0, canvas.width, canvas.height); for (let index = 3; index < mask.data.length; index += 4) if (selected.data[index] > 0) mask.data[index] = 0; context.putImageData(mask, 0, 0); return canvas.toDataURL("image/png"); }

function moveCrop(crop: CanvasImageCropRect, dx: number, dy: number) { return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) }; }
function resizeCrop(crop: CanvasImageCropRect, dx: number, dy: number, handle: string, locked: boolean, frame: DOMRect) {
  let next = { ...crop };
  if (handle.includes("e")) next.width = crop.width + dx; if (handle.includes("s")) next.height = crop.height + dy; if (handle.includes("w")) { next.x = crop.x + dx; next.width = crop.width - dx; } if (handle.includes("n")) { next.y = crop.y + dy; next.height = crop.height - dy; }
  if (locked) { const size = Math.max(next.width * frame.width, next.height * frame.height); next.width = size / frame.width; next.height = size / frame.height; if (handle.includes("w")) next.x = crop.x + crop.width - next.width; if (handle.includes("n")) next.y = crop.y + crop.height - next.height; }
  next.width = clamp(next.width, 0.06, 1); next.height = clamp(next.height, 0.06, 1); next.x = clamp(next.x, 0, 1 - next.width); next.y = clamp(next.y, 0, 1 - next.height); return next;
}
function cropHandleStyle(handle: string) { return { top: handle.includes("n") ? "-6px" : handle.includes("s") ? "calc(100% - 6px)" : "calc(50% - 6px)", left: handle.includes("w") ? "-6px" : handle.includes("e") ? "calc(100% - 6px)" : "calc(50% - 6px)", cursor: `${handle}-resize` }; }
function updateLine(lines: number[], index: number, value: number) { const next = [...lines]; next[index] = clamp(value, (lines[index - 1] || 0) + 0.01, (lines[index + 1] || 1) - 0.01); return next; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
