"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { deleteMyAsset, fetchMyAssets, upsertMyAsset, type MyAsset } from "@/lib/my-assets";

type AssetListMutation = (assets: MyAsset[]) => MyAsset[];

export function useMyAssets(scope: string, enabled: boolean) {
  const [assets, setAssets] = useState<MyAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const activeScopeRef = useRef("");
  const mutationQueuesRef = useRef(new Map<string, Promise<unknown>>());
  const mutationScopeRef = useRef<{ scope: string; controller: AbortController } | null>(null);
  const pendingLoadMutationsRef = useRef<AssetListMutation[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      mutationScopeRef.current = null;
      return;
    }
    const mutationScope = { scope, controller: new AbortController() };
    mutationScopeRef.current = mutationScope;
    return () => {
      mutationScope.controller.abort(new DOMException("素材操作所属会话已失效", "AbortError"));
      if (mutationScopeRef.current === mutationScope) {
        mutationScopeRef.current = null;
      }
    };
  }, [enabled, scope]);

  useEffect(() => {
    activeScopeRef.current = enabled ? scope : "";
    setAssets([]);
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const loadMutations: AssetListMutation[] = [];
    pendingLoadMutationsRef.current = loadMutations;
    let active = true;
    setLoading(true);
    void fetchMyAssets(scope, controller.signal)
      .then((remoteAssets) => {
        if (active && activeScopeRef.current === scope) {
          // Replay mutations acknowledged after this snapshot request started.
          setAssets(loadMutations.reduce((current, mutation) => mutation(current), remoteAssets));
        }
      })
      .catch((error) => {
        if (!active || controller.signal.aborted || activeScopeRef.current !== scope) return;
        toast.error(error instanceof Error ? `云端素材读取失败：${error.message}` : "云端素材读取失败");
      })
      .finally(() => {
        if (pendingLoadMutationsRef.current === loadMutations) pendingLoadMutationsRef.current = null;
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (pendingLoadMutationsRef.current === loadMutations) pendingLoadMutationsRef.current = null;
      controller.abort();
    };
  }, [enabled, scope]);

  const enqueueMutation = useCallback(<T,>(requestScope: string, id: string, mutation: (signal: AbortSignal) => Promise<T>) => {
    const mutationScope = mutationScopeRef.current;
    const queues = mutationQueuesRef.current;
    const queueKey = `${requestScope}\u0000${id}`;
    const previous = queues.get(queueKey) || Promise.resolve();
    const request = previous.catch(() => undefined).then(() => {
      if (!mutationScope || mutationScopeRef.current !== mutationScope || mutationScope.scope !== requestScope || mutationScope.controller.signal.aborted) {
        throw new DOMException("素材操作所属会话已失效", "AbortError");
      }
      return mutation(mutationScope.controller.signal);
    });
    let tracked: Promise<T>;
    tracked = request.finally(() => {
      if (queues.get(queueKey) === tracked) queues.delete(queueKey);
    });
    queues.set(queueKey, tracked);
    return tracked;
  }, []);

  const upsertAsset = useCallback((asset: MyAsset) => enqueueMutation(scope, asset.id, async (signal) => {
    const saved = await upsertMyAsset(asset, signal);
    if (!signal.aborted && activeScopeRef.current === scope) {
      const apply: AssetListMutation = (current) => [
        saved,
        ...current.filter((item) => (
          item.id !== asset.id
          && item.id !== saved.id
          && (!saved.storageKey || item.storageKey !== saved.storageKey)
        )),
      ];
      pendingLoadMutationsRef.current?.push(apply);
      setAssets(apply);
    }
    return saved;
  }), [enqueueMutation, scope]);

  const deleteAsset = useCallback((id: string) => enqueueMutation(scope, id, async (signal) => {
    const deleted = await deleteMyAsset(id, signal);
    if (!signal.aborted && activeScopeRef.current === scope) {
      const apply: AssetListMutation = (current) => current.filter((item) => item.id !== id);
      pendingLoadMutationsRef.current?.push(apply);
      setAssets(apply);
    }
    return deleted;
  }), [enqueueMutation, scope]);

  return { assets, upsertAsset, deleteAsset, loading };
}
