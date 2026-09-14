import { LoaderCircle } from "lucide-react";
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
      <div className="flex h-full min-h-0 items-center justify-center">
        <LoaderCircle className="size-6 animate-spin text-brand" />
      </div>
    );
  }

  return (
    <Suspense
      fallback={(
        <div className="flex h-full min-h-0 items-center justify-center rounded-xl border border-border bg-card">
          <LoaderCircle className="size-6 animate-spin text-brand" />
        </div>
      )}
    >
      <CanvasPage session={session} projectID={projectID} />
    </Suspense>
  );
}
