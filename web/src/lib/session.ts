"use client";

import { verifySession, type LoginResponse } from "@/lib/api";
import { clearAuthenticatedImageCache } from "@/lib/authenticated-image";
import type { StoredAuthSession } from "@/store/auth";

let cachedAuthSession: StoredAuthSession | null | undefined;
let verifyAuthSessionPromise: Promise<StoredAuthSession | null> | null = null;
let authSessionVersion = 0;
export const AUTH_SESSION_CHANGE_EVENT = "chatgpt2api:auth-session-change";

export function displaySubjectId(subjectId?: string | null, provider?: string) {
  const normalizedId = String(subjectId || "").trim();
  const normalizedProvider = String(provider || "").trim();
  const prefix = normalizedProvider ? `${normalizedProvider}:` : "";
  if (prefix && normalizedId.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedId.slice(prefix.length) || normalizedId;
  }
  return normalizedId || "-";
}

export function authSessionFromLoginResponse(data: LoginResponse): StoredAuthSession {
  const credentialId = String(data.credential_id || "").trim();
  if (!credentialId) {
    throw new Error("登录会话缺少凭据标识");
  }
  return {
    key: credentialId,
    role: data.role,
    roleId: data.role_id,
    roleName: data.role_name,
    subjectId: data.subject_id,
    username: data.username,
    name: data.name,
    provider: data.provider,
    creationConcurrentLimit: data.creation_concurrent_limit,
    creationRpmLimit: data.creation_rpm_limit,
    menuPaths: data.menu_paths || [],
    apiPermissions: data.api_permissions || [],
    menus: data.menus || [],
  };
}

function emitAuthSessionChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  }
}

export function getCachedAuthSession() {
  return cachedAuthSession;
}

function isUnauthenticatedSessionError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { status?: unknown }).status === 401;
}

export async function getVerifiedAuthSession(): Promise<StoredAuthSession | null> {
  if (cachedAuthSession !== undefined) {
    return cachedAuthSession;
  }

  const verifyStartedAtVersion = authSessionVersion;
  verifyAuthSessionPromise ??= verifyStoredAuthSession();
  try {
    const verifiedSession = await verifyAuthSessionPromise;
    if (verifyStartedAtVersion === authSessionVersion) {
      cachedAuthSession = verifiedSession;
      if (!verifiedSession) {
        clearAuthenticatedImageCache();
      }
      return verifiedSession;
    }
    return cachedAuthSession ?? null;
  } finally {
    if (verifyStartedAtVersion === authSessionVersion) {
      verifyAuthSessionPromise = null;
    }
  }
}

export async function setVerifiedAuthSession(session: StoredAuthSession) {
  authSessionVersion += 1;
  clearAuthenticatedImageCache();
  cachedAuthSession = session;
  verifyAuthSessionPromise = null;
  emitAuthSessionChange();
}

export async function clearVerifiedAuthSession() {
  authSessionVersion += 1;
  clearAuthenticatedImageCache();
  cachedAuthSession = null;
  verifyAuthSessionPromise = null;
  emitAuthSessionChange();
}

async function verifyStoredAuthSession(): Promise<StoredAuthSession | null> {
  try {
    const data = await verifySession();
    return authSessionFromLoginResponse(data);
  } catch (error) {
    if (isUnauthenticatedSessionError(error)) {
      return null;
    }
    throw error;
  }
}
