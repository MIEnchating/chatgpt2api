"use client";

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  canAccessPath,
  getDefaultRouteForSession,
  type AuthRole,
  type StoredAuthSession,
} from "@/store/auth";
import { getCachedAuthSession, getVerifiedAuthSession } from "@/lib/session";

type UseAuthGuardResult = {
  isCheckingAuth: boolean;
  session: StoredAuthSession | null;
};

const AUTH_SESSION_ERROR_TOAST_ID = "auth-session-verification-error";

function sessionVerificationError(error: unknown) {
  return error instanceof Error ? error : new Error("登录状态验证失败");
}

function showSessionVerificationError(error: Error, retry: () => void) {
  toast.error("暂时无法验证登录状态", {
    id: AUTH_SESSION_ERROR_TOAST_ID,
    description: error.message,
    duration: Infinity,
    action: {
      label: "重试",
      onClick: retry,
    },
  });
}

export function useAuthGuard(allowedRoles?: AuthRole[], requiredPath?: string): UseAuthGuardResult {
  const navigate = useNavigate();
  const [session, setSession] = useState<StoredAuthSession | null>(() => getCachedAuthSession() ?? null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(() => getCachedAuthSession() === undefined);
  const [retryVersion, setRetryVersion] = useState(0);
  const allowedRolesKey = (allowedRoles || []).join(",");
  const retryAuth = useCallback(() => {
    setIsCheckingAuth(true);
    setRetryVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const roleList = allowedRolesKey ? (allowedRolesKey.split(",") as AuthRole[]) : [];
      try {
        const storedSession = await getVerifiedAuthSession();
        if (!active) {
          return;
        }

        toast.dismiss(AUTH_SESSION_ERROR_TOAST_ID);

        if (!storedSession) {
          setSession(null);
          setIsCheckingAuth(false);
          navigate("/login", { replace: true });
          return;
        }

        if (roleList.length > 0 && !roleList.includes(storedSession.role)) {
          setSession(storedSession);
          setIsCheckingAuth(false);
          navigate(getDefaultRouteForSession(storedSession), { replace: true });
          return;
        }

        if (requiredPath && !canAccessPath(storedSession, requiredPath)) {
          setSession(storedSession);
          setIsCheckingAuth(false);
          navigate(getDefaultRouteForSession(storedSession), { replace: true });
          return;
        }

        setSession(storedSession);
        setIsCheckingAuth(false);
      } catch (error) {
        if (!active) {
          return;
        }
        const verificationError = sessionVerificationError(error);
        setIsCheckingAuth(false);
        showSessionVerificationError(verificationError, retryAuth);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [allowedRolesKey, navigate, requiredPath, retryAuth, retryVersion]);

  return { isCheckingAuth, session };
}

export function useRedirectIfAuthenticated() {
  const navigate = useNavigate();
  const [isCheckingAuth, setIsCheckingAuth] = useState(() => getCachedAuthSession() !== null);
  const [retryVersion, setRetryVersion] = useState(0);
  const retryAuth = useCallback(() => {
    setIsCheckingAuth(true);
    setRetryVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const storedSession = await getVerifiedAuthSession();
        if (!active) {
          return;
        }

        toast.dismiss(AUTH_SESSION_ERROR_TOAST_ID);

        if (storedSession) {
          navigate(getDefaultRouteForSession(storedSession), { replace: true });
          return;
        }

        setIsCheckingAuth(false);
      } catch (error) {
        if (!active) {
          return;
        }
        const verificationError = sessionVerificationError(error);
        setIsCheckingAuth(false);
        showSessionVerificationError(verificationError, retryAuth);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [navigate, retryAuth, retryVersion]);

  return { isCheckingAuth };
}
