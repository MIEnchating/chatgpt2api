import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentActions, AttachmentAction, AttachmentTrigger, AttachmentContent, AttachmentTitle } from "@/components/ui/attachment";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Badge } from "@/components/ui/badge";
import { type WorkflowTemplateReference } from "@/services/api/workflows";
import { cn } from "@/lib/utils";

export type WorkflowReference = WorkflowTemplateReference & {
  temporary?: boolean;
  role?: "template" | "product";
};

export function WorkflowReferenceGrid({ references, className, emptyMessage, disabled = false, openOriginal = false, onRemove, onMove }: { references: readonly WorkflowReference[]; className: string; emptyMessage?: string; disabled?: boolean; openOriginal?: boolean; onRemove?: (id: string) => void; onMove?: (id: string, direction: -1 | 1) => void }) {
  if (!references.length) {
    return emptyMessage ? <EmptyState compact title={emptyMessage} className="mt-3 min-h-0 py-5" /> : null;
  }
  return (
    <AttachmentGroup className={cn("mt-3 grid gap-2 overflow-x-visible", className)}>
      {references.map((reference, index) => (
        <Attachment key={reference.id} orientation="vertical" className="w-full min-w-0 has-data-[slot=attachment-content]:w-full">
          <AttachmentMedia variant="image">
            <AuthenticatedImage src={reference.url} alt={reference.name} className="size-full object-cover" placeholderClassName="min-h-0" />
          </AttachmentMedia>
          {openOriginal ? <>
            <AttachmentTrigger asChild><a href={reference.url} target="_blank" rel="noreferrer" aria-label={`打开参考图 ${reference.name}`} /></AttachmentTrigger>
            <AttachmentContent><AttachmentTitle>{reference.name}</AttachmentTitle></AttachmentContent>
          </> : null}
          {onMove ? <Badge variant="secondary" className="absolute top-1 left-1 size-5 p-0">{index + 1}</Badge> : null}
          {onRemove ? <AttachmentActions className="group-data-[orientation=vertical]/attachment:top-1 group-data-[orientation=vertical]/attachment:right-1">
            <AttachmentAction aria-label={`移除参考图 ${reference.name}`} disabled={disabled} onClick={() => onRemove(reference.id)}><X /></AttachmentAction>
          </AttachmentActions> : null}
          {onMove ? <AttachmentActions className="group-data-[orientation=vertical]/attachment:top-auto group-data-[orientation=vertical]/attachment:bottom-1 group-data-[orientation=vertical]/attachment:left-1 group-data-[orientation=vertical]/attachment:right-auto">
            <AttachmentAction title="前移" aria-label={`前移 ${reference.name}`} disabled={disabled || index === 0} onClick={() => onMove(reference.id, -1)}><ArrowUp className="rotate-[-90deg]" /></AttachmentAction>
            <AttachmentAction title="后移" aria-label={`后移 ${reference.name}`} disabled={disabled || index === references.length - 1} onClick={() => onMove(reference.id, 1)}><ArrowDown className="rotate-[-90deg]" /></AttachmentAction>
          </AttachmentActions> : null}
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}
