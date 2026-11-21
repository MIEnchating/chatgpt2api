import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AssetEditor } from "@/app/assets/asset-form";
import { canManageAsset } from "@/app/assets/asset-library";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { fetchMyAsset, upsertMyAsset, type MyAsset } from "@/lib/my-assets";

export default function AssetEditorPage() {
  const { session, isCheckingAuth } = useAuthGuard(undefined, "/assets");
  const revision = useAuthSessionRevision();
  const { assetID } = useParams<{ assetID: string }>();
  if (isCheckingAuth || !session || getCachedAuthSession()?.key !== session.key)
    return <LoadingState label="正在加载素材编辑器..." />;
  return <AssetEditorContent key={`${session.key}:${revision}:${assetID || "new"}`} assetID={assetID} />;
}

function AssetEditorContent({ assetID }: { assetID?: string }) {
  const navigate = useNavigate();
  const [asset, setAsset] = useState<MyAsset | null>(null);
  const [loading, setLoading] = useState(Boolean(assetID));
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (!assetID) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchMyAsset(assetID, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setAsset(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "素材读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [assetID, loadAttempt]);
  const back = () => navigate("/assets", { replace: true });
  if (loading) return <LoadingState label="正在读取素材" />;
  if (error) return <EmptyState role="alert" title="素材读取失败" description={error} action={<Button onClick={() => setLoadAttempt((n) => n + 1)}>重试</Button>} />;
  if (assetID && !asset) return <EmptyState title="素材不存在" action={<Button onClick={back}>返回素材库</Button>} />;
  if (asset && (!canManageAsset(asset) || asset.managedPath || asset.kind === "video"))
    return (
      <EmptyState
        title="无法编辑这项素材"
        description="此来源或类型的素材无法在这里编辑。"
        action={<Button onClick={back}>返回素材库</Button>}
      />
    );
  return (
    <AssetEditor
      asset={asset}
      onClose={back}
      onSave={async (next, signal) => {
        await upsertMyAsset(next, signal);
      }}
    />
  );
}
