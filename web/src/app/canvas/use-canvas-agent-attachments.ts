import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { canvasAgentAttachment, uploadCanvasAgentAttachment } from "./agent/canvas-agent-attachments";
import type { CanvasAssistantReference, CanvasInsertAssetPayload } from "./agent/canvas-agent-types";

export function useCanvasAgentAttachments(sessionID: string) {
  const [attachments, setAttachments] = useState<CanvasAssistantReference[]>([]);
  const [uploading, setUploading] = useState(false);
  const controllers = useRef(new Set<AbortController>());

  function clear() {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    setAttachments([]);
    setUploading(false);
  }

  useEffect(() => {
    clear();
    const pending = controllers.current;
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, clear);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, clear);
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, [sessionID]);

  async function upload(files: File[]) {
    const controller = new AbortController();
    controllers.current.add(controller);
    setUploading(true);
    try {
      for (const file of files) {
        try {
          const attachment = await uploadCanvasAgentAttachment(file, controller.signal);
          if (controller.signal.aborted) return;
          setAttachments((current) => [...current, attachment]);
        } catch (error) {
          if (controller.signal.aborted) return;
          toast.error(error instanceof Error ? error.message : "附件上传失败");
        }
      }
    } finally {
      controllers.current.delete(controller);
      if (!controller.signal.aborted) setUploading(controllers.current.size > 0);
    }
  }

  return {
    attachments,
    uploading,
    clear,
    upload,
    add: (payload: CanvasInsertAssetPayload) => setAttachments((current) => [...current, canvasAgentAttachment(payload)]),
    replace: (items: CanvasAssistantReference[]) => setAttachments(items),
    remove: (ids: string[]) => setAttachments((current) => current.filter((item) => !ids.includes(item.id))),
  };
}
