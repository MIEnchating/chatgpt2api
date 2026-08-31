"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { deleteMyAsset, fetchMyAssets, upsertMyAsset, type MyAsset } from "@/lib/my-assets";

export function useMyAssets(scope: string, enabled: boolean) {
  const [assets, setAssets] = useState<MyAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const activeScopeRef = useRef("");
  const mutationQueuesRef = useRef(new Map<string, Promise<unknown>>());

  useEffect(() => {
    activeScopeRef.current = enabled ? scope : "";
    setAssets([]);
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    void fetchMyAssets(scope, controller.signal)
      .then((remoteAssets) => {
        if (active && activeScopeRef.current === scope) setAssets(remoteAssets);
      })
      .catch((error) => {
        if (!active || controller.signal.aborted || activeScopeRef.current !== scope) return;
        toast.error(error instanceof Error ? `云端素材读取失败：${error.message}` : "云端素材读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, scope]);

  const enqueueMutation = useCallback(<T,>(id: string, mutation: () => Promise<T>) => {
    const queues = mutationQueuesRef.current;
    const previous = queues.get(id) || Promise.resolve();
    const request = previous.catch(() => undefined).then(mutation);
    let tracked: Promise<T>;
    tracked = request.finally(() => {
      if (queues.get(id) === tracked) queues.delete(id);
    });
    queues.set(id, tracked);
    return tracked;
  }, []);

  const upsertAsset = useCallback((asset: MyAsset) => enqueueMutation(asset.id, async () => {
    const saved = await upsertMyAsset(asset);
    if (activeScopeRef.current === scope) {
      setAssets((current) => [
        saved,
        ...current.filter((item) => (
          item.id !== asset.id
          && item.id !== saved.id
          && (!saved.storageKey || item.storageKey !== saved.storageKey)
        )),
      ]);
    }
    return saved;
  }), [enqueueMutation, scope]);

  const deleteAsset = useCallback((id: string) => enqueueMutation(id, async () => {
    const deleted = await deleteMyAsset(id);
    if (activeScopeRef.current === scope) {
      setAssets((current) => current.filter((item) => item.id !== id));
    }
    return deleted;
  }), [enqueueMutation, scope]);

  return { assets, upsertAsset, deleteAsset, loading };
}
