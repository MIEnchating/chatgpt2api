"use client";

import { createContext, useContext, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import { GripVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ListState = {
  values: string[];
  onReorder: (values: string[]) => void;
  disabled: boolean;
  beginDrag: () => void;
  endDrag: (cancelled?: boolean) => void;
};
const ListContext = createContext<ListState | null>(null);
const ItemContext = createContext<{
  controls: ReturnType<typeof useDragControls>;
  disabled: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} | null>(null);

function sameOrder(first: string[], second: string[]) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

export function SortableList({ values, onReorder, disabled = false, children, ...props }: Omit<ComponentProps<typeof Reorder.Group<string, "div" | "tbody">>, "axis" | "onReorder" | "children"> & {
  onReorder: ListState["onReorder"];
  disabled?: boolean;
  children: (values: string[]) => ReactNode;
}) {
  const [preview, setPreview] = useState({ source: values, order: values });
  const dragState = useRef<"idle" | "dragging" | "cancelled">("idle");
  const currentOrder = useRef(values);
  const resetPreview = !sameOrder(preview.source, values) || (disabled && dragState.current === "dragging");
  const order = resetPreview ? values : preview.order;
  currentOrder.current = order;
  if (resetPreview) {
    if (dragState.current === "dragging") dragState.current = "cancelled";
    setPreview({ source: values, order: values });
  }

  function reorder(next: string[]) {
    if (disabled || dragState.current === "cancelled") return;
    if (dragState.current === "dragging") {
      // Avoid notifying page stores and persistence on every drag crossing.
      currentOrder.current = next;
      setPreview({ source: values, order: next });
    } else {
      onReorder(next);
    }
  }

  return <ListContext.Provider value={{ values: order, onReorder: reorder, disabled,
    beginDrag: () => { if (!disabled) dragState.current = "dragging"; },
    endDrag: (cancelled = false) => {
      const shouldCommit = dragState.current === "dragging" && !disabled && !cancelled;
      dragState.current = "idle";
      if (cancelled) {
        currentOrder.current = values;
        setPreview({ source: values, order: values });
      }
      if (shouldCommit && !sameOrder(currentOrder.current, values)) onReorder(currentOrder.current);
    },
  }}>
    <Reorder.Group as="div" {...props} axis="y" values={order} onReorder={reorder}>{children(order)}</Reorder.Group>
  </ListContext.Provider>;
}

export function SortableItem({ value, label, handle = true, className, children, ...props }: Omit<ComponentProps<typeof Reorder.Item<string, "div" | "tr">>, "value" | "onKeyDown" | "onDragStart" | "onDragEnd" | "onClickCapture" | "onPointerDownCapture" | "dragListener" | "dragControls"> & {
  value: string;
  label: string;
  handle?: boolean;
}) {
  const list = useContext(ListContext);
  const controls = useDragControls();
  const reducedMotion = useReducedMotion();
  const dragged = useRef(false);
  if (!list) throw new Error("SortableItem requires SortableList");
  const { values, onReorder, disabled } = list;

  function moveWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (disabled || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = values.indexOf(value);
    const target = event.key === "Home" ? 0 : event.key === "End" ? values.length - 1 : index + (event.key === "ArrowUp" ? -1 : 1);
    if (index < 0 || target < 0 || target >= values.length || target === index) return;
    const next = [...values];
    next.splice(index, 1);
    next.splice(target, 0, value);
    onReorder(next);
  }

  return <ItemContext.Provider value={{ controls, disabled: list.disabled, onKeyDown: moveWithKeyboard }}>
    <Reorder.Item
      as="div"
      {...props}
      value={value}
      aria-label={label}
      dragListener={!handle && !list.disabled}
      dragControls={controls}
      drag={list.disabled ? false : "y"}
      dragMomentum={false}
      dragTransition={{ bounceStiffness: 1000, bounceDamping: 60 }}
      layout="position"
      transition={{ layout: reducedMotion ? { duration: 0 } : { type: "tween", duration: 0.15, ease: "easeOut" } }}
      className={cn("relative min-w-0", !handle && !list.disabled && "touch-none cursor-grab active:cursor-grabbing", className)}
      onPointerDownCapture={() => { dragged.current = false; }}
      onDragStart={() => { dragged.current = true; list.beginDrag(); }}
      onDragEnd={(event) => list.endDrag(event.type === "pointercancel")}
      onClickCapture={(event: MouseEvent<HTMLElement>) => {
        if (event.detail !== 0 && dragged.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => { if (!handle && event.altKey) moveWithKeyboard(event); }}
    >{children}</Reorder.Item>
  </ItemContext.Provider>;
}

export function SortableHandle({ className, children, disabled, ...props }: Omit<ComponentProps<typeof Button>, "onPointerDown" | "onKeyDown">) {
  const item = useContext(ItemContext);
  if (!item) throw new Error("SortableHandle requires SortableItem");
  return <Button type="button" variant="ghost" size="icon-sm" {...props}
    disabled={disabled || item.disabled}
    className={cn("shrink-0 touch-none cursor-grab active:cursor-grabbing", className)}
    onPointerDown={(event) => { if (!disabled && !item.disabled && event.button === 0) item.controls.start(event); }}
    onKeyDown={item.onKeyDown}
  >{children || <GripVertical />}</Button>;
}
