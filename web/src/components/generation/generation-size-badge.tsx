import { Badge } from "@/components/ui/badge";

export function GenerationSizeBadge({ children, highResolution = false }: {
  children: string;
  highResolution?: boolean;
}) {
  return <Badge variant={highResolution ? "outline" : "secondary"} className="min-w-0 max-w-full whitespace-normal break-words">{children}</Badge>;
}
