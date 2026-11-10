// shadcn/ui (MIT). See LICENSE.shadcn.
"use client"

import * as React from "react"
import { OverlayLayerProvider, useOverlayLayer } from "@/lib/use-overlay-layer"
import { Button } from "./button";
import { cn } from "@/lib/utils"
import { Tooltip as TooltipPrimitive } from "radix-ui"

const TOOLTIP_DELAY = 300;
const TOOLTIP_NAVIGATION_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
const TooltipSideContext = React.createContext<"top" | "right" | "bottom" | "left">("top");
const TooltipSideProvider = TooltipSideContext.Provider;
const TooltipFocusContext = React.createContext<React.RefObject<boolean>>({ current: false });

function TooltipProvider({ delayDuration = TOOLTIP_DELAY, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const keyboardNavigation = React.useRef(false);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { keyboardNavigation.current = TOOLTIP_NAVIGATION_KEYS.has(event.key); };
    const onPointerDown = () => { keyboardNavigation.current = false; };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  return <TooltipFocusContext.Provider value={keyboardNavigation}><TooltipPrimitive.Provider delayDuration={delayDuration} {...props} /></TooltipFocusContext.Provider>;
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ onFocus, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const keyboardNavigation = React.useContext(TooltipFocusContext);
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} onFocus={(event) => {
    onFocus?.(event);
    // Restoring focus after a dialog closes must not reopen the trigger tooltip.
    if (!keyboardNavigation.current) event.preventDefault();
  }} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  side,
  children,
  style,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const layer = useOverlayLayer("tooltip");
  const inheritedSide = React.useContext(TooltipSideContext);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-overlay-layer={layer}
        style={{ ...style, zIndex: layer }}
        sideOffset={sideOffset}
        side={side ?? inheritedSide}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}


type TooltipHintProps = Omit<React.ComponentProps<typeof TooltipContent>, "children" | "content"> & {
  children: React.ReactElement;
  content: React.ReactNode;
};

function TooltipHint({ children, content, ...contentProps }: TooltipHintProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        onPointerDown={() => setOpen(false)}
        onClick={() => setOpen(false)}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent {...contentProps}>{content}</TooltipContent>
    </Tooltip>
  );
}

type TooltipButtonProps = Omit<React.ComponentProps<typeof Button>, "title"> & {
  tooltip: React.ReactNode;
};

const TooltipButton = React.forwardRef<HTMLButtonElement, TooltipButtonProps>(
  ({ "aria-label": ariaLabel, tooltip, ...props }, ref) => (
    <TooltipHint content={tooltip}>
      <Button variant="ghost" size="icon-sm"
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
  const keyboardNavigation = React.useContext(TooltipFocusContext);
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
      if (!keyboardNavigation.current) return;
      const nextTarget = tooltipTarget(event.target);
      if (nextTarget) updateTarget(nextTarget);
    }

    function handleFocusOut(event: FocusEvent) {
      const currentTarget = targetRef.current;
      if (currentTarget && event.relatedTarget instanceof Node && currentTarget.contains(event.relatedTarget)) return;
      updateTarget(keyboardNavigation.current ? tooltipTarget(event.relatedTarget) : null);
    }
    function dismiss() { updateTarget(null); }
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape" || event.key === "Enter" || event.key === " ") dismiss(); }

    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", dismiss);
    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    return () => {
      clearOpenTimer();
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
    };
  }, [keyboardNavigation]);

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
    <OverlayLayerProvider value={Number(target.closest<HTMLElement>("[data-overlay-layer]")?.dataset.overlayLayer || 0)}>
    <Tooltip open={open} onOpenChange={setOpen}>
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
      <TooltipContent side={target.closest('[data-tooltip-side="right"]') ? "right" : undefined}>{target.dataset.tooltip}</TooltipContent>
    </Tooltip>
    </OverlayLayerProvider>
  );
}

export { Tooltip, TooltipButton, TooltipContent, TooltipDomBridge, TooltipHint, TooltipProvider, TooltipSideProvider, TooltipTrigger };
