"use client";

import { Navigate } from "react-router-dom";

import { getDefaultRouteForSession } from "@/lib/auth-session";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function HomePage() {
  const { isCheckingAuth, session } = useAuthGuard();
  if (!isCheckingAuth && session) {
    return <Navigate to={getDefaultRouteForSession(session)} replace />;
  }
  return (
    <div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {isCheckingAuth ? "正在验证登录状态" : "暂时无法验证登录状态"}
    </div>
  );
}
