import { LoadingState } from "@/components/ui/loading-state";

import CanvasLibraryPage from "@/app/canvas/library-page";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function CanvasLibraryRoute() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/canvas");
  if (isCheckingAuth || !session) {
    return <LoadingState label="正在加载画布库" />;
  }
  return <CanvasLibraryPage session={session} />;
}
