import { LoaderCircle, Share2 } from "lucide-react";
import { useEffect, useState } from "react";

import { CanvasShareDialog } from "@/app/canvas/canvas-share-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchCanvasShare } from "@/services/api/canvas";

export function CanvasShareButton({ projectID, disabled, beforeShare, onOpen }: {
  projectID: string;
  disabled: boolean;
  beforeShare: () => Promise<boolean>;
  onOpen: () => void;
}) {
  const [shared, setShared] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!projectID) return;
    let active = true;
    fetchCanvasShare(projectID)
      .then((share) => { if (active) setShared(Boolean(share.token)); })
      .catch(() => { if (active) setShared(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectID]);

  return <>
    <Button
      variant="ghost"
      size="sm"
      className={cn("h-8 shrink-0 gap-1 rounded-lg px-2 text-xs", shared && "bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand")}
      disabled={disabled || loading || !projectID}
      aria-label={shared ? "已分享" : "分享"}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={loading ? "正在读取分享状态" : shared ? "已开启只读分享，点击管理" : shared === false ? "生成只读分享链接" : "未能读取分享状态，点击重试"}
      onClick={() => { onOpen(); setOpen(true); }}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Share2 className="size-4" />}
      {shared ? "已分享" : "分享"}
    </Button>
    {open ? <CanvasShareDialog projectID={projectID} beforeShare={beforeShare} onClose={() => setOpen(false)} onShareChange={setShared} /> : null}
  </>;
}
