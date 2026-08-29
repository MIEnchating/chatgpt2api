"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

export function OverflowMarqueeText({ text, className, play = "hover", delayMs = 0 }: { text: string; className?: string; play?: "hover" | "always"; delayMs?: number }) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [metrics, setMetrics] = useState({ contentWidth: 0, overflow: 0 });
  const [hovered, setHovered] = useState(false);
  const measure = useCallback(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const contentWidth = Math.ceil(content.scrollWidth);
    const overflow = Math.max(0, contentWidth - container.clientWidth);
    setMetrics((current) => current.contentWidth === contentWidth && current.overflow === overflow ? current : { contentWidth, overflow });
  }, []);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measure, text]);

  const animate = metrics.overflow > 0 && (play === "always" || hovered);
  const marqueeGap = 40;
  return (
    <span
      ref={containerRef}
      className={cn("block min-w-0 overflow-hidden whitespace-nowrap", className)}
      title={text}
      onMouseEnter={() => { measure(); setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className="inline-flex w-max min-w-full items-center"
        style={animate ? {
          "--overflow-marquee-distance": `-${metrics.contentWidth + marqueeGap}px`,
          animation: `overflow-marquee ${Math.max(8, (metrics.contentWidth + marqueeGap) / 44)}s linear infinite`,
          animationDelay: `${Math.max(0, delayMs)}ms`,
        } as CSSProperties : undefined}
      >
        <span ref={contentRef} className="block shrink-0">{text}</span>
        {animate ? <span aria-hidden="true" className="block shrink-0 pl-10">{text}</span> : null}
      </span>
    </span>
  );
}
