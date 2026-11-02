"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement> & {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportTag?: React.ElementType;
  height?: number | string;
  maxHeight?: number | string;
  wrapStyle?: React.CSSProperties;
  viewClass?: string;
  viewStyle?: React.CSSProperties;
  tag?: React.ElementType;
  tabindex?: number | string;
  ariaLabel?: string;
};

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  {
    children,
    className,
    viewportClassName,
    viewportRef,
    viewportTag: ViewportTag = "div",
    height,
    maxHeight,
    wrapStyle,
    viewClass,
    viewStyle,
    tag: ViewTag = "div",
    tabindex,
    ariaLabel,
    onScroll,
    onWheel,
    ...props
  },
  ref,
) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const wheelRef = React.useRef(onWheel);
  wheelRef.current = onWheel;

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Stop enclosing canvases from consuming wheel input; the browser owns scrolling.
    const handleWheel = (event: WheelEvent) => {
      event.stopPropagation();
      wheelRef.current?.(event as unknown as React.WheelEvent<HTMLDivElement>);
    };
    root.addEventListener("wheel", handleWheel, { passive: false });
    return () => root.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <div
      {...props}
      ref={(element) => {
        rootRef.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
      className={cn("group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden", className)}
    >
      <ViewportTag
        data-slot="scroll-area-viewport"
        ref={viewportRef}
        tabIndex={tabindex === undefined ? undefined : Number(tabindex)}
        aria-label={ariaLabel}
        className={cn("scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20", viewportClassName)}
        style={{ ...wrapStyle, height: height ?? wrapStyle?.height, maxHeight: maxHeight ?? wrapStyle?.maxHeight }}
        onScroll={onScroll}
      >
        <ViewTag className={cn("min-w-0", viewClass)} style={viewStyle}>{children}</ViewTag>
      </ViewportTag>
    </div>
  );
});

function AppScrollArea(props: ScrollAreaProps) {
  return <ScrollArea {...props} />;
}

export { AppScrollArea, ScrollArea };
