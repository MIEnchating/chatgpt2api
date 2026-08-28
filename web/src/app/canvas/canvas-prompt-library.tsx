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
        size="sm"
        className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        aria-label="打开提示词"
        title="提示词"
      >
        <BookOpenText className="size-3.5" />
        提示词
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
