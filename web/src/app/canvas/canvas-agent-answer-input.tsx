import { useId } from "react";
import { ArrowUpRight, Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  return <div className="space-y-3" data-agent-answer-input>
    {options.length ? <div role="group" aria-label="回答选项" className="grid gap-2">
      {options.map((option, index) => <Button key={option.label} type="button" disabled={disabled}
        variant={value === option.label ? "secondary" : "outline"} aria-pressed={value === option.label}
        aria-label={option.label} aria-describedby={index === 0 ? `${id}-recommended` : undefined}
        className={cn("group/choice h-auto min-h-11 justify-start gap-3 whitespace-normal rounded-xl border-border/60 bg-background/60 px-3 py-2.5 text-left text-xs shadow-none transition-colors hover:border-brand/40 hover:bg-brand-soft/40", value === option.label && "border-brand/50 bg-brand-soft/50 ring-1 ring-brand/15")}
        onClick={() => choose(option.label)}>
        <span aria-hidden="true" className={cn("grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-medium", value === option.label ? "border-brand bg-brand text-white" : "border-border text-muted-foreground")}>{value === option.label ? <Check className="size-3" /> : index + 1}</span>
        <span className="min-w-0 flex-1 break-words">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span>{option.label}</span>
            {index === 0 ? <span id={`${id}-recommended`} className="inline-flex items-center gap-1 text-[10px] font-medium text-brand"><Sparkles className="size-3" />Agent 推荐</span> : null}
          </span>
          {option.description ? <span className="mt-1 block font-normal leading-5 text-muted-foreground">{option.description}</span> : null}
        </span>
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover/choice:text-brand" aria-hidden="true" />
      </Button>)}
    </div> : null}
    <div className="rounded-xl border border-border/60 bg-background/70">
      <label htmlFor={`${id}-answer`} className="block px-3 pt-2.5 text-[11px] font-medium text-muted-foreground">{options.length ? "也可以直接输入自己的答案" : "告诉我你的想法"}</label>
      <textarea id={`${id}-answer`} aria-label={label} placeholder={options.length ? "有其他想法？在这里输入…" : "输入你的回答…"}
        disabled={disabled} value={value} onCompositionStart={onInteract}
        onChange={(event) => { onInteract?.(); onChange(event.target.value); }}
        className="block min-h-16 max-h-36 w-full resize-y border-0 bg-transparent px-3 pb-3 pt-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/45 disabled:opacity-50" />
    </div>
  </div>;
}
