import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchAssetGroups, mutateAssetGroup, type AssetGroup, type AssetGroupMutation } from "@/lib/asset-groups";

export function useAssetGroups(scope: string) {
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller;
    setLoading(true); setError("");
    void fetchAssetGroups(controller.signal).then((items) => { if (!controller.signal.aborted) setGroups(items); }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "分组读取失败");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scope, revision]);
  async function mutate(method: "POST" | "PATCH" | "DELETE", body: AssetGroupMutation) {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || loading || error || busyRef.current) return false;
    busyRef.current = true; setBusy(true);
    try { const items = await mutateAssetGroup(method, body, signal); if (signal.aborted) return false; setGroups(items); return true; }
    catch (reason) { if (!signal.aborted) toast.error(reason instanceof Error ? reason.message : "分组保存失败"); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  return { groups, loading, busy, error, mutate, reload: () => setRevision((value) => value + 1) };
}
