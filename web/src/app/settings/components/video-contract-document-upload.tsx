import { useRef } from "react";
import { FileText, Upload, X } from "lucide-react";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";

export function VideoContractDocumentUpload({ file, disabled, onChange }: { file: File | null; disabled: boolean; onChange: (file: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <Attachment state={file ? "done" : "idle"} className="min-h-52 w-full flex-col items-center justify-center gap-3">
    <input ref={inputRef} type="file" className="hidden"
      accept=".txt,.md,.markdown,.json,.yaml,.yml,.html,.htm,.docx,text/plain,text/markdown,text/html,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      disabled={disabled} onChange={event => {
        const selected = event.target.files?.[0];
        event.target.value = "";
        if (selected) onChange(selected);
      }} />
    <AttachmentMedia>{file ? <FileText /> : <Upload />}</AttachmentMedia>
    <AttachmentContent className="w-full flex-none text-center">
      <AttachmentTitle className="whitespace-normal break-all">{file ? file.name : "选择 API 文档"}</AttachmentTitle>
      <AttachmentDescription className="whitespace-normal leading-5">{file ? `${Math.max(1, Math.ceil(file.size / 1024))} KB · 已选择` : <><span className="block">DOCX、TXT、Markdown、JSON、YAML、HTML</span><span className="block">最大 8 MB</span></>}</AttachmentDescription>
    </AttachmentContent>
    {file ? <AttachmentActions>
      <AttachmentAction size="sm" aria-label="更换文档" disabled={disabled} onClick={() => inputRef.current?.click()}>更换文档</AttachmentAction>
      <AttachmentAction aria-label="移除文档" disabled={disabled} onClick={() => onChange(null)}><X /></AttachmentAction>
    </AttachmentActions> : <AttachmentTrigger aria-label="选择 API 文档" disabled={disabled} onClick={() => inputRef.current?.click()} />}
  </Attachment>;
}
