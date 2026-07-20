"use client";

import localforage from "localforage";

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

export const AUTH_SESSION_STORAGE_KEY = "chatgpt2api_auth_session";

const LOCALFORAGE_DATABASE_NAME = "chatgpt2api";

const authStorage = localforage.createInstance({
  name: LOCALFORAGE_DATABASE_NAME,
  storeName: "auth",
});

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  value.forEach((item) => {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    out.push(text);
  });
  return out;
}

function normalizeMenus(value: unknown): AuthMenuItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidate = item as Partial<AuthMenuItem>;
    const path = String(candidate.path || "").trim();
    const label = String(candidate.label || "").trim();
    if (!path || !label) {
      return [];
    }
    return [{
      id: String(candidate.id || path).trim(),
      label,
      path,
      icon: String(candidate.icon || "").trim(),
      order: typeof candidate.order === "number" ? candidate.order : 0,
      children: normalizeMenus(candidate.children),
    }];
  });
}

function normalizeSession(value: unknown, fallbackKey = ""): StoredAuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredAuthSession>;
  const key = String(candidate.key || fallbackKey || "").trim();
  const role = candidate.role === "admin" || candidate.role === "user" ? candidate.role : null;
  const creationConcurrentLimit = Number(candidate.creationConcurrentLimit);
  const creationRpmLimit = Number(candidate.creationRpmLimit ?? 0);
  if (!key || !role || !Number.isFinite(creationConcurrentLimit) || creationConcurrentLimit < 0) {
    return null;
  }

  return {
    key,
    role,
    roleId: String(candidate.roleId || "").trim(),
    roleName: String(candidate.roleName || "").trim(),
    subjectId: String(candidate.subjectId || "").trim(),
    username: String(candidate.username || "").trim(),
    name: String(candidate.name || "").trim(),
    provider: String(candidate.provider || "").trim(),
    creationConcurrentLimit,
    creationRpmLimit: Number.isFinite(creationRpmLimit) && creationRpmLimit > 0 ? creationRpmLimit : 0,
    menuPaths: normalizeStringList(candidate.menuPaths),
    apiPermissions: normalizeStringList(candidate.apiPermissions),
    menus: normalizeMenus(candidate.menus),
  };
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

export async function getStoredAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const session = normalizeSession(await authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY));
  return session;
}

export async function getStoredSessionToken() {
  const session = await getStoredAuthSession();
  return session?.key ?? "";
}

export async function setStoredAuthSession(session: StoredAuthSession) {
  const normalizedSession = normalizeSession(session);
  if (!normalizedSession) {
    await clearStoredAuthSession();
    return;
  }

  await authStorage.setItem(AUTH_SESSION_STORAGE_KEY, normalizedSession);
}

export async function clearStoredAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  await authStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
}
