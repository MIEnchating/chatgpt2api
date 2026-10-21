import { useEffect, useState } from "react";
import { loadEditableImageSource } from "@/lib/editable-image-source";

export function useEditableImageSource(sourceURL: string, open: boolean) {
  const [source, setSource] = useState({ originalURL: "", url: "", width: 0, height: 0, error: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || !sourceURL) {
      setSource({ originalURL: "", url: "", width: 0, height: 0, error: "" });
      return;
    }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setSource({ originalURL: sourceURL, url: "", width: 0, height: 0, error: "" });
    void loadEditableImageSource(sourceURL, controller.signal).then(async (resource) => {
      if (controller.signal.aborted) {
        resource.release();
        return;
      }
      release = resource.release;
      const image = new Image();
      image.src = resource.url;
      await image.decode();
      if (controller.signal.aborted) return;
      setSource({ originalURL: sourceURL, url: resource.url, width: image.naturalWidth, height: image.naturalHeight, error: "" });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      release?.();
      release = undefined;
      setSource({ originalURL: sourceURL, url: "", width: 0, height: 0, error: error instanceof Error ? error.message : "读取原图失败" });
    });
    return () => {
      controller.abort();
      release?.();
    };
  }, [open, sourceURL, attempt]);
  const current = open && source.originalURL === sourceURL;
  return {
    url: current ? source.url : "",
    width: current ? source.width : 0,
    height: current ? source.height : 0,
    error: current ? source.error : "",
    retry: () => setAttempt((value) => value + 1),
  };
}
