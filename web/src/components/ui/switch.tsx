import * as React from "react";

import { cn } from "@/lib/utils";

type SwitchProps = Omit<React.ComponentProps<"button">, "onChange"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

function Switch({
  checked: checkedProp,
  defaultChecked = false,
  onCheckedChange,
  onClick,
  className,
  disabled,
  ...props
}: SwitchProps) {
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked);
  const checked = checkedProp ?? uncontrolledChecked;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || disabled) return;
    const next = !checked;
    if (checkedProp === undefined) setUncontrolledChecked(next);
    onCheckedChange?.(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-slot="switch"
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent bg-muted-foreground/25 shadow-inner outline-none transition-[background-color,box-shadow] enabled:hover:bg-muted-foreground/35 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20",
        checked && "bg-brand enabled:hover:bg-brand/90",
        className,
      )}
      data-state={checked ? "checked" : "unchecked"}
      onClick={handleClick}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none block size-4.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked && "translate-x-[22px] bg-brand-foreground",
        )}
      />
    </button>
  );
}

export { Switch };
