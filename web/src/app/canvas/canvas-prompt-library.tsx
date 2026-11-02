"use client";

import { useState } from "react";
import { BookOpenText } from "lucide-react";

import { ImagePromptMarket } from "@/app/image/components/image-prompt-market";
import { Button } from "@/components/ui/button";

export function CanvasPromptLibrary({ onSelect }: { onSelect: (prompt: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        aria-label="打开提示词"
        title="提示词"
      >
        <BookOpenText className="size-3.5" />
      </Button>
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
