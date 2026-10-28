import { ScrollArea } from "@/components/ui/scroll-area";
import { Component, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export class RouteErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <ScrollArea role="alert" className="h-full min-h-0 rounded-xl border border-border bg-card p-4" viewClass="grid place-items-center" viewStyle={{ minHeight: "100%" }}>
        <EmptyState icon={AlertTriangle} title="页面暂时无法显示" description="请重新加载页面后再试，也可以通过顶部导航前往其他页面。" action={<><Button variant="outline" asChild><Link to="/">返回首页</Link></Button><Button onClick={() => window.location.reload()}><RefreshCw />重新加载</Button></>} />
      </ScrollArea>
    );
  }
}
