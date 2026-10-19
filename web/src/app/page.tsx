"use client";

import { Navigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";

import { getDefaultRouteForSession } from "@/lib/auth-session";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function HomePage() {
  const { isCheckingAuth, session } = useAuthGuard();
  if (!isCheckingAuth && session) {
    return <Navigate to={getDefaultRouteForSession(session)} replace />;
  }
  if (!isCheckingAuth) {
    return <EmptyState icon={ShieldAlert} title="暂时无法验证登录状态" description="请检查连接后重新加载，或使用提示中的重试按钮。" className="h-full" action={<Button onClick={() => window.location.reload()}>重新加载</Button>} />;
  }
  return (
    <LoadingState label="正在验证登录状态" />
  );
}
