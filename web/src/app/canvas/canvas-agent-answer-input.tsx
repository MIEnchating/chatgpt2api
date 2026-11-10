import { useId, type ReactNode } from "react";
import { Questionnaire, QuestionnaireItem, QuestionnaireChoices, QuestionnaireChoice, QuestionnaireChoiceDescription } from "@/components/ui/questionnaire";
import { PromptInput, PromptInputFooter } from "@/components/ai-elements/prompt-input";
import { InputGroupTextarea } from "@/components/ui/input-group";

export function CanvasAgentAnswerInput({ options, value, onChange, onSelect, onInteract, actions, disabled = false, label = "你的回答" }: {
  options: readonly { label: string; description?: string }[];
  value: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  onInteract?: () => void;
  actions?: ReactNode;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  function choose(answer: string) { if (!disabled && answer.trim()) { onInteract?.(); onSelect(answer.trim()); } }
  return <Questionnaire data-agent-answer-input shortcuts="numbers" items={[{ name: id, choices: options.map(option => ({ value: option.label, disabled })) }]} onSubmit={(event) => { event.preventDefault(); if (value.trim() && !disabled) choose(value.trim()); }}>
    {/* Disabled questionnaire items become inactive and hidden; disable their controls instead. */}
    <QuestionnaireItem name={id} aria-disabled={disabled}>
      {options.length ? <QuestionnaireChoices aria-label="回答选项">
        {options.map(option => <QuestionnaireChoice key={option.label} value={option.label} disabled={disabled} onClick={event => {
          // A label forwards a second click to its input; submit only that activation.
          if ((event.target as HTMLElement).tagName === "INPUT") choose(option.label);
        }} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.key !== "Enter") return;
          event.preventDefault();
          choose(option.label);
        }}>
          <span className="break-words">{option.label}</span>
          {option.description ? <QuestionnaireChoiceDescription className="break-words">{option.description}</QuestionnaireChoiceDescription> : null}
        </QuestionnaireChoice>)}
      </QuestionnaireChoices> : null}
      <PromptInput>
        <InputGroupTextarea rows={1} aria-label={label} placeholder={options.length ? "或自行撰写回复" : "输入你的回答…"} disabled={disabled} value={value} onCompositionStart={onInteract} onChange={(event) => { onInteract?.(); onChange(event.target.value); }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          choose(value);
        }} className="min-h-9 max-h-36 resize-none" />
        {actions ? <PromptInputFooter className="justify-end gap-2">{actions}</PromptInputFooter> : null}
      </PromptInput>
    </QuestionnaireItem>
  </Questionnaire>;
}
