import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { fetchStoredMedia, storedMediaExtension } from "@/services/stored-media-download";
import { createZip, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from "@/lib/zip";
import { getImageConversation, isImageConversationHistorySummaryOnly, type ImageConversation } from "@/store/image-conversations";

export function useHistoryDownload(conversations: ImageConversation[]) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const reset = () => {
      controllerRef.current?.abort();
      setSelected(new Set());
      setSelecting(false);
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, reset);
    return () => {
      controllerRef.current?.abort();
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, reset);
    };
  }, []);
  useEffect(() => {
    const available = new Set(conversations.map((item) => item.id));
    setSelected((current) => new Set([...current].filter((id) => available.has(id))));
  }, [conversations]);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const download = async () => {
    if (controllerRef.current || selected.size === 0) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const sessionKey = getCachedAuthSession()?.key;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (getCachedAuthSession()?.key !== sessionKey) throw new DOMException("Session changed", "AbortError");
    };
    setBusy(true);
    const toastId = toast.loading("正在读取所选会话");
    try {
      const files: { name: string; data: Blob }[] = [];
      let bytes = 0;
      for (const id of selected) {
        assertCurrent();
        const local = conversations.find((item) => item.id === id);
        const conversation = local && !isImageConversationHistorySummaryOnly(local) ? local : await getImageConversation(id);
        assertCurrent();
        if (!conversation || isImageConversationHistorySummaryOnly(conversation)) throw new Error("部分会话已不存在，请刷新历史后重试");
        const title = Array.from(conversation.title, (char) => char.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(char) ? "_" : char).join("").slice(0, 60) || "会话";
        for (const [turnIndex, turn] of conversation.turns.entries()) {
          for (const [imageIndex, image] of turn.images.entries()) {
            if (image.status !== "success" || !(image.storageKey || image.path || image.url || image.videoUrl || image.b64_json)) continue;
            if (files.length >= MAX_ZIP_ENTRIES) throw new Error("所选文件数量超过压缩包限制，请分批下载");
            assertCurrent();
            const blob = await fetchStoredMedia(image, controller.signal);
            assertCurrent();
            bytes += blob.size;
            if (bytes > MAX_ZIP_BYTES) throw new Error("所选媒体超过 1 GiB，请分批下载");
            files.push({ name: `${title}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}/第${turnIndex + 1}轮-${imageIndex + 1}.${storedMediaExtension(image, blob.type)}`, data: blob });
            toast.loading(`已读取 ${files.length} 个文件`, { id: toastId });
          }
        }
      }
      if (!files.length) throw new Error("所选会话中没有已完成的媒体文件");
      toast.loading("正在打包下载", { id: toastId });
      const archive = await createZip(files, controller.signal);
      assertCurrent();
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `工作台历史-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Give the browser time to consume the generated download URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(`已打包 ${files.length} 个文件`, { id: toastId });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) toast.dismiss(toastId);
      else toast.error(error instanceof Error ? error.message : "批量下载失败", { id: toastId });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
  };
  return { selecting, setSelecting, selected, setSelected, toggle, download, busy, cancel: () => controllerRef.current?.abort() };
}
