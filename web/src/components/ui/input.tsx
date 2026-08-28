"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { TooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const [passwordVisible, setPasswordVisible] = React.useState(false);
  const isPassword = type === "password";
  const input = (
    <input
      type={isPassword && passwordVisible ? "text" : type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-[0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-[border-color,box-shadow,background-color] selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
        type === "number" &&
          "appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        isPassword && "pr-10",
        className,
      )}
      {...props}
    />
  );

  if (!isPassword) {
    return input;
  }

  return (
    <div data-slot="password-input" className="relative w-full min-w-0">
      {input}
      <TooltipButton
        type="button"
        className="absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.disabled}
        aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
        aria-pressed={passwordVisible}
        tooltip={passwordVisible ? "隐藏密码" : "显示密码"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setPasswordVisible((visible) => !visible)}
      >
        {passwordVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </TooltipButton>
    </div>
  );
}

export { Input };
