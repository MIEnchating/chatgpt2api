import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { canvasMediaBlob, validateCanvasAudioTrim, type CanvasAudioTrim } from "@/app/canvas/canvas-media-editing";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import type { CanvasNode } from "@/services/api/canvas";

export function CanvasAudioTrimDialog({ node, busy, onClose, onTrim }: {
  node: CanvasNode;
  busy: boolean;
  onClose: () => void;
  onTrim: (trim: CanvasAudioTrim) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setURL] = useState("");
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<CanvasAudioTrim>({ start: 0, end: 0 });
  const [playing, setPlaying] = useState(false);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const sourceURL = node.url;
  const storageKey = node.storage_key;

  useEffect(() => {
    const controller = new AbortController();
    let objectURL = "";
    const audio = audioRef.current;
    audio?.pause();
    setURL("");
    setError("");
    setDuration(0);
    setRange({ start: 0, end: 0 });
    void canvasMediaBlob({ url: sourceURL, storage_key: storageKey }, controller.signal).then((blob) => {
      controller.signal.throwIfAborted();
      objectURL = URL.createObjectURL(blob);
      setURL(objectURL);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取音频失败"); });
    return () => {
      controller.abort();
      audio?.pause();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [sourceURL, storageKey]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playing) return;
    let frame = 0;
    const update = () => {
      if (audio.currentTime >= rangeRef.current.end) { audio.pause(); return; }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  function updateRange(next: CanvasAudioTrim) {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = next.start; }
    setRange(next);
  }

  let valid = false;
  try { validateCanvasAudioTrim(range, duration); valid = duration > 0; } catch { /* The selection is incomplete while metadata loads. */ }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-lg" onInteractOutside={(event) => { if (busy) event.preventDefault(); }} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>截取音频</DialogTitle><DialogDescription>选择起止时间，试听后生成一个新的音频节点。至少保留 0.5 秒。</DialogDescription></DialogHeader>
      {url ? <audio ref={audioRef} src={url} preload="metadata" onLoadedMetadata={(event) => {
        const length = event.currentTarget.duration;
        if (!Number.isFinite(length) || length <= 0) { setError("无法读取音频时长"); return; }
        setDuration(length); setRange({ start: 0, end: length });
      }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setError("当前浏览器无法播放该音频")} /> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <div className="space-y-5 py-2">
        <label className="grid gap-2 text-sm"><span className="flex justify-between"><span>开始</span><span>{range.start.toFixed(2)} 秒</span></span><Slider aria-label="音频开始时间" min={0} max={Math.max(0, range.end - 0.5)} step="0.01" value={range.start} disabled={busy || duration < 0.5} onChange={(event) => updateRange({ ...range, start: event.currentTarget.valueAsNumber })} /></label>
        <label className="grid gap-2 text-sm"><span className="flex justify-between"><span>结束</span><span>{range.end.toFixed(2)} 秒</span></span><Slider aria-label="音频结束时间" min={range.start + 0.5} max={Math.max(range.start + 0.5, duration)} step="0.01" value={range.end} disabled={busy || duration < 0.5} onChange={(event) => updateRange({ ...range, end: event.currentTarget.valueAsNumber })} /></label>
        <div className="flex items-center justify-between text-sm text-muted-foreground"><span>{duration ? `选中 ${(range.end - range.start).toFixed(2)} 秒 / 总计 ${duration.toFixed(2)} 秒` : "正在读取音频…"}</span><Button type="button" variant="outline" size="sm" disabled={busy || !valid} onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (!audio.paused) { audio.pause(); return; }
          if (audio.currentTime < range.start || audio.currentTime >= range.end) audio.currentTime = range.start;
          void audio.play().catch(() => setError("音频试听失败"));
        }}>{playing ? <Pause /> : <Play />}{playing ? "暂停" : "试听"}</Button></div>
      </div>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy || !valid || Boolean(error)} onClick={() => { audioRef.current?.pause(); onTrim(range); }}>{busy ? "截取中…" : "生成音频节点"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
