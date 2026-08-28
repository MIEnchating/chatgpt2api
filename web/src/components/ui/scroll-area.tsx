"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type ScrollDirection = "top" | "bottom" | "left" | "right";
type ScrollPosition = { scrollTop: number; scrollLeft: number };

export type ScrollAreaHandle = HTMLDivElement & {
  wrapRef?: HTMLDivElement | null;
  update?: () => void;
  setScrollTop?: (value: number) => void;
  setScrollLeft?: (value: number) => void;
  handleScroll?: () => void;
  getScrollMetrics?: () => ScrollMetricsSnapshot;
};

type ScrollMetricsSnapshot = ScrollPosition & {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
};

type ScrollAreaProps = Omit<React.HTMLAttributes<HTMLDivElement>, "onScroll"> & {
  viewportClassName?: string;
  /** Ref for Element Plus' wrap element. */
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Custom component used for the actual scrolling viewport. */
  viewportTag?: React.ElementType;
  height?: number | string;
  maxHeight?: number | string;
  native?: boolean;
  manageKeyboard?: boolean;
  wrapStyle?: React.CSSProperties;
  viewClass?: string;
  viewStyle?: React.CSSProperties;
  noresize?: boolean;
  tag?: React.ElementType;
  always?: boolean;
  minSize?: number;
  distance?: number;
  tabindex?: number | string;
  ariaLabel?: string;
  ariaOrientation?: "horizontal" | "vertical" | "undefined";
  onScroll?: (position: ScrollPosition) => void;
  onEndReached?: (direction: ScrollDirection) => void;
};

type ScrollMetrics = {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
};

const EMPTY_METRICS: ScrollMetrics = {
  viewportWidth: 0,
  viewportHeight: 0,
  contentWidth: 0,
  contentHeight: 0,
};

const toCssSize = (value: number | string | undefined) => {
  if (value === undefined || value === "") return undefined;
  return typeof value === "number" ? `${value}px` : value;
};

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, Math.max(0, max)));

const ScrollArea = React.forwardRef<ScrollAreaHandle, ScrollAreaProps>(function ScrollArea(
  {
    children,
    className,
    style,
    viewportClassName,
    viewportRef,
    viewportTag: ViewportTag = "div",
    height = "",
    maxHeight = "",
    native = false,
    manageKeyboard = true,
    wrapStyle = {},
    viewClass = "",
    viewStyle = {},
    noresize = false,
    tag: ViewTag = "div",
    always = false,
    minSize = 20,
    distance = 0,
    tabindex,
    id,
    role,
    ariaLabel,
    ariaOrientation,
    onScroll,
    onEndReached,
    onWheel,
    onKeyDown,
    ...rootProps
  },
  forwardedRef,
) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<HTMLElement | null>(null);
  const dragRef = React.useRef({ axis: "y" as "x" | "y", active: false, start: 0, startScroll: 0 });
  const reachedRef = React.useRef({ left: false, right: false, top: false, bottom: false });
  const previousScrollRef = React.useRef<ScrollPosition | null>(null);
  const scrollRef = React.useRef<ScrollPosition>({ scrollTop: 0, scrollLeft: 0 });
  const [metrics, setMetrics] = React.useState<ScrollMetrics>(EMPTY_METRICS);
  const metricsRef = React.useRef<ScrollMetrics>(EMPTY_METRICS);
  const [scroll, setScroll] = React.useState<ScrollPosition>({ scrollTop: 0, scrollLeft: 0 });
  const [interacting, setInteracting] = React.useState(always);

  const effectiveAlways = always;
  const setRootRef = React.useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    if (typeof forwardedRef === "function") forwardedRef(element as ScrollAreaHandle | null);
    else if (forwardedRef) forwardedRef.current = element as ScrollAreaHandle | null;
  }, [forwardedRef]);

  const setWrapRef = React.useCallback((element: HTMLDivElement | null) => {
    wrapRef.current = element;
    if (typeof viewportRef === "function") viewportRef(element);
    else if (viewportRef) viewportRef.current = element;
  }, [viewportRef]);

  const measure = React.useCallback(() => {
    const wrap = wrapRef.current;
    const view = viewRef.current;
    if (!wrap || !view) return;
    const viewBounds = view.getBoundingClientRect();
    const viewportWidth = wrap.clientWidth || rootRef.current?.clientWidth || 0;
    const viewportHeight = wrap.clientHeight || rootRef.current?.clientHeight || 0;
    // Measure the actual wrap as Element Plus does. This is important for
    // flex layouts where the view's own box can be the same height as the
    // viewport even though descendants overflow it.
    const measuredContentWidth = Math.max(wrap.scrollWidth, view.scrollWidth, view.offsetWidth, viewBounds.width);
    const measuredContentHeight = Math.max(wrap.scrollHeight, view.scrollHeight, view.offsetHeight, viewBounds.height);
    const previous = metricsRef.current;
    const next: ScrollMetrics = {
      viewportWidth,
      viewportHeight,
      contentWidth: Math.max(viewportWidth, measuredContentWidth || previous.contentWidth),
      contentHeight: Math.max(viewportHeight, measuredContentHeight || previous.contentHeight),
    };
    const current = scrollRef.current;
    const clamped = {
      scrollTop: clamp(current.scrollTop, next.contentHeight - next.viewportHeight),
      scrollLeft: clamp(current.scrollLeft, next.contentWidth - next.viewportWidth),
    };
    scrollRef.current = clamped;
    metricsRef.current = next;
    setMetrics(next);
    setScroll(clamped);
  }, []);

  React.useLayoutEffect(() => {
    measure();
    if (noresize || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (wrapRef.current) observer.observe(wrapRef.current);
    if (viewRef.current) observer.observe(viewRef.current);
    return () => observer.disconnect();
  }, [children, measure, noresize]);

  const showScrollbar = React.useCallback(() => {
    if (effectiveAlways) return;
    setInteracting(true);
  }, [effectiveAlways]);

  const hideScrollbar = React.useCallback(() => {
    if (effectiveAlways || dragRef.current.active) return;
    setInteracting(false);
  }, [effectiveAlways]);

  const handleMouseMove = React.useCallback(() => {
    showScrollbar();
  }, [showScrollbar]);

  const handleMouseLeave = React.useCallback(() => {
    hideScrollbar();
  }, [hideScrollbar]);

  const updateScroll = React.useCallback((next: Partial<ScrollPosition>, reveal = true) => {
    const current = scrollRef.current;
    const position = {
      scrollTop: clamp(next.scrollTop ?? current.scrollTop, metrics.contentHeight - metrics.viewportHeight),
      scrollLeft: clamp(next.scrollLeft ?? current.scrollLeft, metrics.contentWidth - metrics.viewportWidth),
    };
    scrollRef.current = position;
    const wrap = wrapRef.current;
    if (wrap) {
      wrap.scrollTop = position.scrollTop;
      wrap.scrollLeft = position.scrollLeft;
    }
    setScroll(position);
    if (reveal) showScrollbar();
  }, [metrics, showScrollbar]);

  React.useEffect(() => {
    const root = rootRef.current;
    const wrap = wrapRef.current;
    if (!root || !wrap) return;
    const handleNativeWheel = (event: WheelEvent) => {
      // Keep wheel input inside the scroll area instead of letting canvas
      // zoom consume it. Canvas uses touch-action:none and a non-passive wheel
      // listener, so drive the native viewport directly in that context.
      event.stopPropagation();
      showScrollbar();
      onWheel?.(event as unknown as React.WheelEvent<HTMLDivElement>);
      if (event.defaultPrevented || !root.closest("[data-canvas-export-root]")) return;

      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(1, wrap.clientHeight)
          : 1;
      let deltaX = event.deltaX * deltaScale;
      let deltaY = event.deltaY * deltaScale;
      if (event.shiftKey && deltaX === 0) {
        deltaX = deltaY;
        deltaY = 0;
      }

      const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
      const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const nextTop = clamp(wrap.scrollTop + deltaY, maxTop);
      const nextLeft = clamp(wrap.scrollLeft + deltaX, maxLeft);
      if (nextTop === wrap.scrollTop && nextLeft === wrap.scrollLeft) return;

      event.preventDefault();
      wrap.scrollTop = nextTop;
      wrap.scrollLeft = nextLeft;
    };
    // Listen on the root so wheel input over the custom thumb/track is owned
    // by the same viewport as wheel input over its content.
    root.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => root.removeEventListener("wheel", handleNativeWheel);
  }, [onWheel, showScrollbar]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(80, metrics.viewportHeight * 0.85);
    if (event.key === "ArrowDown") { event.preventDefault(); updateScroll({ scrollTop: scrollRef.current.scrollTop + 48 }); }
    else if (event.key === "ArrowUp") { event.preventDefault(); updateScroll({ scrollTop: scrollRef.current.scrollTop - 48 }); }
    else if (event.key === "PageDown") { event.preventDefault(); updateScroll({ scrollTop: scrollRef.current.scrollTop + page }); }
    else if (event.key === "PageUp") { event.preventDefault(); updateScroll({ scrollTop: scrollRef.current.scrollTop - page }); }
    else if (event.key === "Home") { event.preventDefault(); updateScroll({ scrollTop: 0 }); }
    else if (event.key === "End") { event.preventDefault(); updateScroll({ scrollTop: metrics.contentHeight }); }
    onKeyDown?.(event);
  }, [metrics.contentHeight, metrics.viewportHeight, onKeyDown, updateScroll]);

  const handleNativeScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const next = { scrollTop: target.scrollTop, scrollLeft: target.scrollLeft };
    scrollRef.current = next;
    setScroll(next);
    showScrollbar();
  }, [showScrollbar]);

  React.useEffect(() => {
    const previous = previousScrollRef.current;
    previousScrollRef.current = scroll;
    if (!previous || (previous.scrollTop === scroll.scrollTop && previous.scrollLeft === scroll.scrollLeft)) return;
    onScroll?.(scroll);
    const threshold = Math.max(0, distance);
    const direction: ScrollDirection = scroll.scrollTop !== previous.scrollTop
      ? (scroll.scrollTop > previous.scrollTop ? "bottom" : "top")
      : (scroll.scrollLeft > previous.scrollLeft ? "right" : "left");
    const arrived = direction === "top"
      ? scroll.scrollTop <= threshold && previous.scrollTop !== 0
      : direction === "bottom"
        ? metrics.contentHeight - metrics.viewportHeight - scroll.scrollTop <= threshold
        : direction === "left"
          ? scroll.scrollLeft <= threshold && previous.scrollLeft !== 0
          : metrics.contentWidth - metrics.viewportWidth - scroll.scrollLeft <= threshold;
    if (arrived && !reachedRef.current[direction]) onEndReached?.(direction);
    const atTop = scroll.scrollTop <= threshold;
    const atBottom = metrics.contentHeight - metrics.viewportHeight - scroll.scrollTop <= threshold;
    const atLeft = scroll.scrollLeft <= threshold;
    const atRight = metrics.contentWidth - metrics.viewportWidth - scroll.scrollLeft <= threshold;
    reachedRef.current = { top: atTop, bottom: atBottom, left: atLeft, right: atRight };
  }, [distance, metrics, onEndReached, onScroll, scroll]);

  const verticalOverflow = Math.max(0, metrics.contentHeight - metrics.viewportHeight);
  const horizontalOverflow = Math.max(0, metrics.contentWidth - metrics.viewportWidth);
  const verticalThumbHeight = verticalOverflow > 0
    ? Math.min(metrics.viewportHeight - 8, Math.max(minSize, (metrics.viewportHeight / metrics.contentHeight) * metrics.viewportHeight))
    : 0;
  const horizontalThumbWidth = horizontalOverflow > 0
    ? Math.min(metrics.viewportWidth - 8, Math.max(minSize, (metrics.viewportWidth / metrics.contentWidth) * metrics.viewportWidth))
    : 0;
  const verticalTravel = Math.max(0, metrics.viewportHeight - verticalThumbHeight - 8);
  const horizontalTravel = Math.max(0, metrics.viewportWidth - horizontalThumbWidth - 8);
  const verticalThumbTop = verticalOverflow ? 4 + (scroll.scrollTop / verticalOverflow) * verticalTravel : 4;
  const horizontalThumbLeft = horizontalOverflow ? 4 + (scroll.scrollLeft / horizontalOverflow) * horizontalTravel : 4;

  const startThumbDrag = (axis: "x" | "y", event: React.PointerEvent<HTMLButtonElement>) => {
    const overflow = axis === "y" ? verticalOverflow : horizontalOverflow;
    if (!overflow) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { axis, active: true, start: axis === "y" ? event.clientY : event.clientX, startScroll: axis === "y" ? scrollRef.current.scrollTop : scrollRef.current.scrollLeft };
    event.currentTarget.setPointerCapture(event.pointerId);
    showScrollbar();
  };

  const moveThumbDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active) return;
    const axis = dragRef.current.axis;
    const delta = (axis === "y" ? event.clientY : event.clientX) - dragRef.current.start;
    const travel = axis === "y" ? verticalTravel : horizontalTravel;
    const overflow = axis === "y" ? verticalOverflow : horizontalOverflow;
    if (!travel) return;
    updateScroll(axis === "y" ? { scrollTop: dragRef.current.startScroll + (delta / travel) * overflow } : { scrollLeft: dragRef.current.startScroll + (delta / travel) * overflow });
  };

  const endThumbDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    hideScrollbar();
  };

  const handleTrackPointerDown = (axis: "x" | "y", event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (axis === "y" && verticalOverflow && verticalTravel) {
      const ratio = (event.clientY - rect.top - verticalThumbHeight / 2) / Math.max(1, rect.height - verticalThumbHeight);
      updateScroll({ scrollTop: ratio * verticalOverflow });
    } else if (axis === "x" && horizontalOverflow && horizontalTravel) {
      const ratio = (event.clientX - rect.left - horizontalThumbWidth / 2) / Math.max(1, rect.width - horizontalThumbWidth);
      updateScroll({ scrollLeft: ratio * horizontalOverflow });
    }
  };

  React.useImperativeHandle(forwardedRef, () => {
    const root = rootRef.current as ScrollAreaHandle;
    if (!root) return root;
    root.wrapRef = wrapRef.current;
    root.update = measure;
    root.scrollTo = ((x?: number | globalThis.ScrollToOptions, y?: number) => {
      if (typeof x === "number") updateScroll({ scrollLeft: x, scrollTop: y ?? scrollRef.current.scrollTop });
      else updateScroll({ scrollLeft: x?.left, scrollTop: x?.top });
    }) as HTMLDivElement["scrollTo"];
    root.setScrollTop = (value) => updateScroll({ scrollTop: value });
    root.setScrollLeft = (value) => updateScroll({ scrollLeft: value });
    root.handleScroll = () => onScroll?.(scrollRef.current);
    root.getScrollMetrics = () => ({
      ...scrollRef.current,
      scrollHeight: metricsRef.current.contentHeight,
      clientHeight: metricsRef.current.viewportHeight,
      scrollWidth: metricsRef.current.contentWidth,
      clientWidth: metricsRef.current.viewportWidth,
    });
    return root;
  }, [measure, onScroll, updateScroll]);

  const rootStyle: React.CSSProperties = { ...style };
  const wrapStyles: React.CSSProperties = {
    ...wrapStyle,
    minHeight: wrapStyle.minHeight ?? 0,
    height: toCssSize(height) ?? wrapStyle.height,
    maxHeight: toCssSize(maxHeight) ?? wrapStyle.maxHeight,
  };
  const viewStyles: React.CSSProperties = {
    ...viewStyle,
    minHeight: viewStyle.minHeight ?? "max-content",
    willChange: viewStyle.willChange,
    transform: undefined,
  };
  const wrapClasses = cn(
    "scroll-area-viewport relative min-h-0 w-full flex-1 outline-none",
    native
      ? "overflow-auto"
      : "overflow-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
    viewportClassName,
  );

  return (
    <div
      ref={setRootRef}
      className={cn("group/scroll-area relative flex min-h-0 w-full flex-col overflow-hidden", className)}
      style={rootStyle}
      {...rootProps}
      onKeyDown={native || !manageKeyboard ? onKeyDown : handleKeyDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <ViewportTag ref={setWrapRef} tabIndex={tabindex === undefined ? undefined : Number(tabindex)} className={wrapClasses} style={wrapStyles} onScroll={handleNativeScroll}>
        <ViewTag ref={viewRef} id={id} role={role} aria-label={ariaLabel} aria-orientation={ariaOrientation === "undefined" ? undefined : ariaOrientation} className={cn("min-w-0", viewClass)} style={viewStyles}>
          {children}
        </ViewTag>
      </ViewportTag>
      {!native && verticalOverflow > 0 ? (
        <div className={cn("absolute inset-y-0 right-0 z-20 w-2", effectiveAlways || interacting ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")} aria-hidden="true" onPointerDown={(event) => handleTrackPointerDown("y", event)}>
          <button type="button" tabIndex={-1} className="pointer-events-auto absolute left-0.5 w-1.5 rounded-full bg-[#9297a2]/70 transition-colors hover:bg-[#737985] dark:bg-[#a2a8b4]/65 dark:hover:bg-[#c0c4cc]" style={{ height: verticalThumbHeight, top: verticalThumbTop }} onPointerDown={(event) => startThumbDrag("y", event)} onPointerMove={moveThumbDrag} onPointerUp={endThumbDrag} onPointerCancel={endThumbDrag} />
        </div>
      ) : null}
      {!native && horizontalOverflow > 0 ? (
        <div className={cn("absolute bottom-0 left-0 z-20 h-2 w-full", effectiveAlways || interacting ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")} aria-hidden="true" onPointerDown={(event) => handleTrackPointerDown("x", event)}>
          <button type="button" tabIndex={-1} className="pointer-events-auto absolute top-0.5 h-1.5 rounded-full bg-[#9297a2]/70 transition-colors hover:bg-[#737985] dark:bg-[#a2a8b4]/65 dark:hover:bg-[#c0c4cc]" style={{ width: horizontalThumbWidth, left: horizontalThumbLeft }} onPointerDown={(event) => startThumbDrag("x", event)} onPointerMove={moveThumbDrag} onPointerUp={endThumbDrag} onPointerCancel={endThumbDrag} />
        </div>
      ) : null}
    </div>
  );
});

function AppScrollArea(props: ScrollAreaProps) {
  return <ScrollArea {...props} />;
}

export { AppScrollArea, ScrollArea };
