import { useNavigate, useParams } from "react-router-dom";
import { AssetEditor } from "@/app/assets/asset-form";
import { canManageAsset } from "@/app/assets/asset-library";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import type { StoredAuthSession } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { useMyAssets } from "@/lib/use-my-assets";

export default function AssetEditorPage() {
  const { session, isCheckingAuth } = useAuthGuard(undefined, "/assets");
  const revision = useAuthSessionRevision();
  if (isCheckingAuth || !session || getCachedAuthSession()?.key !== session.key)
    return <LoadingState label="正在加载素材编辑器..." />;
  return <AssetEditorContent key={`${session.key}:${revision}`} session={session} />;
}

function AssetEditorContent({ session }: { session: StoredAuthSession }) {
  const { assetID } = useParams<{ assetID: string }>();
  const navigate = useNavigate();
  const { assets, upsertAsset, loading } = useMyAssets(session.key, true);
  const asset = assetID ? assets.find((item) => item.id === assetID) : null;
  const back = () => navigate("/assets", { replace: true });
  if (assetID && loading) return <LoadingState label="正在读取素材..." />;
  if (assetID && (!asset || !canManageAsset(asset) || asset.managedPath || asset.kind === "video"))
    return (
      <EmptyState
        title="无法编辑这项素材"
        description="素材不存在，或当前账号没有编辑权限。"
        action={<Button onClick={back}>返回素材库</Button>}
      />
    );
  return (
    <AssetEditor
      key={assetID || "new"}
      asset={asset || null}
      onClose={back}
      onSave={async (next) => {
        await upsertAsset(next);
      }}
    />
  );
}
