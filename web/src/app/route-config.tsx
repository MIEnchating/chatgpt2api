import { lazy, type ComponentType, type ReactNode } from "react";
import { matchRoutes, Navigate, useLocation } from "react-router-dom";

import { canAccessPath } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";

// Route configuration intentionally exports non-component metadata alongside
// lazy components; Fast Refresh does not apply to this module.
/* oxlint-disable react/only-export-components */

export type AppRouteConfig = {
  path: string;
  element: ReactNode;
  requiredPath?: string;
  preload?: () => Promise<unknown>;
};

function lazyRoute(
  path: string,
  load: () => Promise<{ default: ComponentType }>,
  requiredPath?: string,
): AppRouteConfig {
  const Component = lazy(load);
  return { path, element: <Component />, requiredPath, preload: load };
}

function LegacyImageRoute() {
  const { hash, search } = useLocation();
  return <Navigate to={{ pathname: "/studio", search, hash }} replace />;
}

export const appRoutes: AppRouteConfig[] = [
  lazyRoute("/", () => import("@/app/page")),
  lazyRoute("/login", () => import("@/app/login/page")),
  lazyRoute("/canvas/:projectID", () => import("@/app/canvas/route"), "/canvas"),
  lazyRoute("/canvas/editor", () => import("@/app/canvas/route"), "/canvas"),
  lazyRoute("/canvas", () => import("@/app/canvas/library-route"), "/canvas"),
  lazyRoute("/workflows", () => import("@/app/workflows/page"), "/workflows"),
  lazyRoute("/assets", () => import("@/app/assets/page"), "/assets"),
  lazyRoute("/prompt-library", () => import("@/app/prompt-library/page"), "/prompt-library"),
  lazyRoute("/users", () => import("@/app/users/page"), "/users"),
  lazyRoute("/profile", () => import("@/app/profile/page"), "/profile"),
  lazyRoute("/rbac", () => import("@/app/rbac/page"), "/rbac"),
  lazyRoute("/logs", () => import("@/app/logs/page"), "/logs"),
  lazyRoute("/settings", () => import("@/app/settings/page"), "/settings"),
  lazyRoute("/studio", () => import("@/app/image/page"), "/studio"),
  { path: "/image", element: <LegacyImageRoute /> },
  lazyRoute("*", () => import("@/app/page")),
];

export function preloadRoute(pathname: string): void {
  const route = matchRoutes(appRoutes, pathname)?.at(-1)?.route;
  if (!route?.preload || (route.requiredPath && !canAccessPath(getCachedAuthSession(), route.requiredPath))) {
    return;
  }

  void route.preload().catch(() => {
    // A speculative load failure must not prevent a later navigation attempt.
  });
}
