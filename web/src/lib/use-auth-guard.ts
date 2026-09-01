"use client";

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  canAccessPath,
  getDefaultRouteForSession,
  type AuthRole,
  type StoredAuthSession,
} from "@/lib/auth-session";
import { getCachedAuthSession, getVerifiedAuthSession } from "@/lib/session";

type UseAuthGuardResult = {
  isCheckingAuth: boolean;
  session: StoredAuthSession | null;
};

type VerifiedSessionHandler = (
  session: StoredAuthSession | null,
  finishChecking: () => void,
) => void;

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

function useVerifiedSessionLifecycle(
  initialChecking: () => boolean,
  onVerified: VerifiedSessionHandler,
) {
  const [isCheckingAuth, setIsCheckingAuth] = useState(initialChecking);
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
        onVerified(storedSession, () => setIsCheckingAuth(false));
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
  }, [onVerified, retryAuth, retryVersion]);

  return { isCheckingAuth };
}

export function useAuthGuard(allowedRoles?: AuthRole[], requiredPath?: string): UseAuthGuardResult {
  const navigate = useNavigate();
  const [session, setSession] = useState<StoredAuthSession | null>(() => getCachedAuthSession() ?? null);
  const allowedRolesKey = (allowedRoles || []).join(",");
  const handleVerifiedSession = useCallback<VerifiedSessionHandler>((storedSession, finishChecking) => {
    const roleList = allowedRolesKey ? (allowedRolesKey.split(",") as AuthRole[]) : [];

    if (!storedSession) {
      setSession(null);
      finishChecking();
      navigate("/login", { replace: true });
      return;
    }

    if (roleList.length > 0 && !roleList.includes(storedSession.role)) {
      setSession(storedSession);
      finishChecking();
      navigate(getDefaultRouteForSession(storedSession), { replace: true });
      return;
    }

    if (requiredPath && !canAccessPath(storedSession, requiredPath)) {
      setSession(storedSession);
      finishChecking();
      navigate(getDefaultRouteForSession(storedSession), { replace: true });
      return;
    }

    setSession(storedSession);
    finishChecking();
  }, [allowedRolesKey, navigate, requiredPath]);
  const { isCheckingAuth } = useVerifiedSessionLifecycle(
    () => getCachedAuthSession() === undefined,
    handleVerifiedSession,
  );

  return { isCheckingAuth, session };
}

export function useRedirectIfAuthenticated() {
  const navigate = useNavigate();
  const handleVerifiedSession = useCallback<VerifiedSessionHandler>((storedSession, finishChecking) => {
    if (storedSession) {
      navigate(getDefaultRouteForSession(storedSession), { replace: true });
      return;
    }

    finishChecking();
  }, [navigate]);
  const { isCheckingAuth } = useVerifiedSessionLifecycle(
    () => getCachedAuthSession() !== null,
    handleVerifiedSession,
  );

  return { isCheckingAuth };
}
