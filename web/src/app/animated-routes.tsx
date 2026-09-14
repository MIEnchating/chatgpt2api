import type { ReactNode } from "react";
import { Suspense } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { appRoutes } from "@/app/route-config";
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
      <Suspense
        key={pathname}
        fallback={(
          <div role="status" className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
            正在加载页面
          </div>
        )}
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
    </div>
  );
}
