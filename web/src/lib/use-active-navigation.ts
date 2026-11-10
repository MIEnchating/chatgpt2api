import { useLayoutEffect, useRef } from "react";

export function useActiveNavigation(activeKey: string) {
  const navigationRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    navigationRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [activeKey]);
  return navigationRef;
}
