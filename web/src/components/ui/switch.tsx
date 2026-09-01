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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-muted-foreground/25 outline-none transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[#1456f0]",
        checked && "bg-[#1456f0]",
        className,
      )}
      data-state={checked ? "checked" : "unchecked"}
      onClick={handleClick}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-[18px]",
        )}
      />
    </button>
  );
}

export { Switch };
