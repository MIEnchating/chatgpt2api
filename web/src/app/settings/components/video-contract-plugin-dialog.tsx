import { Spinner } from "@/components/ui/spinner";
import { TestResults } from "@/components/ai-elements/test-results";
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { useEffect, useRef, useState } from "react";
import { Code2, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { generateNewAPIVideoPlugin, type NewAPIVideoPluginOptions, type NewAPIVideoPluginResult } from "@/lib/api";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { dryRunNewAPIVideoPlugin, type NewAPIVideoPluginDryRunResult } from "@/lib/newapi-video-plugin-dry-run";
import { getCachedAuthSession } from "@/lib/session";
import type { VideoModelContract } from "@/lib/video-model-contracts";
import { videoPluginDefaults } from "@/lib/video-plugin-defaults";

export type VideoContractPluginTarget = { id: string; contract: VideoModelContract; label: string; warnings?: string[]; reviewPending?: boolean };

type PluginDraft = {
  key: string;
  version: string;
  baseURL: string;
  models: string;
  authMode: NewAPIVideoPluginOptions["auth_mode"] | "";
  authHeader: string;
  downloadMode: NewAPIVideoPluginOptions["download_mode"] | "";
  resultFields: string;
  result: NewAPIVideoPluginResult | null;
  dryRun: NewAPIVideoPluginDryRunResult | null;
  error: string;
};

function pluginDraft(target: VideoContractPluginTarget): PluginDraft {
  const { contract } = target;
  return {
    ...videoPluginDefaults(contract), result: null, dryRun: null, error: "",
  };
}

export function VideoContractPluginDialog({ targets, sessionKey, onClose }: {
  targets: VideoContractPluginTarget[];
  sessionKey: string;
  onClose: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [drafts, setDrafts] = useState(() => targets.map(pluginDraft));
  return <VideoContractPluginView key={`${sessionKey}:${selectedIndex}`} targets={targets} selectedIndex={selectedIndex}
    draft={drafts[selectedIndex]} onChange={patch => setDrafts(current => current.map((draft, index) => index === selectedIndex ? { ...draft, ...patch } : draft))}
    onSelect={setSelectedIndex} completedCount={drafts.filter(draft => draft.result).length} sessionKey={sessionKey} onClose={onClose} />;
}

function VideoContractPluginView({ targets, selectedIndex, draft, onChange, onSelect, completedCount, sessionKey, onClose }: {
  targets: VideoContractPluginTarget[];
  selectedIndex: number;
  draft: PluginDraft;
  onChange: (patch: Partial<PluginDraft>) => void;
  onSelect: (index: number) => void;
  completedCount: number;
  sessionKey: string;
  onClose: () => void;
}) {
  const target = targets[selectedIndex];
  const { contract } = target;
  const { key, version, baseURL, models, authMode, authHeader, downloadMode, resultFields, result, dryRun, error } = draft;
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const handleSession = () => {
      if (getCachedAuthSession()?.key !== sessionKey) {
        requestRef.current?.abort();
        closeRef.current();
      }
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSession);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSession);
    };
  }, [sessionKey]);

  function change(patch: Partial<PluginDraft>) {
    onChange({ ...patch, result: null, dryRun: null, error: "" });
  }

  async function generate() {
    if (!authMode) { onChange({ error: "文档未声明上游鉴权方式，请选择后生成" }); return; }
    if (!downloadMode) { onChange({ error: "请选择供应商实际使用的视频下载方式" }); return; }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    onChange({ error: "", result: null, dryRun: null });
    try {
      const pluginOptions: NewAPIVideoPluginOptions = {
        key, version, base_url: baseURL,
        models: models.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean),
        auth_mode: authMode, auth_header: authHeader, download_mode: downloadMode,
        result_fields: resultFields.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean),
      };
      const generated = await generateNewAPIVideoPlugin({ contract, options: pluginOptions }, { signal: controller.signal });
      const dryRun = await dryRunNewAPIVideoPlugin(generated, controller.signal);
      if (!controller.signal.aborted && requestRef.current === controller && getCachedAuthSession()?.key === sessionKey) onChange({ result: generated, dryRun });
    } catch (cause) {
      if (!controller.signal.aborted && requestRef.current === controller) onChange({ error: cause instanceof Error ? cause.message : "生成插件失败" });
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) setBusy(false);
    }
  }

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.source], { type: "text/javascript;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) { requestRef.current?.abort(); onClose(); } }}>
      <DialogContent className="w-[min(calc(100%-2rem),52rem)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center"><Code2 className="size-5" />生成 New API 视频插件</DialogTitle>
          <DialogDescription>{contract.name} · {target.label}。根据契约生成带中文注释的单文件插件，预览后下载并上传到 New API。</DialogDescription>
        </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
        <div className="space-y-5">
          {targets.length > 1 ? <Field>
            <FieldLabel htmlFor="video-plugin-contract">选择契约（已生成 {completedCount}/{targets.length}）</FieldLabel>
            <Select value={String(selectedIndex)} onValueChange={value => onSelect(Number(value))} disabled={busy}>
              <SelectTrigger id="video-plugin-contract"><SelectValue /></SelectTrigger>
              <SelectContent>{targets.map((item, index) => <SelectItem key={item.id} value={String(index)}>{index + 1}. {item.contract.name}</SelectItem>)}</SelectContent>
            </Select>
            <FieldDescription>每份契约单独配置、生成和下载；切换契约会保留本次填写的配置和生成结果。</FieldDescription>
          </Field> : null}
          {target.warnings?.length ? <ul className="list-disc space-y-1 py-3 pl-8 pr-3">{target.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : null}
          <Card className="p-3 gap-0">
            一个插件保留所有选定模型的独立能力。对外使用 <code>/v1/videos</code> 创建、查询和下载视频。
            已按文档与契约自动填写可确定的配置，你可以直接调整。文档未明确的地址和鉴权留空；密钥只在 New API 渠道填写。
          </Card>
          <FieldSet disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="video-plugin-key">插件标识</FieldLabel>
              <Input id="video-plugin-key" value={key} maxLength={30} onChange={event => change({ key: event.target.value })} spellCheck={false} />
              <FieldDescription>最多 30 位小写字母、数字、下划线或连字符。升级同一插件时保持标识不变。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="video-plugin-version">插件版本</FieldLabel>
              <Input id="video-plugin-version" value={version} onChange={event => change({ version: event.target.value })} placeholder="1.0.0" />
              <FieldDescription>源码有变更时使用新版本号；相同版本不能覆盖不同源码。</FieldDescription>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="video-plugin-base-url">供应商 Base URL（选填）</FieldLabel>
              <Input id="video-plugin-base-url" value={baseURL} onChange={event => change({ baseURL: event.target.value })} placeholder="留空后在 New API 渠道配置" autoComplete="off" spellCheck={false} />
              <FieldDescription>仅作为插件的渠道默认地址，留空不影响生成；实际请求使用 New API 渠道配置。不是契约必填项，不要填写 API Key。创建路径：{contract.transport.create_path || "驱动默认路径"}；查询路径：{contract.transport.query_path || "驱动默认路径"}。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="video-plugin-auth">上游鉴权方式</FieldLabel>
              <Select value={authMode} onValueChange={value => change({ authMode: value as NewAPIVideoPluginOptions["auth_mode"] })} disabled={busy}>
                <SelectTrigger id="video-plugin-auth"><SelectValue placeholder="文档未声明，请选择" /></SelectTrigger>
                <SelectContent><SelectItem value="bearer">Authorization: Bearer Key</SelectItem><SelectItem value="header">自定义 API Key 请求头</SelectItem><SelectItem value="none">无需鉴权</SelectItem></SelectContent>
              </Select>
              {authMode === "header" ? <Input aria-label="API Key 请求头名称" value={authHeader} onChange={event => change({ authHeader: event.target.value })} placeholder="X-API-Key" /> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="video-plugin-download">视频下载方式</FieldLabel>
              <Select value={downloadMode} onValueChange={value => change({ downloadMode: value as NewAPIVideoPluginOptions["download_mode"] })} disabled={busy}>
                <SelectTrigger id="video-plugin-download"><SelectValue placeholder="请选择供应商实际下载方式" /></SelectTrigger>
                <SelectContent><SelectItem value="signed_url">查询签名地址后下载（不带 Key）</SelectItem><SelectItem value="task_content">请求上游 content 接口</SelectItem><SelectItem value="authenticated_url">查询结果地址并携带 Key 下载</SelectItem></SelectContent>
              </Select>
              <FieldDescription>{downloadMode === "signed_url" ? "每次刷新签名地址，再以 credentialless 下载，适用于 CDN 文件。" : "带 Key 的下载不能跨域跳转；上游若跳转到 CDN，请改用签名地址。"}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="video-plugin-models">完整模型 ID</FieldLabel>
              <Textarea id="video-plugin-models" value={models} onChange={event => change({ models: event.target.value })} className="min-h-24 font-mono" spellCheck={false} />
              <FieldDescription>每行一个，必须匹配当前契约；通配符需替换成具体模型 ID。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="video-plugin-result-fields">上游视频地址字段</FieldLabel>
              <Textarea id="video-plugin-result-fields" value={resultFields} disabled={downloadMode === "task_content"} onChange={event => change({ resultFields: event.target.value })} placeholder={"video_url\ndata[0].url"} className="min-h-24 font-mono" spellCheck={false} />
              <FieldDescription>{downloadMode === "task_content" ? `使用契约产物路径：${contract.artifact.content_path || "尚未配置，请先编辑契约"}` : "填写供应商查询响应中的真实 JSON 路径，每行一个；占位示例不会自动加入。"}</FieldDescription>
            </Field>
          </FieldSet>
          {error ? <Alert variant="destructive" role="alert">{error}</Alert> : null}
          {result ? <section aria-label="生成的插件" className="space-y-3">
            <Alert role="status">
              <p className="font-medium">{target.reviewPending ? "本地干跑通过 · 编辑草稿需重新审核" : "插件初审通过 · 本地干跑通过"}</p>
              <p className="mt-1 text-xs leading-relaxed">已在浏览器 Worker 中运行 {dryRun?.checks.length || 0} 项检查，使用模拟数据；尚未实测上游，也不等同于 New API 宿主沙盒验证。</p>
            </Alert>
            <p className="text-sm font-medium">已生成 {result.filename}</p>
            {dryRun ? <TestResults label="插件干跑检查结果" checks={dryRun.checks} /> : null}
            <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
            <Collapsible >
              <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal cursor-pointer h-auto min-h-8">查看中文注释源码</Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden">
              <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-72 font-mono" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><CodeBlock><CodeBlockContent wrap>{result.source}</CodeBlockContent></CodeBlock></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
            </CollapsibleContent></Collapsible>
          </section> : null}
        </div>
        </ScrollArea><DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={() => { requestRef.current?.abort(); onClose(); }}>关闭</Button>
          {result ? <><CodeBlockCopyButton variant="outline" size="default" value={result.source} aria-label="复制插件源码">复制源码</CodeBlockCopyButton><Button onClick={download}><Download  />下载插件 .js</Button></>
            : <Button disabled={busy || !key.trim() || !authMode || !downloadMode} onClick={() => void generate()}>{busy ? <Spinner /> : <Code2  />}{busy ? "生成并干跑" : "生成并预览"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
