import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { Link } from "react-router-dom";
import { ArrowLeft, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFoundPage() {
  return (
    <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden h-full" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain [&>div]:block! [&>div]:h-full"><div className="min-w-0 grid place-items-center" style={{ minHeight: "100%" }}>
      <EmptyState icon={Search} title="找不到这个页面" description="链接可能已失效，请检查地址，或返回首页继续使用。" action={<Button asChild><Link to="/"><ArrowLeft />返回首页</Link></Button>} />
    </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
  );
}
