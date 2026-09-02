"use client";

export const AUTH_SESSION_CHANGE_EVENT = "chatgpt2api:auth-session-change";

export type AuthRole = "admin" | "user";

type AuthMenuItem = {
  id: string;
  label: string;
  path: string;
  icon?: string;
  order?: number;
  children?: AuthMenuItem[];
};

export type StoredAuthSession = {
  /** Non-secret server credential identifier used only for client-side scoping. */
  key: string;
  role: AuthRole;
  roleId?: string;
  roleName?: string;
  subjectId: string;
  username?: string;
  name: string;
  provider?: string;
  creationConcurrentLimit: number;
  creationRpmLimit: number;
  menuPaths: string[];
  apiPermissions: string[];
  menus: AuthMenuItem[];
};

function canonicalMenuPath(path: string) {
  return path === "/image" ? "/studio" : path;
}

export function canAccessPath(session: StoredAuthSession | null | undefined, path: string) {
  if (!session) {
    return false;
  }
  if (path === "/profile") {
    return true;
  }
  if (session.role === "admin") {
    return true;
  }
  const requestedPath = canonicalMenuPath(path);
  return session.menuPaths.some((menuPath) => canonicalMenuPath(menuPath) === requestedPath);
}

export function hasAPIPermission(session: StoredAuthSession | null | undefined, method: string, path: string) {
  if (!session) {
    return false;
  }
  if (session.role === "admin") {
    return true;
  }
  return session.apiPermissions.includes(`${method.toLowerCase()}${path}`);
}

export function getDefaultRouteForSession(session: StoredAuthSession) {
  if (session.role === "admin") {
    return "/studio";
  }
  for (const path of [
    "/studio",
    "/canvas",
    "/workflows",
    "/prompt-library",
    "/assets",
    "/users",
    "/rbac",
    "/logs",
    "/settings",
    "/profile",
  ]) {
    if (canAccessPath(session, path)) {
      return path;
    }
  }
  return "/studio";
}
