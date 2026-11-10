import { useEffect, useRef, type ReactNode } from "react";

import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

export function CanvasMentionMenu<T>({ editor, getAnchorRect, items, activeIndex, getKey, renderItem, onActiveIndexChange, onSelect, onClose }: {
  editor: HTMLElement;
  getAnchorRect: () => DOMRect;
  items: readonly T[];
  activeIndex: number;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onActiveIndexChange: (index: number) => void;
  onSelect: (item: T) => void;
  onClose: () => void;
}) {
  const selectedRef = useRef(false);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const anchorRef = { current: { contextElement: editor, getBoundingClientRect: getAnchorRect } };

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);

  return (
    <Popover open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        data-canvas-mention-menu
        role="presentation"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        collisionBoundary={editor.closest<HTMLElement>("[role='dialog']")}
        className="w-72 max-w-(--radix-popover-content-available-width) max-h-[min(14rem,var(--radix-popover-content-available-height))] gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Let the editor consume Escape before changing its mention state.
          if (editor.ownerDocument.activeElement === editor) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (event.target instanceof Node && editor.contains(event.target)) event.preventDefault();
        }}
        onPointerDown={(event) => {
          // Preserve the text selection until an item is chosen.
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <Command
          shouldFilter={false}
          value={items[activeIndex] ? getKey(items[activeIndex]) : ""}
          onValueChange={(value) => {
            const index = items.findIndex(item => getKey(item) === value);
            if (index >= 0) onActiveIndexChange(index);
          }}
          className="min-h-0"
        >
          <CommandList label="引用画布资源" className="min-h-0 max-h-[min(13.5rem,calc(var(--radix-popover-content-available-height)-0.5rem))]">
            {items.map((item, index) => (
              <CommandItem
                key={getKey(item)}
                ref={index === activeIndex ? activeItemRef : undefined}
                value={getKey(item)}
                className="items-start"
                onSelect={() => {
                  if (selectedRef.current) return;
                  selectedRef.current = true;
                  onSelect(item);
                }}
              >
                {renderItem(item)}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
