"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { fetchMyAssets, syncMyAssets, type MyAsset } from "@/lib/my-assets";

export function useMyAssets(scope: string, enabled: boolean) {
  const [assets, setAssets] = useState<MyAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const hydratedScopeRef = useRef("");
  const syncedSignatureRef = useRef("");
  const currentSignatureRef = useRef("");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    hydratedScopeRef.current = "";
    setLoading(true);
    void fetchMyAssets(scope, controller.signal)
      .then((remoteAssets) => {
        if (!active) return;
        syncedSignatureRef.current = JSON.stringify(remoteAssets);
        currentSignatureRef.current = syncedSignatureRef.current;
        setAssets(remoteAssets);
        hydratedScopeRef.current = scope;
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
    const signature = JSON.stringify(assets);
    currentSignatureRef.current = signature;
    if (signature === syncedSignatureRef.current) return;
    const timer = window.setTimeout(() => {
      void syncMyAssets(scope, assets)
        .then((synced) => {
          if (currentSignatureRef.current !== signature) return;
          syncedSignatureRef.current = JSON.stringify(synced);
          setAssets(synced);
        })
        .catch(async (error) => {
          toast.error(error instanceof Error ? `素材同步失败：${error.message}` : "素材同步失败");
          try {
            const remoteAssets = await fetchMyAssets(scope);
            if (currentSignatureRef.current !== signature) return;
            syncedSignatureRef.current = JSON.stringify(remoteAssets);
            setAssets(remoteAssets);
          } catch {
            // The next page load will restore the authoritative server state.
          }
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [assets, enabled, scope]);

  return { assets, setAssets, loading };
}
