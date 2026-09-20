import { useLayoutEffect, useRef } from "react";

export function useActiveNavigation(activeKey: string) {
  const navigationRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    if (!navigation) return;

    const revealActiveItem = () => {
      const activeItem = navigation.querySelector<HTMLElement>('[aria-current="page"]');
      if (!activeItem || navigation.scrollWidth <= navigation.clientWidth) return;
      const container = navigation.getBoundingClientRect();
      const item = activeItem.getBoundingClientRect();
      const inset = 4;
      const offset = item.left < container.left + inset
        ? item.left - container.left - inset
        : item.right > container.right - inset
          ? item.right - container.right + inset
          : 0;
      if (offset) navigation.scrollBy({ left: offset, behavior: "instant" });
    };

    revealActiveItem();
    const observer = new ResizeObserver(revealActiveItem);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [activeKey]);

  return navigationRef;
}
