import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export function PasswordInput({ type: _type, className, inputClassName, ...props }: ComponentProps<"input"> & { inputClassName?: string }) {
  const [visible, setVisible] = useState(false);
  return <InputGroup className={className}>
    <InputGroupInput {...props} className={cn("h-full", inputClassName)} type={visible ? "text" : "password"} />
    <InputGroupAddon align="inline-end">
      <InputGroupButton size="icon-sm" disabled={props.disabled} aria-label={visible ? "隐藏密码" : "显示密码"} onMouseDown={(event) => event.preventDefault()} onClick={() => setVisible((value) => !value)}>
        {visible ? <EyeOff /> : <Eye />}
      </InputGroupButton>
    </InputGroupAddon>
  </InputGroup>;
}
