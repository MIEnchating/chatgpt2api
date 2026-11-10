import { Spinner } from "@/components/ui/spinner";
import { TooltipHint } from "@/components/ui/tooltip";
import { Share2 } from "lucide-react";
import { useEffect, useState } from "react";

import { CanvasShareDialog } from "@/app/canvas/canvas-share-dialog";
import { Button } from "@/components/ui/button";

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
    <TooltipHint content={loading ? "正在读取分享状态" : shared ? "已开启只读分享，点击管理" : shared === false ? "生成只读分享链接" : "未能读取分享状态，点击重试"}><Button
      variant="ghost"
      size="sm"
      className="shrink-0"
      disabled={disabled || loading || !projectID}
      aria-label={shared ? "已分享" : "分享"}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => { onOpen(); setOpen(true); }}
    >
      {loading ? <Spinner /> : <Share2  />}
      {shared ? "已分享" : "分享"}
    </Button></TooltipHint>
    {open ? <CanvasShareDialog projectID={projectID} beforeShare={beforeShare} onClose={() => setOpen(false)} onShareChange={setShared} /> : null}
  </>;
}
