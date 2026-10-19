import { Link } from "react-router-dom";
import { ArrowLeft, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFoundPage() {
  return (
    <div className="grid h-full min-h-0 place-items-center overflow-y-auto rounded-xl border border-border bg-card">
      <EmptyState icon={Search} title="找不到这个页面" description="链接可能已失效，请检查地址，或返回首页继续使用。" action={<Button asChild><Link to="/"><ArrowLeft />返回首页</Link></Button>} />
    </div>
  );
}
