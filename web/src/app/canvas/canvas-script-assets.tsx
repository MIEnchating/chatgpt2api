import { useRef, useState } from "react";
import { MoreHorizontal, Sparkles, Upload } from "lucide-react";
import { PromptInput } from "@/components/ai-elements/prompt-input";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FileUploadButton } from "@/components/ui/file-upload-button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ImagePreview } from "@/components/image-preview";
import { LabeledField } from "@/components/labeled-field";
import { useMyAssets } from "@/lib/use-my-assets";
import type { CanvasNode, CanvasScriptAsset, CanvasScriptProject } from "@/services/api/canvas";
import type { CanvasInsertAssetPayload } from "./agent/canvas-agent-types";
import { canvasInsertPayloadFromMyAsset } from "./agent/canvas-agent-starter";
import { CanvasImageParameterPopover } from "./canvas-image-parameters";
import { CanvasInlineModelSelect } from "./canvas-inline-model-select";
import { scriptAssetImage, scriptAssetsToGenerate, type ScriptAssetGeneration } from "./canvas-script";

type ImageSettingsProps = {
  imageDefaults: CanvasNode;
  imageModels: string[];
  imageModel: string;
};

function ScriptImageSettings({ parameters, onChange, imageModel, imageModels }: Omit<ImageSettingsProps, "imageDefaults"> & {
  parameters: CanvasNode;
  onChange: (parameters: CanvasNode) => void;
}) {
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    <CanvasInlineModelSelect label="资产生成模型" models={imageModels} value={parameters.generation_model || imageModel} onChange={(generation_model) => onChange({ ...parameters, generation_model })} className="max-w-64" />
    <CanvasImageParameterPopover node={parameters} imageModel={imageModel} imageModels={imageModels} showModel={false} showCount={false} onChange={(patch) => onChange({ ...parameters, ...patch })} />
  </div>;
}

export function ScriptAssetCard({ asset, nodes, disabled, onChoose, onGenerate, onEdit, onClear, onRemove, onNavigate, onSave }: {
  asset: CanvasScriptAsset;
  nodes: readonly CanvasNode[];
  disabled: boolean;
  onChoose: () => void;
  onGenerate: () => void;
  onEdit: () => void;
  onClear: () => void;
  onRemove: () => void;
  onNavigate: () => void;
  onSave: () => void;
}) {
  const image = scriptAssetImage(asset, nodes);
  const busy = disabled || image?.generation_status === "loading";
  return <div className="min-w-0 space-y-2">
    <Card className="relative gap-0 overflow-hidden p-0">
      <Button variant="ghost" disabled={busy} aria-label={`选择${asset.name || "资产"}图片`} className="h-auto min-h-40 w-full whitespace-normal p-0 aspect-video" onClick={onChoose}>
        {image?.url ? <ImagePreview src={image.url} alt={asset.name || "资产设定图"} className="size-full object-contain" /> : image?.generation_status === "loading" ? <><Spinner />正在生成</> : "生成或上传设定图"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="secondary" size="icon" className="absolute top-2 right-2" aria-label={`${asset.name || "资产"}操作`} disabled={busy}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onChoose}>替换图片</DropdownMenuItem>
          <DropdownMenuItem onSelect={onGenerate}>AI 生成</DropdownMenuItem>
          <DropdownMenuItem onSelect={onEdit}>编辑资产设定</DropdownMenuItem>
          <DropdownMenuItem disabled={!image} onSelect={onNavigate}>跳转至节点</DropdownMenuItem>
          <DropdownMenuItem disabled={!asset.image_node_id} onSelect={onClear}>清除图片</DropdownMenuItem>
          <DropdownMenuItem disabled={!image?.url} onSelect={onSave}>保存到个人资产</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
    <p className="truncate text-sm font-medium">{asset.name || "未命名资产"}</p>
    {image?.generation_error ? <FieldError>{image.generation_error}</FieldError> : null}
  </div>;
}

export function ScriptAssetImageDialog({ asset, nodes, initialTab, scope, disabled, onClose, onChoose, onUpload, onInsert, onGenerate, ...settings }: ImageSettingsProps & {
  asset: CanvasScriptAsset;
  nodes: readonly CanvasNode[];
  initialTab: "ai" | "canvas";
  scope: string;
  disabled: boolean;
  onClose: () => void;
  onChoose: (nodeID: string) => void;
  onUpload: (file: File) => void;
  onInsert: (payload: CanvasInsertAssetPayload) => void;
  onGenerate: (request: ScriptAssetGeneration) => void;
}) {
  const [tab, setTab] = useState<string>(initialTab);
  const [prompt, setPrompt] = useState(asset.description);
  const [parameters, setParameters] = useState(settings.imageDefaults);
  const uploadRef = useRef<HTMLInputElement>(null);
  const { assets, loading } = useMyAssets(scope, tab === "library");
  const images = nodes.filter((node) => node.type === "image" && node.url && node.generation_status !== "loading");
  const libraryImages = assets.filter((item) => item.kind === "image" && item.url);
  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="flex h-[min(760px,90dvh)] w-[min(1068px,calc(100vw-2rem))] max-w-none flex-col sm:max-w-none">
      <DialogTitle className="pr-8">选择图片（{asset.name || "未命名资产"}）</DialogTitle>
      <DialogDescription className="sr-only">生成资产设定图，或选择画布、本地和个人资产中的图片。</DialogDescription>
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
        <TabsList variant="line" className="grid w-full shrink-0 grid-cols-2 justify-start group-data-horizontal/tabs:h-auto sm:flex sm:w-fit">
          <TabsTrigger value="ai" className="h-8 flex-none">AI 生成</TabsTrigger><TabsTrigger value="canvas" className="h-8 flex-none">从当前画布选择</TabsTrigger><TabsTrigger value="upload" className="h-8 flex-none">本地上传</TabsTrigger><TabsTrigger value="library" className="h-8 flex-none">个人资产库</TabsTrigger>
        </TabsList>
        <TabsContent value="ai" className="flex min-h-0 flex-col gap-4">
          <PromptInput className="min-h-0 flex-1"><InputGroupTextarea aria-label="资产图片生成提示词" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="开始你的设计，描述资产外观、材质和视觉风格" maxLength={20000} disabled={disabled} className="h-full min-h-40" /></PromptInput>
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <ScriptImageSettings {...settings} parameters={parameters} onChange={setParameters} />
            <Button disabled={disabled || !prompt.trim() || !settings.imageModels.includes(parameters.generation_model || settings.imageModel)} onClick={() => { onGenerate({ assetIDs: [asset.id], parameters, prompt }); onClose(); }}><Sparkles />确认生成</Button>
          </footer>
        </TabsContent>
        <TabsContent value="canvas" className="min-h-0">
          <ScrollArea className="h-full" contentClassName="grid grid-cols-2 gap-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((image) => <Button key={image.id} variant="outline" className="h-auto min-w-0 flex-col items-stretch p-2" disabled={disabled || image.id === asset.image_node_id} aria-label={`使用画布图片：${image.title || image.id}`} onClick={() => { onChoose(image.id); onClose(); }}>
              <ImagePreview src={image.url!} alt={image.title || "画布图片"} className="aspect-square w-full object-contain" />
              <span className="w-full truncate">{image.title || "未命名图片"}</span>
              {image.id === asset.image_node_id ? <span>当前</span> : null}
            </Button>)}
            {!images.length ? <EmptyState compact title="画布中还没有图片" description="可切换至 AI 生成或本地上传。" className="col-span-full" /> : null}
          </ScrollArea>
        </TabsContent>
        <TabsContent value="upload" className="flex min-h-0 items-center justify-center">
          <FileUploadButton icon={Upload} disabled={disabled} onClick={() => uploadRef.current?.click()} className="max-w-80">选择本地图片</FileUploadButton>
          <input ref={uploadRef} type="file" accept="image/*" aria-label="上传资产图片" hidden disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) { onUpload(file); onClose(); } }} />
        </TabsContent>
        <TabsContent value="library" className="min-h-0">
          <ScrollArea className="h-full" contentClassName="grid grid-cols-2 gap-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
            {loading ? <LoadingState className="col-span-full" /> : libraryImages.map((item) => <Button key={item.id} variant="outline" className="h-auto min-w-0 flex-col items-stretch p-2" disabled={disabled} aria-label={`使用个人资产：${item.title}`} onClick={() => { onInsert(canvasInsertPayloadFromMyAsset(item)); onClose(); }}>
              <ImagePreview src={item.coverUrl || item.url!} alt={item.title} className="aspect-square w-full object-contain" /><span className="w-full truncate">{item.title}</span>
            </Button>)}
            {!loading && !libraryImages.length ? <EmptyState compact title="暂无个人图片资产" description="可先将画布中的图片保存到个人资产。" className="col-span-full" /> : null}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;
}

export function ScriptAssetEditDialog({ asset, disabled, onClose, onChange }: {
  asset: CanvasScriptAsset;
  disabled: boolean;
  onClose: () => void;
  onChange: (patch: Partial<CanvasScriptAsset>) => void;
}) {
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent>
    <DialogTitle className="pr-8">编辑资产设定</DialogTitle><DialogDescription>填写名称和视觉设定，用于图片生成和提示词合成。</DialogDescription>
    <ScrollArea className="min-h-0 flex-1" contentClassName="space-y-4">
      <LabeledField label="资产名称">{(id) => <Input id={id} value={asset.name} disabled={disabled} maxLength={128} onChange={(event) => onChange({ name: event.target.value })} />}</LabeledField>
      <LabeledField label="资产设定">{(id) => <PromptInput><InputGroupTextarea id={id} value={asset.description} disabled={disabled} maxLength={20000} className="min-h-40" placeholder="描述外观、材质与视觉风格" onChange={(event) => onChange({ description: event.target.value })} /></PromptInput>}</LabeledField>
    </ScrollArea><Button onClick={onClose}>完成</Button>
  </DialogContent></Dialog>;
}

export function ScriptAssetBatchDialog({ project, nodes, disabled, onClose, onGenerate, ...settings }: ImageSettingsProps & {
  project: CanvasScriptProject;
  nodes: readonly CanvasNode[];
  disabled: boolean;
  onClose: () => void;
  onGenerate: (request: ScriptAssetGeneration) => void;
}) {
  const eligible = scriptAssetsToGenerate(project, nodes, project.assets.map((asset) => asset.id)).filter((asset) => asset.name.trim() && asset.description.trim());
  const [selected, setSelected] = useState<string[]>([]);
  const [parameters, setParameters] = useState(settings.imageDefaults);
  const selectedIDs = eligible.filter((asset) => selected.includes(asset.id)).map((asset) => asset.id);
  const allSelected = selectedIDs.length > 0 && selectedIDs.length === eligible.length;
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="flex w-[min(1068px,calc(100vw-2rem))] max-w-none flex-col sm:max-w-none">
    <DialogTitle className="pr-8">一键生成所有资产</DialogTitle><DialogDescription>选择尚未生成的资产；已有图片和已有任务的资产不会重复提交。</DialogDescription>
    <ScrollArea className="min-h-40 min-w-0 flex-1 max-h-[50dvh]" contentClassName="grid gap-3 sm:grid-cols-2">
      {eligible.map((asset) => <Card key={asset.id} className="flex-row items-start gap-3 p-3"><Checkbox id={`batch-asset-${asset.id}`} checked={selectedIDs.includes(asset.id)} disabled={disabled} onCheckedChange={(checked) => setSelected((ids) => checked ? [...ids, asset.id] : ids.filter((id) => id !== asset.id))} /><Label htmlFor={`batch-asset-${asset.id}`} className="min-w-0 flex-1 flex-col items-start"><span>{asset.name}</span><span className="line-clamp-3 text-xs text-muted-foreground">{asset.description}</span></Label></Card>)}
      {!eligible.length ? <EmptyState compact title="暂无可生成资产" description="已有图片或任务的资产请在画布节点操作；缺少名称或设定的资产请先补全。" className="col-span-full" /> : null}
    </ScrollArea>
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <Label className="flex items-center gap-2"><Checkbox checked={allSelected ? true : selectedIDs.length ? "indeterminate" : false} disabled={disabled || !eligible.length} onCheckedChange={(checked) => setSelected(checked ? eligible.map((asset) => asset.id) : [])} />全选资产 已选 {selectedIDs.length}/{eligible.length}</Label>
      <ScriptImageSettings {...settings} parameters={parameters} onChange={setParameters} />
      <Button disabled={disabled || !selectedIDs.length || !settings.imageModels.includes(parameters.generation_model || settings.imageModel)} onClick={() => { onGenerate({ assetIDs: selectedIDs, parameters }); onClose(); }}>生成（{selectedIDs.length}）</Button>
    </footer>
  </DialogContent></Dialog>;
}
