// AI Elements pattern: https://ui.shadcn.com/docs/ai-elements/radix/terminal
import { Terminal as TerminalIcon } from "lucide-react";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
} from "@/components/ui/code-block";
export type TerminalData = {
  command: string;
  output: string;
  cwd?: string;
  exitCode?: number;
};
export function Terminal({ command, output, cwd, exitCode }: TerminalData) {
  return (
    <CodeBlock
      data-ai-element="terminal"
      size="sm"
      variant={
        exitCode !== undefined && exitCode !== 0 ? "destructive" : "default"
      }
    >
      <CodeBlockHeader>
        <CodeBlockTitle>
          <TerminalIcon />
          终端{exitCode !== undefined ? ` · 退出码 ${exitCode}` : ""}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            value={[command, output].filter(Boolean).join("\n")}
            aria-label="复制命令输出"
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-56">
        {[cwd ? `工作目录：${cwd}` : "", `$ ${command}`, output]
          .filter(Boolean)
          .join("\n")}
      </CodeBlockContent>
    </CodeBlock>
  );
}
