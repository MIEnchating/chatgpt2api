import type { ReactNode } from "react";
import { Suspense } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { appRoutes } from "@/app/route-config";
import { LoadingState } from "@/components/ui/loading-state";
import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { getCachedAuthSession } from "@/lib/session";
import { canAccessPath, getDefaultRouteForSession } from "@/lib/auth-session";

function PermissionRoute({ requiredPath, children }: { requiredPath?: string; children: ReactNode }) {
  const session = getCachedAuthSession();
  if (!requiredPath) {
    return children;
  }
  if (session === undefined) {
    return children;
  }
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  if (!canAccessPath(session, requiredPath)) {
    return <Navigate to={getDefaultRouteForSession(session)} replace />;
  }
  return children;
}

export function AnimatedRoutes() {
  const { pathname } = useLocation();

  return (
    <div className="h-full min-h-0 min-w-0">
      <RouteErrorBoundary key={pathname}>
        <Suspense
          key={pathname}
          fallback={<LoadingState label="正在加载页面" />}
        >
          <Routes>
            {appRoutes.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={<PermissionRoute requiredPath={route.requiredPath}>{route.element}</PermissionRoute>}
              />
            ))}
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
    </div>
  );
}
