"use client";

import { TooltipHint } from "@/components/ui/tooltip";

import { useState } from "react";
import { BookOpenText } from "lucide-react";

import { ImagePromptMarket } from "@/app/image/components/image-prompt-market";
import { Button } from "@/components/ui/button";

export function CanvasPromptLibrary({ onSelect }: { onSelect: (prompt: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TooltipHint content={"提示词"}><Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={() => setOpen(true)}
        aria-label="打开提示词"
      >
        <BookOpenText  />
      </Button></TooltipHint>
      <ImagePromptMarket
        open={open}
        onOpenChange={setOpen}
        onApplyPrompt={(prompt) => {
          onSelect(prompt.prompt);
          setOpen(false);
        }}
      />
    </>
  );
}
