import { lazy, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

// Route configuration intentionally exports non-component metadata alongside
// lazy components; Fast Refresh does not apply to this module.
/* oxlint-disable react/only-export-components */

const CanvasRoute = lazy(() => import("@/app/canvas/route"));
const CanvasLibraryRoute = lazy(() => import("@/app/canvas/library-route"));
const StudioPage = lazy(() => import("@/app/image/page"));
const AssetsPage = lazy(() => import("@/app/assets/page"));
const PromptLibraryPage = lazy(() => import("@/app/prompt-library/page"));
const HomePage = lazy(() => import("@/app/page"));
const LoginPage = lazy(() => import("@/app/login/page"));
const LogsPage = lazy(() => import("@/app/logs/page"));
const ProfilePage = lazy(() => import("@/app/profile/page"));
const RBACPage = lazy(() => import("@/app/rbac/page"));
const SettingsPage = lazy(() => import("@/app/settings/page"));
const UsersPage = lazy(() => import("@/app/users/page"));
const WorkflowsPage = lazy(() => import("@/app/workflows/page"));

export type AppRouteConfig = {
  path: string;
  element: ReactNode;
  requiredPath?: string;
};

function LegacyImageRoute() {
  const { hash, search } = useLocation();
  return <Navigate to={{ pathname: "/studio", search, hash }} replace />;
}

export const appRoutes: AppRouteConfig[] = [
  { path: "/", element: <HomePage /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/canvas/:projectID", element: <CanvasRoute />, requiredPath: "/canvas" },
  { path: "/canvas/editor", element: <CanvasRoute />, requiredPath: "/canvas" },
  { path: "/canvas", element: <CanvasLibraryRoute />, requiredPath: "/canvas" },
  { path: "/workflows", element: <WorkflowsPage />, requiredPath: "/workflows" },
  { path: "/assets", element: <AssetsPage />, requiredPath: "/assets" },
  { path: "/prompt-library", element: <PromptLibraryPage />, requiredPath: "/prompt-library" },
  { path: "/users", element: <UsersPage />, requiredPath: "/users" },
  { path: "/profile", element: <ProfilePage />, requiredPath: "/profile" },
  { path: "/rbac", element: <RBACPage />, requiredPath: "/rbac" },
  { path: "/logs", element: <LogsPage />, requiredPath: "/logs" },
  { path: "/settings", element: <SettingsPage />, requiredPath: "/settings" },
  { path: "/studio", element: <StudioPage />, requiredPath: "/studio" },
  { path: "/image", element: <LegacyImageRoute /> },
  { path: "*", element: <HomePage /> },
];
