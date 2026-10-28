import { useId } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CanvasAgentAnswerInput({ options, value, onChange, onSelect, onInteract, disabled = false, label = "你的回答" }: {
  options: readonly { label: string; description?: string }[];
  value: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  onInteract?: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  function choose(answer: string) {
    onInteract?.();
    onSelect(answer);
  }
  return <div className="space-y-3">
    {options.length ? <div role="group" aria-label="回答选项" className="flex flex-col gap-1.5">
      {options.map((option, index) => <Button key={option.label} type="button" disabled={disabled}
        variant={value === option.label ? "secondary" : "outline"} aria-pressed={value === option.label}
        aria-label={option.label} aria-describedby={index === 0 ? `${id}-recommended` : undefined}
        className="h-auto min-h-9 justify-start gap-2 whitespace-normal px-2.5 py-2 text-left text-xs"
        onClick={() => choose(option.label)}>
        <span className="min-w-0 flex-1 break-words">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span>{option.label}</span>
            {index === 0 ? <span id={`${id}-recommended`} className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">推荐</span> : null}
          </span>
          {option.description ? <span className="mt-1 block font-normal leading-5 text-muted-foreground">{option.description}</span> : null}
        </span>
        {value === option.label ? <Check className="size-3.5 shrink-0 text-brand" aria-hidden="true" /> : null}
      </Button>)}
    </div> : null}
    <Input id={`${id}-answer`} aria-label={label} placeholder="或输入其他回答"
      disabled={disabled} value={value} onCompositionStart={onInteract}
      onChange={(event) => { onInteract?.(); onChange(event.target.value); }} className="h-9 text-sm" />
  </div>;
}
