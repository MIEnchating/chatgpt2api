import { useRef, type ComponentProps } from "react";
import { Search, X } from "lucide-react";

import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
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
    <InputGroup className={cn("min-w-0", containerClassName)} data-search-input>
      <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
      <InputGroupInput
        {...props}
        ref={inputRef}
        type="search"
        value={value}
        aria-label={props["aria-label"] || props.placeholder || "搜索"}
        className={cn("[&::-webkit-search-cancel-button]:appearance-none", className)}
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
        <InputGroupAddon align="inline-end"><InputGroupButton size="icon-sm" type="button" disabled={props.disabled || props.readOnly} aria-label="清除搜索" onClick={clear}>
          <X  aria-hidden="true" />
        </InputGroupButton></InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
