import { LoadingState } from "@/components/ui/loading-state";
import { lazy, Suspense } from "react";
import { useParams } from "react-router-dom";

import { canvasProjectIDFromRoute } from "@/lib/canvas-project-route";
import { useAuthGuard } from "@/lib/use-auth-guard";

const CanvasPage = lazy(() => import("@/app/canvas/page"));

export default function CanvasRoute() {
  const { projectID: routeProjectID } = useParams<{ projectID?: string }>();
  const projectID = canvasProjectIDFromRoute(routeProjectID);
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/canvas");

  if (isCheckingAuth || !session) {
    return (
      <LoadingState label="正在加载画布" />
    );
  }

  return (
    <Suspense
      fallback={(
        <LoadingState label="正在加载画布" />
      )}
    >
      <CanvasPage session={session} projectID={projectID} />
    </Suspense>
  );
}
