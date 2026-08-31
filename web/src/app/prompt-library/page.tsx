"use client";

import { useNavigate, useSearchParams } from "react-router-dom";
import { ImagePromptMarket } from "@/app/image/components/image-prompt-market";
import type { BananaPrompt } from "@/app/image/banana-prompts";
import { stagePromptForWorkbench } from "@/app/prompt-library/prompt-handoff";
import { createMyAsset, fetchMyAssets, upsertMyAsset } from "@/lib/my-assets";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { toast } from "sonner";

export default function PromptLibraryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialSource = searchParams.get("source")?.trim() || undefined;
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/prompt-library");
  if (isCheckingAuth || !session) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载提示词库...</div>;
  const savePrompt = async (prompt: BananaPrompt) => {
    try {
      const assets = await fetchMyAssets(session.key);
      if (assets.some((asset) => asset.source === "提示词库" && asset.title === prompt.title && asset.content === prompt.prompt)) {
        toast.info("该提示词已经在我的素材中");
        return;
      }
      const coverUrl = prompt.referenceImageUrls[0] || (!prompt.preview.startsWith("data:") ? prompt.preview : "");
      const asset = createMyAsset({
        kind: "text",
        title: prompt.title,
        content: prompt.prompt,
        ...(coverUrl ? { coverUrl } : {}),
        tags: [],
        visibility: "private",
        source: "提示词库",
        metadata: {
          promptId: prompt.id,
          promptSource: prompt.source,
          referenceImageUrls: prompt.referenceImageUrls,
        },
      });
      await upsertMyAsset(asset);
      toast.success("已保存到我的素材");
    } catch (error) {
      toast.error(error instanceof Error ? `保存素材失败：${error.message}` : "保存素材失败");
    }
  };
  return <ImagePromptMarket open presentation="page" initialSource={initialSource} onOpenChange={() => undefined} onApplyPrompt={(prompt) => { stagePromptForWorkbench(prompt); navigate("/studio"); }} onSavePrompt={savePrompt} />;
}
