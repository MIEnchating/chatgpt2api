import { useEffect, useState } from "react";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";

/** Remount account-owned state after an explicit session invalidation. */
export function useAuthSessionRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const handleSessionChange = () => setRevision((value) => value + 1);
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
  }, []);
  return revision;
}
