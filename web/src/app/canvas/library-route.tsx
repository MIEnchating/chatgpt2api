import { LoaderCircle } from "lucide-react";

import CanvasLibraryPage from "@/app/canvas/library-page";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function CanvasLibraryRoute() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/canvas");
  if (isCheckingAuth || !session) {
    return <div className="flex h-full min-h-0 items-center justify-center"><LoaderCircle className="size-6 animate-spin text-brand" /></div>;
  }
  return <CanvasLibraryPage session={session} />;
}
