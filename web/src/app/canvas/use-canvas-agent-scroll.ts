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
    let previousTop = viewport.scrollTop;
    const nearBottom = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 32;
    const onScroll = () => {
      if (viewport.scrollTop < previousTop) followingRef.current = false;
      if (nearBottom()) followingRef.current = true;
      previousTop = viewport.scrollTop;
      setShowLatest(!nearBottom());
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) followingRef.current = false; };
    const onKeyDown = (event: KeyboardEvent) => {
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
    viewport.addEventListener("keydown", onKeyDown);
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    observer.observe(content);
    scrollToLatest();
    previousTop = viewport.scrollTop;
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionID, enabled, scrollToLatest]);

  return { viewportRef, contentRef, showLatest, scrollToLatest, pause };
}
