import { RefreshCcw } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function PromptMarketSourceAlert({ sources, loading, onRetry }: { sources: string[]; loading: boolean; onRetry: () => void }) {
  if (!sources.length) return null;
  return (
    <Alert variant="destructive" className="flex flex-wrap items-center gap-2">
      <AlertDescription className="min-w-0 flex-1 [overflow-wrap:anywhere]">提示词来源读取失败：{sources.join("、")}</AlertDescription>
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onRetry}>
        <RefreshCcw />重试失败来源
      </Button>
    </Alert>
  );
}
