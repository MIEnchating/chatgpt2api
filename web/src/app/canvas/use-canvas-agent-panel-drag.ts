import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

type Position = { x: number; y: number };

export function useCanvasAgentPanelDrag(panelRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const positionRef = useRef(position);
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<Position | null>(null);
  const geometryRef = useRef<{ left: number; top: number; right: number; bottom: number; width: number; height: number; baseX: number; baseY: number } | null>(null);

  function measure() {
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
    geometryRef.current = {
      left, top, right, bottom, width: rect.width, height: rect.height,
      baseX: panel.offsetLeft + (fixed ? 0 : (origin?.left || 0) + (offsetParent?.clientLeft || 0)),
      baseY: panel.offsetTop + (fixed ? 0 : (origin?.top || 0) + (offsetParent?.clientTop || 0)),
    };
  }

  function flush() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const next = pendingPositionRef.current;
    pendingPositionRef.current = null;
    if (!next) return;
    const panel = panelRef.current;
    if (panel) panel.style.translate = `${next.x}px ${next.y}px`;
    setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
  }

  function moveTo(next: Position) {
    const panel = panelRef.current;
    if (!panel) return;
    if (!geometryRef.current) measure();
    const geometry = geometryRef.current;
    if (!geometry) return;
    const clamped = {
      x: Math.max(geometry.left - geometry.baseX, Math.min(geometry.right - geometry.width - geometry.baseX, next.x)),
      y: Math.max(geometry.top - geometry.baseY, Math.min(geometry.bottom - geometry.height - geometry.baseY, next.y)),
    };
    positionRef.current = clamped;
    pendingPositionRef.current = clamped;
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush);
  }

  useLayoutEffect(() => {
    if (!enabled) {
      cleanupRef.current?.();
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const constrain = () => { measure(); moveTo(positionRef.current); };
    constrain();
    const observer = new ResizeObserver(constrain);
    observer.observe(panel);
    if (panel.parentElement) observer.observe(panel.parentElement);
    window.addEventListener("resize", constrain);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", constrain);
      cleanupRef.current?.();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
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
    measure();
    const start = { ...positionRef.current };
    const startX = event.clientX;
    const startY = event.clientY;
    const target: HTMLElement = event.currentTarget;
    const pointerID = event.pointerId;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    const listeners = new AbortController();
    const stop = () => {
      flush();
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
    }, { signal: listeners.signal, passive: true });
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
    moveBy: (x: number, y: number) => { if (enabled) { moveTo({ x: positionRef.current.x + x, y: positionRef.current.y + y }); flush(); } },
  };
}
