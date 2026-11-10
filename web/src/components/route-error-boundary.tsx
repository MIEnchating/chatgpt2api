import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
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
      <ScrollAreaRoot role="alert" data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden h-full p-4" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain [&>div]:block! [&>div]:h-full"><div className="min-w-0 grid place-items-center" style={{ minHeight: "100%" }}>
        <EmptyState icon={AlertTriangle} title="页面暂时无法显示" description="请重新加载页面后再试，也可以通过顶部导航前往其他页面。" action={<><Button variant="outline" asChild><Link to="/">返回首页</Link></Button><Button onClick={() => window.location.reload()}><RefreshCw />重新加载</Button></>} />
      </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
    );
  }
}
