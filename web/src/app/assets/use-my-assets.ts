"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { fetchMyAssets, loadMyAssets, mergeMyAssets, saveMyAssets, syncMyAssets, type MyAsset } from "@/lib/my-assets";

export function useMyAssets(scope: string, enabled: boolean) {
  const [assets, setAssets] = useState<MyAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const hydratedScopeRef = useRef("");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    hydratedScopeRef.current = "";
    setLoading(true);
    const localAssets = loadMyAssets(scope);
    setAssets(localAssets);
    void fetchMyAssets(controller.signal)
      .then(async (remoteAssets) => {
        if (!active) return;
        const resolved = mergeMyAssets(remoteAssets, localAssets);
        setAssets(resolved);
        saveMyAssets(scope, resolved);
        hydratedScopeRef.current = scope;
        if (resolved.length !== remoteAssets.length || resolved.some((asset, index) => asset.id !== remoteAssets[index]?.id || asset.updatedAt !== remoteAssets[index]?.updatedAt)) {
          await syncMyAssets(resolved);
        }
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        hydratedScopeRef.current = scope;
        toast.error(error instanceof Error ? `云端素材读取失败：${error.message}` : "云端素材读取失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [enabled, scope]);

  useEffect(() => {
    if (!enabled || hydratedScopeRef.current !== scope) return;
    saveMyAssets(scope, assets);
    const timer = window.setTimeout(() => {
      void syncMyAssets(assets).catch((error) => toast.error(error instanceof Error ? `素材同步失败：${error.message}` : "素材同步失败"));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [assets, enabled, scope]);

  return { assets, setAssets, loading };
}
