import { lazy, type ReactNode } from "react";

// Route configuration intentionally exports non-component metadata alongside
// lazy components; Fast Refresh does not apply to this module.
/* oxlint-disable react/only-export-components */

const CanvasRoute = lazy(() => import("@/app/canvas/route"));
const ImagePage = lazy(() => import("@/app/image/page"));
const ImageManagerPage = lazy(() => import("@/app/image-manager/page"));
const HomePage = lazy(() => import("@/app/page"));
const LoginPage = lazy(() => import("@/app/login/page"));
const LogsPage = lazy(() => import("@/app/logs/page"));
const ProfilePage = lazy(() => import("@/app/profile/page"));
const RBACPage = lazy(() => import("@/app/rbac/page"));
const SettingsPage = lazy(() => import("@/app/settings/page"));
const UsersPage = lazy(() => import("@/app/users/page"));

export type AppRouteConfig = {
  path: string;
  element: ReactNode;
  requiredPath?: string;
};

export const appRoutes: AppRouteConfig[] = [
  { path: "/", element: <HomePage /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/canvas", element: <CanvasRoute />, requiredPath: "/canvas" },
  { path: "/image-manager", element: <ImageManagerPage />, requiredPath: "/image-manager" },
  { path: "/users", element: <UsersPage />, requiredPath: "/users" },
  { path: "/profile", element: <ProfilePage />, requiredPath: "/profile" },
  { path: "/rbac", element: <RBACPage />, requiredPath: "/rbac" },
  { path: "/logs", element: <LogsPage />, requiredPath: "/logs" },
  { path: "/settings", element: <SettingsPage />, requiredPath: "/settings" },
  { path: "/image", element: <ImagePage />, requiredPath: "/image" },
  { path: "*", element: <HomePage /> },
];
