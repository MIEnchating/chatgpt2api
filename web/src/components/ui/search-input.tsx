import { useRef, type ComponentProps } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SearchInputProps = Omit<ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
  containerClassName?: string;
};

export function SearchInput({ value, onValueChange, containerClassName, className, onKeyDown, ...props }: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const clear = () => {
    onValueChange("");
    inputRef.current?.focus();
  };

  return (
    <div className={cn("relative min-w-0", containerClassName)} data-search-input>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        {...props}
        ref={inputRef}
        type="search"
        value={value}
        aria-label={props["aria-label"] || props.placeholder || "搜索"}
        className={cn("pl-9 pr-10 [&::-webkit-search-cancel-button]:appearance-none", className)}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented && !props.readOnly && !props.disabled && !event.nativeEvent.isComposing && event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
        }}
      />
      {value ? (
        <button type="button" disabled={props.disabled || props.readOnly} aria-label="清除搜索" onClick={clear} className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
