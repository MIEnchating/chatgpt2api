import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";

import { useAuthGuard } from "@/lib/use-auth-guard";

const CanvasLibraryPage = lazy(() => import("@/app/canvas/library-page"));

export default function CanvasLibraryRoute() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/canvas");
  if (isCheckingAuth || !session) {
    return <div className="flex h-full min-h-[540px] items-center justify-center"><LoaderCircle className="size-6 animate-spin text-[#1456f0]" /></div>;
  }
  return <Suspense fallback={<div className="flex h-full min-h-[540px] items-center justify-center"><LoaderCircle className="size-6 animate-spin text-[#1456f0]" /></div>}><CanvasLibraryPage session={session} /></Suspense>;
}
