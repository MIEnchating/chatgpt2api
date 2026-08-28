"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const TOOLTIP_DELAY = 300;

function TooltipProvider({ delayDuration = TOOLTIP_DELAY, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root {...props} />;
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({ className, sideOffset = 10, children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-[200] max-w-[min(20rem,calc(100vw-1.5rem))] rounded-md border border-border/70 bg-popover px-2.5 py-2 text-xs leading-5 text-popover-foreground shadow-[0_10px_30px_-12px_rgba(15,23,42,0.38)] outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow width={14} height={7} asChild>
          <svg className="overflow-visible" aria-hidden="true">
            <path className="fill-popover" d="M-2-1H32L15 10Z" />
            <path
              className="fill-none stroke-border/70"
              d="M0 0 15 10 30 0"
              strokeWidth={1}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </TooltipPrimitive.Arrow>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

type TooltipHintProps = Omit<React.ComponentProps<typeof TooltipContent>, "children" | "content"> & {
  children: React.ReactElement;
  content: React.ReactNode;
};

function TooltipHint({ children, content, ...contentProps }: TooltipHintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent {...contentProps}>{content}</TooltipContent>
    </Tooltip>
  );
}

type TooltipButtonProps = Omit<React.ComponentProps<"button">, "title"> & {
  tooltip: React.ReactNode;
};

const TooltipButton = React.forwardRef<HTMLButtonElement, TooltipButtonProps>(
  ({ "aria-label": ariaLabel, tooltip, ...props }, ref) => (
    <TooltipHint content={tooltip}>
      <button
        ref={ref}
        aria-label={ariaLabel || (typeof tooltip === "string" ? tooltip : undefined)}
        {...props}
      />
    </TooltipHint>
  ),
);

TooltipButton.displayName = "TooltipButton";

type TooltipAnchorRect = {
  height: number;
  left: number;
  top: number;
  width: number;
};

function TooltipDomBridge() {
  const [target, setTarget] = React.useState<HTMLElement | null>(null);
  const [anchorRect, setAnchorRect] = React.useState<TooltipAnchorRect | null>(null);
  const [open, setOpen] = React.useState(false);
  const targetRef = React.useRef<HTMLElement | null>(null);
  const openTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    function clearOpenTimer() {
      if (openTimerRef.current === null) return;
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }

    function updateTarget(nextTarget: HTMLElement | null) {
      if (targetRef.current === nextTarget) return;
      clearOpenTimer();
      targetRef.current = nextTarget;
      setTarget(nextTarget);
      setOpen(false);
      if (!nextTarget) return;
      openTimerRef.current = window.setTimeout(() => {
        if (targetRef.current === nextTarget) setOpen(true);
      }, TOOLTIP_DELAY);
    }

    function tooltipTarget(eventTarget: EventTarget | null) {
      if (!(eventTarget instanceof Element)) return null;
      const nextTarget = eventTarget.closest<HTMLElement>("[data-tooltip]");
      return nextTarget?.dataset.tooltip?.trim() ? nextTarget : null;
    }

    function handlePointerOver(event: PointerEvent) {
      updateTarget(tooltipTarget(event.target));
    }

    function handlePointerOut(event: PointerEvent) {
      const currentTarget = targetRef.current;
      if (currentTarget && event.relatedTarget instanceof Node && currentTarget.contains(event.relatedTarget)) return;
      updateTarget(tooltipTarget(event.relatedTarget));
    }

    function handleFocusIn(event: FocusEvent) {
      const nextTarget = tooltipTarget(event.target);
      if (nextTarget) updateTarget(nextTarget);
    }

    function handleFocusOut(event: FocusEvent) {
      const currentTarget = targetRef.current;
      if (currentTarget && event.relatedTarget instanceof Node && currentTarget.contains(event.relatedTarget)) return;
      updateTarget(tooltipTarget(event.relatedTarget));
    }

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    return () => {
      clearOpenTimer();
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
    };
  }, []);

  React.useLayoutEffect(() => {
    if (!target) {
      setAnchorRect(null);
      return;
    }

    function updateAnchorRect() {
      if (!target?.isConnected) {
        targetRef.current = null;
        setTarget(null);
        setOpen(false);
        return;
      }
      const rect = target.getBoundingClientRect();
      setAnchorRect({ height: rect.height, left: rect.left, top: rect.top, width: rect.width });
    }

    updateAnchorRect();
    const resizeObserver = new ResizeObserver(updateAnchorRect);
    resizeObserver.observe(target);
    window.addEventListener("resize", updateAnchorRect);
    window.addEventListener("scroll", updateAnchorRect, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateAnchorRect);
      window.removeEventListener("scroll", updateAnchorRect, true);
    };
  }, [target]);

  if (!target || !anchorRect) return null;

  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed"
          style={{
            height: Math.max(anchorRect.height, 1),
            left: anchorRect.left,
            top: anchorRect.top,
            width: Math.max(anchorRect.width, 1),
          }}
        />
      </TooltipTrigger>
      <TooltipContent>{target.dataset.tooltip}</TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipButton, TooltipContent, TooltipDomBridge, TooltipHint, TooltipProvider, TooltipTrigger };
