"use client";

export type AuthRole = "admin" | "user";

export type AuthMenuItem = {
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
  return session.menuPaths.includes(path);
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
    return "/image";
  }
  for (const path of ["/image", "/image-manager", "/settings", ...session.menuPaths, "/profile"]) {
    if (canAccessPath(session, path)) {
      return path;
    }
  }
  return "/image";
}
