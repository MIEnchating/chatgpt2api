import { useCallback, useEffect, useRef, useState } from "react";

export function useCanvasAgentScroll(sessionID: string, enabled: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const scrollToLatest = useCallback(() => {
    followingRef.current = true;
    setShowLatest(false);
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);
  const pause = useCallback(() => { followingRef.current = false; }, []);

  useEffect(() => {
    if (!enabled) return;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let frame = 0;
    let scrollFrame = 0;
    let previousTop = viewport.scrollTop;
    let allowResumeAtBottom = false;
    let touchY = 0;
    const nearBottom = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 32;
    const onScroll = () => {
      const movingUp = viewport.scrollTop < previousTop;
      if (movingUp) followingRef.current = false;
      else if (allowResumeAtBottom && viewport.scrollTop > previousTop && nearBottom()) followingRef.current = true;
      previousTop = viewport.scrollTop;
      if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        setShowLatest(!nearBottom());
      });
    };
    const onWheel = (event: WheelEvent) => {
      event.stopPropagation();
      allowResumeAtBottom = event.deltaY > 0;
      if (event.deltaY < 0) followingRef.current = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      followingRef.current = false;
      allowResumeAtBottom = event.target === viewport;
    };
    const onTouchStart = (event: TouchEvent) => {
      followingRef.current = false;
      allowResumeAtBottom = false;
      touchY = event.touches[0]?.clientY || 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY || 0;
      allowResumeAtBottom = nextY < touchY;
      if (!allowResumeAtBottom) followingRef.current = false;
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      allowResumeAtBottom = ["ArrowDown", "PageDown", "End"].includes(event.key);
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) followingRef.current = false;
    };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followingRef.current) {
          viewport.scrollTop = viewport.scrollHeight;
          previousTop = viewport.scrollTop;
        }
        setShowLatest(!nearBottom());
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("pointerdown", onPointerDown, { passive: true });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    viewport.addEventListener("keydown", onKeyDown);
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    observer.observe(content);
    scrollToLatest();
    previousTop = viewport.scrollTop;
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(scrollFrame);
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionID, enabled, scrollToLatest]);

  return { viewportRef, contentRef, showLatest, scrollToLatest, pause };
}
