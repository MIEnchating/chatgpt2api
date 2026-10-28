import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

type Position = { x: number; y: number };

export function useCanvasAgentPanelDrag(panelRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const positionRef = useRef(position);
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  function moveTo(next: Position) {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parent = panel.parentElement?.getBoundingClientRect();
    const fixed = getComputedStyle(panel).position === "fixed";
    const left = Math.max(0, fixed ? 0 : parent?.left || 0);
    const top = Math.max(0, fixed ? 0 : parent?.top || 0);
    const right = Math.min(window.innerWidth, fixed ? window.innerWidth : parent?.right || window.innerWidth);
    const bottom = Math.min(window.innerHeight, fixed ? window.innerHeight : parent?.bottom || window.innerHeight);
    const offsetParent = panel.offsetParent instanceof HTMLElement ? panel.offsetParent : null;
    const origin = offsetParent?.getBoundingClientRect();
    const baseX = panel.offsetLeft + (fixed ? 0 : (origin?.left || 0) + (offsetParent?.clientLeft || 0));
    const baseY = panel.offsetTop + (fixed ? 0 : (origin?.top || 0) + (offsetParent?.clientTop || 0));
    const clamped = {
      x: Math.max(left - baseX, Math.min(right - rect.width - baseX, next.x)),
      y: Math.max(top - baseY, Math.min(bottom - rect.height - baseY, next.y)),
    };
    positionRef.current = clamped;
    // Apply immediately so subsequent pointer events measure the current position.
    panel.style.translate = `${clamped.x}px ${clamped.y}px`;
    setPosition((current) => current.x === clamped.x && current.y === clamped.y ? current : clamped);
  }

  useLayoutEffect(() => {
    if (!enabled) {
      cleanupRef.current?.();
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const constrain = () => moveTo(positionRef.current);
    constrain();
    const observer = new ResizeObserver(constrain);
    observer.observe(panel);
    if (panel.parentElement) observer.observe(panel.parentElement);
    window.addEventListener("resize", constrain);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", constrain);
      cleanupRef.current?.();
    };
    // Geometry is read from the panel and the latest position ref.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, panelRef]);

  function startDrag(event: PointerEvent<HTMLElement>) {
    const targetElement = event.target instanceof Element ? event.target : null;
    // Portaled dialogs and popovers must never start dragging their React ancestor.
    if (!enabled || event.button !== 0 || !targetElement || !event.currentTarget.contains(targetElement)
      || targetElement.closest("button, a, input, select, [role='combobox']")) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupRef.current?.();
    const start = { ...positionRef.current };
    const startX = event.clientX;
    const startY = event.clientY;
    const target: HTMLElement = event.currentTarget;
    const pointerID = event.pointerId;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    const listeners = new AbortController();
    const stop = () => {
      listeners.abort();
      if (target.hasPointerCapture(pointerID)) target.releasePointerCapture(pointerID);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      cleanupRef.current = null;
      setDragging(false);
    };
    target.setPointerCapture(pointerID);
    target.addEventListener("pointermove", (move) => {
      if (move.pointerId === pointerID) moveTo({ x: start.x + move.clientX - startX, y: start.y + move.clientY - startY });
    }, { signal: listeners.signal });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) target.addEventListener(name, stop, { signal: listeners.signal });
    window.addEventListener("blur", stop, { signal: listeners.signal });
    cleanupRef.current = stop;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    setDragging(true);
  }

  return {
    dragging,
    translate: enabled ? `${position.x}px ${position.y}px` : undefined,
    startDrag,
    moveBy: (x: number, y: number) => { if (enabled) moveTo({ x: positionRef.current.x + x, y: positionRef.current.y + y }); },
  };
}
