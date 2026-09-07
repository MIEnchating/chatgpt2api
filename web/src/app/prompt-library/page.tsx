"use client";

import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ImagePromptMarket } from "@/app/image/components/image-prompt-market";
import type { BananaPrompt } from "@/app/image/banana-prompts";
import { stagePromptForWorkbench } from "@/app/prompt-library/prompt-handoff";
import { createMyAsset, fetchMyAssets, upsertMyAsset } from "@/lib/my-assets";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { AUTH_SESSION_CHANGE_EVENT, type StoredAuthSession } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { toast } from "sonner";

export default function PromptLibraryPage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/prompt-library");
  const sessionRevision = useAuthSessionRevision();
  if (isCheckingAuth || !session || getCachedAuthSession()?.key !== session.key) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载提示词库...</div>;
  return <PromptLibraryContent key={`${session.key}:${sessionRevision}`} session={session} />;
}

function PromptLibraryContent({ session }: { session: StoredAuthSession }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialSource = searchParams.get("source")?.trim() || undefined;
  const saveControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    saveControllerRef.current = controller;
    const handleSessionChange = () => {
      if (getCachedAuthSession()?.key !== session?.key) controller.abort();
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
      controller.abort();
    };
  }, [session?.key]);
  const savePrompt = async (prompt: BananaPrompt) => {
    const signal = saveControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const assets = await fetchMyAssets(session.key, signal);
      signal.throwIfAborted();
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
      await upsertMyAsset(asset, signal);
      signal.throwIfAborted();
      toast.success("已保存到我的素材");
    } catch (error) {
      if (signal.aborted) return;
      toast.error(error instanceof Error ? `保存素材失败：${error.message}` : "保存素材失败");
    }
  };
  return <ImagePromptMarket open presentation="page" initialSource={initialSource} onOpenChange={() => undefined} onApplyPrompt={(prompt) => { stagePromptForWorkbench(prompt, session.key); navigate("/studio"); }} onSavePrompt={savePrompt} />;
}
