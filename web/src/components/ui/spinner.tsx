// shadcn/ui (MIT). See LICENSE.shadcn.
import { Loader2Icon } from "lucide-react"
import { cn } from "@/lib/utils"


function Spinner({ className, onAnimationStart, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="正在加载"
      className={cn("size-4 animate-spin motion-reduce:animate-none", className)}
      onAnimationStart={(event) => {
        // Align newly mounted indicators with the document animation timeline.
        for (const animation of event.currentTarget.getAnimations()) {
          animation.startTime = 0
        }
        onAnimationStart?.(event)
      }}
      {...props}
     />
  )
}

export { Spinner }
