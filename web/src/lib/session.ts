"use client";

import { verifySession, type LoginResponse } from "@/lib/api";
import { clearAuthenticatedImageCache } from "@/lib/authenticated-image";
import { AUTH_SESSION_CHANGE_EVENT, type StoredAuthSession } from "@/lib/auth-session";

let cachedAuthSession: StoredAuthSession | null | undefined;
let verifyAuthSessionPromise: Promise<StoredAuthSession | null> | null = null;
let authSessionVersion = 0;
const AUTH_SESSION_CHANNEL_NAME = "chatgpt2api:auth-session";
const AUTH_SESSION_INVALIDATED_MESSAGE = "invalidate";

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

const authSessionChannel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel(AUTH_SESSION_CHANNEL_NAME)
  : null;

function invalidateVerifiedAuthSession() {
  authSessionVersion += 1;
  clearAuthenticatedImageCache();
  cachedAuthSession = undefined;
  verifyAuthSessionPromise = null;
  emitAuthSessionChange();
}

authSessionChannel?.addEventListener("message", (event) => {
  if (event.data === AUTH_SESSION_INVALIDATED_MESSAGE) {
    invalidateVerifiedAuthSession();
  }
});

function notifyOtherTabs() {
  authSessionChannel?.postMessage(AUTH_SESSION_INVALIDATED_MESSAGE);
}

export function getCachedAuthSession() {
  return cachedAuthSession;
}

function sameAuthSession(
  left: StoredAuthSession | null | undefined,
  right: StoredAuthSession | null,
) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function isUnauthenticatedSessionError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { status?: unknown }).status === 401;
}

async function loadVerifiedAuthSession(forceRefresh: boolean): Promise<StoredAuthSession | null> {
  if (!forceRefresh && cachedAuthSession !== undefined) {
    return cachedAuthSession;
  }

  const verifyStartedAtVersion = authSessionVersion;
  verifyAuthSessionPromise ??= verifyStoredAuthSession();
  try {
    const verifiedSession = await verifyAuthSessionPromise;
    if (verifyStartedAtVersion === authSessionVersion) {
      const changed = forceRefresh && !sameAuthSession(cachedAuthSession, verifiedSession);
      cachedAuthSession = verifiedSession;
      if (!verifiedSession) {
        clearAuthenticatedImageCache();
      }
      if (changed) {
        emitAuthSessionChange();
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

export function getVerifiedAuthSession(): Promise<StoredAuthSession | null> {
  return loadVerifiedAuthSession(false);
}

export function refreshVerifiedAuthSession(): Promise<StoredAuthSession | null> {
  return loadVerifiedAuthSession(true);
}

export async function setVerifiedAuthSession(session: StoredAuthSession) {
  authSessionVersion += 1;
  clearAuthenticatedImageCache();
  cachedAuthSession = session;
  verifyAuthSessionPromise = null;
  emitAuthSessionChange();
  notifyOtherTabs();
}

export async function clearVerifiedAuthSession() {
  authSessionVersion += 1;
  clearAuthenticatedImageCache();
  cachedAuthSession = null;
  verifyAuthSessionPromise = null;
  emitAuthSessionChange();
  notifyOtherTabs();
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
