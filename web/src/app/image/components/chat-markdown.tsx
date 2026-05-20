"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type ChatMarkdownProps = {
  children: string;
  className?: string;
};

type MarkdownBlock =
  | {
      type: "heading";
      level: number;
      text: string;
    }
  | {
      type: "paragraph";
      lines: string[];
    }
  | {
      type: "list";
      ordered: boolean;
      items: string[][];
    }
  | {
      type: "blockquote";
      lines: string[];
    }
  | {
      type: "code";
      language: string;
      code: string;
    }
  | {
      type: "table";
      headers: string[];
      rows: string[][];
    }
  | {
      type: "divider";
    };

const BARE_LINK_PATTERN = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|tel:[^\s<>"']+)/i;
const TRAILING_URL_PUNCTUATION_PATTERN = /[),.;:!?，。！？；：、]+$/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

export function ChatMarkdown({ children, className }: ChatMarkdownProps) {
  const content = children.trim();

  if (!content) {
    return null;
  }

  return (
    <div className={cn("space-y-3 break-words text-sm leading-6 text-[#45515e] dark:text-muted-foreground", className)}>
      {parseBlocks(content).map((block, index) => renderBlock(block, `chat-md-${index}`))}
    </div>
  );
}

function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = parseFenceStart(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !isFenceEnd(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language: fence.language, code: codeLines.join("\n") });
      continue;
    }

    if (isDivider(line)) {
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      blocks.push(heading);
      index += 1;
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const listItem = parseListItem(line);
    if (listItem) {
      const items: string[][] = [];
      const ordered = listItem.ordered;

      while (index < lines.length) {
        const item = parseListItem(lines[index]);
        if (!item || item.ordered !== ordered) {
          break;
        }
        const itemLines = [item.text];
        index += 1;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !parseListItem(lines[index])) {
          itemLines.push(lines[index].trim());
          index += 1;
        }
        items.push(itemLines);
      }

      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      if (
        paragraphLines.length > 0 &&
        (parseHeading(lines[index]) ||
          parseFenceStart(lines[index]) ||
          parseListItem(lines[index]) ||
          isDivider(lines[index]) ||
          /^\s{0,3}>\s?/.test(lines[index]) ||
          parseTable(lines, index))
      ) {
        break;
      }
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function parseFenceStart(line: string) {
  const match = /^\s{0,3}```\s*([A-Za-z0-9_+.-]*)\s*$/.exec(line);
  if (!match) {
    return null;
  }
  return { language: match[1] || "" };
}

function isFenceEnd(line: string) {
  return /^\s{0,3}```\s*$/.test(line);
}

function isDivider(line: string) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function parseHeading(line: string): MarkdownBlock | null {
  const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!match) {
    return null;
  }
  return {
    type: "heading",
    level: match[1].length,
    text: match[2],
  };
}

function parseListItem(line: string): { ordered: boolean; text: string } | null {
  const unordered = /^\s{0,3}[-*+]\s+(.+)$/.exec(line);
  if (unordered) {
    return { ordered: false, text: unordered[1] };
  }

  const ordered = /^\s{0,3}\d+[.)]\s+(.+)$/.exec(line);
  if (ordered) {
    return { ordered: true, text: ordered[1] };
  }

  return null;
}

function parseTable(lines: string[], start: number) {
  if (start + 1 >= lines.length || !lines[start].includes("|") || !lines[start + 1].includes("|")) {
    return null;
  }

  const headers = splitTableRow(lines[start]);
  const separator = splitTableRow(lines[start + 1]);
  if (headers.length === 0 || separator.length < headers.length || !separator.every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell))) {
    return null;
  }

  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
    rows.push(normalizeTableRow(splitTableRow(lines[index]), headers.length));
    index += 1;
  }

  return {
    block: { type: "table" as const, headers, rows },
    nextIndex: index,
  };
}

function splitTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!trimmed) {
    return [];
  }
  return trimmed.split("|").map((cell) => cell.trim());
}

function normalizeTableRow(cells: string[], count: number) {
  return Array.from({ length: count }, (_, index) => cells[index] || "");
}

function renderBlock(block: MarkdownBlock, key: string) {
  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(block.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
    return (
      <HeadingTag
        key={key}
        className={cn(
          "font-semibold tracking-normal text-[#222222] dark:text-foreground",
          block.level <= 2 ? "text-base leading-7" : "text-sm leading-6",
        )}
      >
        {renderInline(block.text, key)}
      </HeadingTag>
    );
  }

  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag
        key={key}
        className={cn("space-y-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}
      >
        {block.items.map((item, index) => (
          <li key={`${key}-item-${index}`} className="pl-1">
            {renderInlineLines(item, `${key}-item-${index}`)}
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "blockquote") {
    return (
      <blockquote key={key} className="border-l-2 border-[#dbe7ff] pl-3 text-[#5f6c7a] dark:border-sky-900 dark:text-muted-foreground">
        {renderInlineLines(block.lines, key)}
      </blockquote>
    );
  }

  if (block.type === "code") {
    return (
      <div key={key} className="overflow-hidden rounded-xl border border-[#e5e7eb] bg-[#f8fafc] dark:border-border dark:bg-background">
        {block.language ? (
          <div className="border-b border-[#e5e7eb] px-3 py-1.5 font-mono text-[11px] text-[#8e8e93] dark:border-border">
            {block.language}
          </div>
        ) : null}
        <pre className="overflow-x-auto p-3 text-[13px] leading-6">
          <code className="font-mono text-[#222222] dark:text-foreground">{block.code}</code>
        </pre>
      </div>
    );
  }

  if (block.type === "table") {
    return (
      <div key={key} className="overflow-x-auto rounded-xl border border-[#e5e7eb] dark:border-border">
        <table className="w-full min-w-[28rem] border-collapse text-left text-sm">
          <thead className="bg-[#f8fafc] text-[#222222] dark:bg-background dark:text-foreground">
            <tr>
              {block.headers.map((header, index) => (
                <th key={`${key}-head-${index}`} className="border-b border-[#e5e7eb] px-3 py-2 font-semibold dark:border-border">
                  {renderInline(header, `${key}-head-${index}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`} className="border-b border-[#f2f3f5] last:border-0 dark:border-border">
                {row.map((cell, cellIndex) => (
                  <td key={`${key}-cell-${rowIndex}-${cellIndex}`} className="px-3 py-2 align-top">
                    {renderInline(cell, `${key}-cell-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.type === "divider") {
    return <hr key={key} className="border-[#e5e7eb] dark:border-border" />;
  }

  return (
    <p key={key} className="whitespace-pre-wrap">
      {renderInlineLines(block.lines, key)}
    </p>
  );
}

function renderInlineLines(lines: string[], keyPrefix: string) {
  return lines.flatMap((line, index) => {
    const nodes = renderInline(line, `${keyPrefix}-line-${index}`);
    if (index === lines.length - 1) {
      return nodes;
    }
    return [...nodes, <br key={`${keyPrefix}-line-${index}-break`} />];
  });
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let textBuffer = "";

  const flushText = () => {
    if (!textBuffer) {
      return;
    }
    nodes.push(textBuffer);
    textBuffer = "";
  };

  const pushNode = (node: ReactNode) => {
    flushText();
    nodes.push(node);
  };

  while (cursor < text.length) {
    const char = text[cursor];

    if (char === "`") {
      const end = text.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        pushNode(
          <code
            key={`${keyPrefix}-code-${cursor}`}
            className="rounded-md bg-[#edf2f7] px-1.5 py-0.5 font-mono text-[0.9em] text-[#222222] dark:bg-muted dark:text-foreground"
          >
            {text.slice(cursor + 1, end)}
          </code>,
        );
        cursor = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", cursor)) {
      const end = text.indexOf("**", cursor + 2);
      if (end > cursor + 2) {
        pushNode(
          <strong key={`${keyPrefix}-strong-${cursor}`} className="font-semibold text-[#222222] dark:text-foreground">
            {renderInline(text.slice(cursor + 2, end), `${keyPrefix}-strong-${cursor}`)}
          </strong>,
        );
        cursor = end + 2;
        continue;
      }
    }

    if (char === "*") {
      const end = text.indexOf("*", cursor + 1);
      if (end > cursor + 1 && text[cursor + 1] !== " ") {
        pushNode(
          <em key={`${keyPrefix}-em-${cursor}`} className="italic">
            {renderInline(text.slice(cursor + 1, end), `${keyPrefix}-em-${cursor}`)}
          </em>,
        );
        cursor = end + 1;
        continue;
      }
    }

    const markdownLink = parseMarkdownLink(text, cursor);
    if (markdownLink) {
      pushNode(
        <MarkdownLink key={`${keyPrefix}-link-${cursor}`} href={markdownLink.href}>
          {renderInline(markdownLink.label, `${keyPrefix}-link-${cursor}-label`)}
        </MarkdownLink>,
      );
      cursor = markdownLink.end;
      continue;
    }

    const autoLink = parseAutoLink(text, cursor);
    if (autoLink) {
      pushNode(
        <MarkdownLink key={`${keyPrefix}-autolink-${cursor}`} href={autoLink.href}>
          {autoLink.href}
        </MarkdownLink>,
      );
      cursor = autoLink.end;
      continue;
    }

    const bareLink = parseBareLink(text, cursor);
    if (bareLink) {
      pushNode(
        <MarkdownLink key={`${keyPrefix}-barelink-${cursor}`} href={bareLink.href}>
          {bareLink.href}
        </MarkdownLink>,
      );
      if (bareLink.trailing) {
        textBuffer += bareLink.trailing;
      }
      cursor = bareLink.end;
      continue;
    }

    textBuffer += char;
    cursor += 1;
  }

  flushText();
  return nodes;
}

function parseMarkdownLink(text: string, start: number) {
  if (text[start] !== "[" || text[start - 1] === "!") {
    return null;
  }

  const labelEnd = text.indexOf("]", start + 1);
  if (labelEnd <= start + 1 || text[labelEnd + 1] !== "(") {
    return null;
  }

  const hrefStart = labelEnd + 2;
  const hrefEnd = findClosingParen(text, hrefStart);
  if (hrefEnd <= hrefStart) {
    return null;
  }

  const href = sanitizeHref(text.slice(hrefStart, hrefEnd));
  if (!href) {
    return null;
  }

  return {
    label: text.slice(start + 1, labelEnd),
    href,
    end: hrefEnd + 1,
  };
}

function findClosingParen(text: string, start: number) {
  let depth = 0;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }

  return -1;
}

function parseAutoLink(text: string, start: number) {
  if (text[start] !== "<") {
    return null;
  }

  const end = text.indexOf(">", start + 1);
  if (end <= start + 1) {
    return null;
  }

  const href = sanitizeHref(text.slice(start + 1, end));
  if (!href) {
    return null;
  }

  return { href, end: end + 1 };
}

function parseBareLink(text: string, start: number) {
  const match = BARE_LINK_PATTERN.exec(text.slice(start));
  if (!match) {
    return null;
  }

  const rawHref = match[0];
  const href = sanitizeHref(rawHref.replace(TRAILING_URL_PUNCTUATION_PATTERN, ""));
  if (!href) {
    return null;
  }

  return {
    href,
    trailing: rawHref.slice(href.length),
    end: start + rawHref.length,
  };
}

function sanitizeHref(rawHref: string) {
  const href = rawHref.trim().replace(/^<|>$/g, "");
  if (!href || hasControlCharacter(href)) {
    return "";
  }

  if (href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//"))) {
    return href;
  }

  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:") {
      return href;
    }
  } catch {
    return "";
  }

  return "";
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function MarkdownLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const external = /^https?:\/\//i.test(href);

  return (
    <a
      className="font-medium text-[#1456f0] underline underline-offset-2 transition hover:text-[#17437d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/25 dark:text-sky-300 dark:hover:text-sky-200"
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      {children}
    </a>
  );
}
