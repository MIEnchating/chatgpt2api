
import { FieldError } from "@/components/ui/field";
import { PromptInput } from "@/components/ai-elements/prompt-input";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { LabeledField } from "@/components/labeled-field";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { SortableList, SortableItem, SortableHandle } from "@/components/sortable-list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { nanoid } from "nanoid";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, Clapperboard, GripVertical, MoreHorizontal, Plus, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { ScriptAssetCard, ScriptAssetImageDialog, ScriptAssetEditDialog, ScriptAssetBatchDialog } from "./canvas-script-assets";
import { Checkbox } from "@/components/ui/checkbox";
import type { CanvasInsertAssetPayload } from "./agent/canvas-agent-types";
import type { ScriptAssetGeneration } from "./canvas-script";
import { cn } from "@/lib/utils";
import type {
  CanvasNode,
  CanvasScriptAsset,
  CanvasScriptProject,
  CanvasScriptShot,
} from "@/services/api/canvas";
import { CanvasInlineModelSelect } from "./canvas-inline-model-select";
import {
  createScriptShot,
  SCRIPT_CAMERAS,
  SCRIPT_COLORS,
  SCRIPT_FRAMINGS,
  scriptProgress,
  scriptCanGenerateMedia,
  updateScriptShot,
} from "./canvas-script";

type Props = {
  node: CanvasNode;
  nodes: readonly CanvasNode[];
  project: CanvasScriptProject;
  models: string[];
  defaultModel: string;
  running: boolean;
  onClose: () => void;
  onChange: (project: CanvasScriptProject) => void;
  onModelChange: (model: string) => void;
  onSynthesize: (shotIDs: string[], smart: boolean) => void;
  scope: string;
  imageModels: string[];
  imageModel: string;
  imageDefaults: CanvasNode;
  onGenerateAssets: (request: ScriptAssetGeneration) => void;
  onInsertAsset: (assetID: string, payload: CanvasInsertAssetPayload) => void;
  onNavigateAsset: (nodeID: string) => void;
  onSaveAsset: (nodeID: string) => void;
  onUploadAsset: (assetID: string, file: File) => void;
  onGenerateMedia: (type: "image" | "video") => void;
  onStop: () => void;
};

export function CanvasScriptWorkspace(props: Props) {
  const { node, nodes, project, running, onChange } = props;
  const [promptShotID, setPromptShotID] = useState("");
  const [smart, setSmart] = useState(false);
  const [assetDialog, setAssetDialog] = useState<{ id: string; tab: "ai" | "canvas" } | null>(null);
  const [editingAssetID, setEditingAssetID] = useState("");
  const [batchAssetsOpen, setBatchAssetsOpen] = useState(false);
  const [synthesisOpen, setSynthesisOpen] = useState(false);
  const [selectedShots, setSelectedShots] = useState<string[]>([]);
  const selectedShotIDs = project.shots.filter((shot) => selectedShots.includes(shot.id) && shot.description.trim()).map((shot) => shot.id);
  const eligibleShots = project.shots.filter((shot) => shot.description.trim());
  const selectedAsset = project.assets.find((asset) => asset.id === assetDialog?.id);
  const editingAsset = project.assets.find((asset) => asset.id === editingAssetID);
  const imageSettings = { imageModels: props.imageModels, imageModel: props.imageModel, imageDefaults: props.imageDefaults };
  const nodeByID = useMemo(() => new Map(nodes.map((item) => [item.id, item])), [nodes]);
  const progress = scriptProgress(project, nodes, nodeByID);
  const promptShot = project.shots.find((shot) => shot.id === promptShotID);
  const changeShot = (id: string, patch: Partial<CanvasScriptShot>) =>
    onChange(updateScriptShot(project, id, patch));
  const changeAsset = (id: string, patch: Partial<CanvasScriptAsset>) =>
    onChange({
      ...project,
      assets: project.assets.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)),
      shots: project.shots.map((shot) =>
        shot.asset_ids.includes(id) || shot.dialogue.some((line) => line.asset_id === id)
          ? { ...shot, image_prompt: "", video_prompt: "" }
          : shot,
      ),
    });
  const addAsset = (kind: CanvasScriptAsset["kind"]) => {
    const id = nanoid();
    onChange({ ...project, assets: [...project.assets, { id, kind, name: "", description: "", image_node_id: "" }] });
    setEditingAssetID(id);
  };
  const canConfirm =
    project.shots.length > 0 && project.shots.every((shot) => shot.description.trim());
  const summaries = [
    `${project.shots.length} 个镜头${progress.steps[0] ? "已确认" : "待核对"}`,
    project.assets.length ? `${progress.readyAssets}/${project.assets.length} 已准备` : "暂无资产",
    `${progress.readyShots}/${project.shots.length} 已合成`,
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        aria-describedby="script-workspace-description"
        showCloseButton={false}
        className="inset-0 top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 sm:max-w-none"
        data-canvas-script-workspace
      >
        <DialogTitle className="sr-only">{node.title || "脚本"}编辑器</DialogTitle>
        <DialogDescription id="script-workspace-description" className="sr-only">
          确认镜头、准备资产并合成提示词。修改会自动保存到画布。
        </DialogDescription>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <nav
            aria-label="脚本制作步骤"
            className="flex min-w-0 flex-1 items-center justify-center gap-1 sm:gap-6"
          >
            {["确认镜头", "准备资产", "合成提示词"].map((label, index) => (
              <div key={label} className="flex min-w-0 items-center gap-2 sm:gap-6">
                <Button variant="ghost"
                  type="button"
                  aria-current={project.step === index ? "step" : undefined}
                  onClick={() => onChange({ ...project, step: index })}
                  className={cn("flex flex-col items-center text-left sm:flex-row h-auto min-h-8 whitespace-normal py-2", progress.steps[index] || project.step === index ? "text-foreground" : "text-muted-foreground")}
                >
                  <Badge variant={progress.steps[index] ? "default" : "outline"} className="size-7 p-0 text-sm sm:size-9">
                    {progress.steps[index] ? <Check aria-hidden="true" /> : index + 1}
                  </Badge>
                  <span className="min-w-0">
                    <span className="block whitespace-nowrap text-xs font-medium sm:text-sm">
                      {label}
                    </span>
                    <span className="mt-1 hidden text-xs text-muted-foreground sm:block">
                      {summaries[index]}
                    </span>
                  </span>
                </Button>
                {index < 2 ? (
                  <Separator className="hidden data-horizontal:w-12 lg:block xl:data-horizontal:w-24" />
                ) : null}
              </div>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{progress.complete}/3 完成</span>
            {running ? (
              <Button variant="outline" size="sm" onClick={props.onStop}>
                <Spinner />
                停止
              </Button>
            ) : null}
            <Button variant="ghost" size="icon" aria-label="关闭脚本编辑器" onClick={props.onClose}>
              <X  />
            </Button>
          </div>
        </header>
        {node.generation_error ? (
          <FieldError className="px-8 pb-2">
            {node.generation_error}
          </FieldError>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 sm:px-8 sm:pb-6">
          {project.step === 1 ? (
            <>
              <ScrollArea className="min-h-0 min-w-0 flex-1" contentClassName="py-5">
                {(["character", "scene", "prop"] as const).map((kind) => (
                  <section key={kind} className="mb-8">
                    <h2 className="mb-3 text-sm font-medium">
                      {{ character: "角色", scene: "场景", prop: "道具" }[kind]}
                    </h2>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {project.assets
                        .filter((asset) => asset.kind === kind)
                        .map((asset) => (
                          <ScriptAssetCard
                            key={asset.id}
                            asset={asset}
                            nodes={nodes}
                            disabled={running}
                            onChoose={() => setAssetDialog({ id: asset.id, tab: "canvas" })}
                            onGenerate={() => setAssetDialog({ id: asset.id, tab: "ai" })}
                            onEdit={() => setEditingAssetID(asset.id)}
                            onClear={() => changeAsset(asset.id, { image_node_id: "" })}
                            onNavigate={() => props.onNavigateAsset(asset.image_node_id)}
                            onSave={() => props.onSaveAsset(asset.image_node_id)}
                            onRemove={() =>
                              onChange({
                                ...project,
                                assets: project.assets.filter((item) => item.id !== asset.id),
                                confirmed: false,
                                shots: project.shots.map((shot) => ({
                                  ...shot,
                                  image_prompt: "",
                                  video_prompt: "",
                                  asset_ids: shot.asset_ids.filter((id) => id !== asset.id),
                                  dialogue: shot.dialogue.map((line) =>
                                    line.asset_id === asset.id ? { ...line, asset_id: "" } : line,
                                  ),
                                })),
                              })
                            }
                          />
                        ))}
                      <Button variant="outline"
                        type="button"
                        disabled={running || project.assets.length >= 120}
                        onClick={() => addAsset(kind)}
                        className="flex min-h-52 flex-col items-center justify-center disabled:opacity-40"
                      >
                        <Plus  />
                        <span className="text-xs">
                          新增{{ character: "角色", scene: "场景", prop: "道具" }[kind]}
                        </span>
                      </Button>
                    </div>
                  </section>
                ))}
              </ScrollArea>
              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border py-4">
                <span className="text-xs text-muted-foreground">
                  {project.assets.length - progress.readyAssets} 个资产待准备，可上传图片或 AI 生成
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={running || !project.assets.length}
                    onClick={() => setBatchAssetsOpen(true)}
                  >
                    <Sparkles  />
                    一键生成所有资产
                  </Button>
                  <Button onClick={() => onChange({ ...project, step: 2 })}>
                    下一步：合成提示词
                    <ArrowRight  />
                  </Button>
                </div>
              </footer>
            </>
          ) : (
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden gap-0 p-0">
              <ScrollArea className="min-h-0 min-w-0 flex-1">
                <Table className="min-w-[1280px] table-fixed">
                  <colgroup>
                    {[64, 80, 300, 100, 160, 240, 140, 140, 160, 64].map((width, i) => (
                      <col key={i} style={{ width: `${(width / 1448) * 100}%` }} />
                    ))}
                  </colgroup>
                  <TableHeader className="sticky top-0 z-10">
                    <TableRow>
                      {[
                        "镜号",
                        "时长",
                        "画面描述",
                        "景别",
                        "光影氛围",
                        "对白·旁白",
                        "音效",
                        "运镜",
                        "最终提示词",
                        "操作",
                      ].map((label) => (
                        <TableHead
                          key={label}
                        >
                          {label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody asChild>
                    <SortableList as="tbody" values={project.shots.map((shot) => shot.id)} disabled={running} aria-label="脚本镜头排序" onReorder={(ids) => {
                      const shots = new Map(project.shots.map((shot) => [shot.id, shot]));
                      onChange({ ...project, confirmed: false, shots: ids.map((id) => shots.get(id)!) });
                    }}>
                      {(order) => order.map((id, index) => {
                        const shot = project.shots.find((shot) => shot.id === id)!;
                        return (
                        <TableRow key={shot.id} asChild>
                          <SortableItem as="tr" value={shot.id} label={`镜头 ${index + 1}`} style={shot.color ? { backgroundColor: `${shot.color}18` } : undefined}>
                            <TableCell className="min-w-0">
                              <SortableHandle aria-label={`拖动镜头 ${index + 1} 排序`} size="default">
                                <GripVertical className="text-muted-foreground" />
                                {index + 1}
                              </SortableHandle>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <Select
                                value={String(shot.seconds)}
                                disabled={running}
                                onValueChange={(value) =>
                                  changeShot(shot.id, { seconds: Number(value) })
                                }
                              >
                                <SelectTrigger
                                  aria-label={`镜头 ${index + 1} 时长`}

                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Array.from({ length: 60 }, (_, i) => i + 1).map((seconds) => (
                                    <SelectItem key={seconds} value={String(seconds)}>
                                      {seconds}s
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <ScriptCell
                                label={`镜头 ${index + 1} 画面描述`}
                                value={shot.description}
                                disabled={running}
                              >
                                <ScriptDescriptionEditor
                                  shot={shot}
                                  assets={project.assets}
                                  onChange={(patch) => changeShot(shot.id, patch)}
                                />
                              </ScriptCell>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <Select
                                value={shot.framing || "__empty__"}
                                disabled={running}
                                onValueChange={(framing) =>
                                  changeShot(shot.id, {
                                    framing: framing === "__empty__" ? "" : framing,
                                  })
                                }
                              >
                                <SelectTrigger
                                  aria-label={`镜头 ${index + 1} 景别`}

                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__empty__">未设置</SelectItem>
                                  {[
                                    ...new Set([
                                      ...SCRIPT_FRAMINGS,
                                      ...(shot.framing ? [shot.framing] : []),
                                    ]),
                                  ].map((value) => (
                                    <SelectItem key={value} value={value}>
                                      {value}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <ScriptCell
                                label={`镜头 ${index + 1} 光影氛围`}
                                value={shot.lighting}
                                disabled={running}
                              >
                                <TextEditor
                                  value={shot.lighting}
                                  placeholder="例如：日系青春动漫风、戏剧冲突氛围…"
                                  onChange={(lighting) => changeShot(shot.id, { lighting })}
                                />
                              </ScriptCell>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <ScriptCell
                                label={`镜头 ${index + 1} 对白旁白`}
                                value={shot.dialogue
                                  .map(
                                    (line) =>
                                      `${line.kind === "narration" ? "旁白" : project.assets.find((asset) => asset.id === line.asset_id)?.name || "台词"}：${line.text}`,
                                  )
                                  .join("\n")}
                                disabled={running}
                              >
                                {!shot.dialogue.length ? (
                                  <p className="text-xs text-muted-foreground">
                                    空：请点击下方按钮添加
                                  </p>
                                ) : null}
                                {shot.dialogue.map((line) => (
                                  <div key={line.id} className="flex flex-wrap items-center gap-2">
                                    <Badge variant="secondary"
                                    >
                                      {line.kind === "narration" ? "旁白" : "台词"}
                                    </Badge>
                                    {line.kind === "dialogue" ? (
                                      <Select
                                        value={line.asset_id || "__unbound__"}
                                        onValueChange={(value) =>
                                          changeShot(shot.id, {
                                            dialogue: shot.dialogue.map((item) =>
                                              item.id === line.id
                                                ? {
                                                    ...item,
                                                    asset_id: value === "__unbound__" ? "" : value,
                                                  }
                                                : item,
                                            ),
                                          })
                                        }
                                      >
                                        <SelectTrigger aria-label="绑定角色" className="w-28">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="__unbound__">未绑定</SelectItem>
                                          {project.assets
                                            .filter((asset) => asset.kind === "character")
                                            .map((asset) => (
                                              <SelectItem key={asset.id} value={asset.id}>
                                                {asset.name || "未命名角色"}
                                              </SelectItem>
                                            ))}
                                        </SelectContent>
                                      </Select>
                                    ) : null}
                                    <Input
                                      aria-label={line.kind === "narration" ? "旁白内容" : "台词内容"}
                                      value={line.text}
                                      className="min-w-24 flex-1"
                                      onChange={(event) =>
                                        changeShot(shot.id, {
                                          dialogue: shot.dialogue.map((item) =>
                                            item.id === line.id
                                              ? { ...item, text: event.target.value }
                                              : item,
                                          ),
                                        })
                                      }
                                    />
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      aria-label="删除对白"
                                      onClick={() =>
                                        changeShot(shot.id, {
                                          dialogue: shot.dialogue.filter((item) => item.id !== line.id),
                                        })
                                      }
                                    >
                                      <X  />
                                    </Button>
                                  </div>
                                ))}
                                <div className="flex gap-2 border-t border-border pt-3">
                                  {(["dialogue", "narration"] as const).map((kind) => (
                                    <Button
                                      key={kind}
                                      variant="secondary"
                                      size="sm"
                                      disabled={shot.dialogue.length >= 100}
                                      onClick={() =>
                                        changeShot(shot.id, {
                                          dialogue: [
                                            ...shot.dialogue,
                                            { id: nanoid(), kind, text: "", asset_id: "" },
                                          ],
                                        })
                                      }
                                    >
                                      <Plus  />
                                      {kind === "dialogue" ? "台词" : "旁白"}
                                    </Button>
                                  ))}
                                </div>
                              </ScriptCell>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <ScriptCell
                                label={`镜头 ${index + 1} 音效`}
                                value={shot.sound}
                                disabled={running}
                              >
                                <TextEditor
                                  value={shot.sound}
                                  placeholder="例如：风声、雨声、脚步声、鼓点……"
                                  onChange={(sound) => changeShot(shot.id, { sound })}
                                />
                              </ScriptCell>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <ScriptCell
                                label={`镜头 ${index + 1} 运镜`}
                                value={shot.camera}
                                disabled={running}
                              >
                                <TextEditor
                                  value={shot.camera}
                                  placeholder="描述镜头运动"
                                  onChange={(camera) => changeShot(shot.id, { camera })}
                                />
                                <div className="flex flex-wrap gap-2">
                                  {SCRIPT_CAMERAS.map((camera) => (
                                    <Button
                                      key={camera}
                                      variant={shot.camera === camera ? "secondary" : "outline"}
                                      size="sm"
                                      onClick={() => changeShot(shot.id, { camera })}
                                    >
                                      {camera}
                                    </Button>
                                  ))}
                                </div>
                                <p className="text-xs text-muted-foreground">点击预设直接填入</p>
                              </ScriptCell>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="max-w-full whitespace-normal h-auto min-h-7"
                                onClick={() => setPromptShotID(shot.id)}
                              >
                                {shot.image_prompt.trim() && shot.video_prompt.trim()
                                  ? "查看提示词"
                                  : "待生成提示词"}
                              </Button>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={running}
                                    aria-label={`镜头 ${index + 1} 操作`}
                                  >
                                    <MoreHorizontal  />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent align="end" className="w-56">
                                  <p className="text-xs text-muted-foreground">请选择颜色</p>
                                  <div className="flex gap-2">
                                    {SCRIPT_COLORS.map((color) => (
                                      <Toggle variant="outline" size="sm"
                                        key={color}
                                        type="button"
                                        aria-label={color || "清除颜色"}
                                        pressed={shot.color === color}
                                        onClick={() => changeShot(shot.id, { color })}
                                        style={{ backgroundColor: color || "transparent" }}
                                        className="grid place-items-center"
                                      >
                                        {shot.color === color ? <Check  /> : null}
                                      </Toggle>
                                    ))}
                                  </div>
                                  <div className="flex gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={index === 0}
                                      onClick={() => {
                                        const reordered = [...project.shots];
                                        [reordered[index - 1], reordered[index]] = [
                                          reordered[index],
                                          reordered[index - 1],
                                        ];
                                        onChange({ ...project, confirmed: false, shots: reordered });
                                      }}
                                    >
                                      上移
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={index === project.shots.length - 1}
                                      onClick={() => {
                                        const reordered = [...project.shots];
                                        [reordered[index], reordered[index + 1]] = [
                                          reordered[index + 1],
                                          reordered[index],
                                        ];
                                        onChange({ ...project, confirmed: false, shots: reordered });
                                      }}
                                    >
                                      下移
                                    </Button>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="w-full justify-start"
                                    onClick={() =>
                                      onChange({
                                        ...project,
                                        confirmed: false,
                                        shots: project.shots.filter((item) => item.id !== shot.id),
                                      })
                                    }
                                  >
                                    <Trash2  />
                                    删除该行
                                  </Button>
                                </PopoverContent>
                              </Popover>
                            </TableCell>
                          </SortableItem>
                        </TableRow>
                      ); })}
                    </SortableList>
                  </TableBody>
                </Table>
                {!project.shots.length ? (
                  <EmptyState
                    icon={Clapperboard}
                    title="还没有镜头"
                    description="添加镜头，或回到画布输入故事生成脚本。"
                  />
                ) : null}
              </ScrollArea>
              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border p-3 sm:p-4">
                <Button
                  variant="ghost"
                  disabled={running || project.shots.length >= 200}
                  onClick={() =>
                    onChange({
                      ...project,
                      confirmed: false,
                      shots: [...project.shots, createScriptShot()],
                    })
                  }
                >
                  <Plus  />
                  添加镜头
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  {project.step === 0 ? (
                    <Button
                      disabled={running || !canConfirm}
                      onClick={() => onChange({ ...project, confirmed: true, step: 1 })}
                    >
                      确认镜头，下一步：准备资产
                      <ArrowRight  />
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        disabled={running || !canConfirm}
                        onClick={() => { setSelectedShots([]); setSynthesisOpen(true); }}
                      >
                        <Sparkles />
                        一键合成全部提示词
                      </Button>
                      <Button
                        variant="outline"
                        disabled={running || !scriptCanGenerateMedia(project, "image", nodes, nodeByID)}
                        onClick={() => props.onGenerateMedia("image")}
                      >
                        批量生成分镜
                      </Button>
                      <Button
                        disabled={running || !scriptCanGenerateMedia(project, "video", nodes, nodeByID)}
                        onClick={() => props.onGenerateMedia("video")}
                      >
                        批量生成视频
                      </Button>
                      <p className="basis-full text-xs text-muted-foreground">
                        已关联素材复用原节点配置和任务进度，无需重复合成提示词。需要重新生成时，请在对应素材节点操作。
                      </p>
                    </>
                  )}
                </div>
              </footer>
            </Card>
          )}
        </div>
        {selectedAsset && assetDialog ? <ScriptAssetImageDialog key={`${selectedAsset.id}:${assetDialog.tab}`} {...imageSettings} asset={selectedAsset} nodes={nodes} initialTab={assetDialog.tab} scope={props.scope} disabled={running} onClose={() => setAssetDialog(null)} onChoose={(image_node_id) => changeAsset(selectedAsset.id, { image_node_id })} onUpload={(file) => props.onUploadAsset(selectedAsset.id, file)} onInsert={(payload) => props.onInsertAsset(selectedAsset.id, payload)} onGenerate={props.onGenerateAssets} /> : null}
        {editingAsset ? <ScriptAssetEditDialog asset={editingAsset} disabled={running} onClose={() => setEditingAssetID("")} onChange={(patch) => changeAsset(editingAsset.id, patch)} /> : null}
        {batchAssetsOpen ? <ScriptAssetBatchDialog {...imageSettings} project={project} nodes={nodes} disabled={running} onClose={() => setBatchAssetsOpen(false)} onGenerate={props.onGenerateAssets} /> : null}
        <Dialog open={synthesisOpen} onOpenChange={setSynthesisOpen}>
          <DialogContent className="flex w-[min(1068px,calc(100vw-2rem))] max-w-none flex-col sm:max-w-none">
            <DialogTitle>合成最终提示词</DialogTitle>
            <DialogDescription>选择需要合成的镜头，再选择智能合成或自动拼接。合成会覆盖所选镜头的现有提示词。</DialogDescription>
            <ScrollArea className="min-h-0 max-h-[50dvh] flex-1" contentClassName="space-y-2">
              {project.shots.map((shot, index) => <Card key={shot.id} className="flex-row items-center gap-3 p-3">
                <Checkbox id={`synthesis-${shot.id}`} checked={selectedShotIDs.includes(shot.id)} disabled={running || !shot.description.trim()} onCheckedChange={(checked) => setSelectedShots((ids) => checked ? [...ids, shot.id] : ids.filter((id) => id !== shot.id))} />
                <Label htmlFor={`synthesis-${shot.id}`} className="shrink-0">镜头 {index + 1}</Label>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{shot.description || "请先填写画面描述"}</span>
                <Button variant="ghost" size="sm" onClick={() => setPromptShotID(shot.id)}>详情</Button>
              </Card>)}
            </ScrollArea>
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <Label className="flex items-center gap-2"><Checkbox checked={selectedShotIDs.length && selectedShotIDs.length === eligibleShots.length ? true : selectedShotIDs.length ? "indeterminate" : false} disabled={running || !eligibleShots.length} onCheckedChange={(checked) => setSelectedShots(checked ? eligibleShots.map((shot) => shot.id) : [])} />全选镜头 已选 {selectedShotIDs.length}/{eligibleShots.length}</Label>
              {smart ? <CanvasInlineModelSelect label="提示词合成模型" models={props.models} value={node.generation_text_model || props.defaultModel} onChange={props.onModelChange} className="max-w-64" /> : null}
              <RadioGroup value={smart ? "smart" : "automatic"} onValueChange={(value) => setSmart(value === "smart")} aria-label="批量提示词合成方式" className="flex w-auto flex-wrap">
                <Label className="flex items-center gap-1.5"><RadioGroupItem value="smart" />智能合成</Label>
                <Label className="flex items-center gap-1.5"><RadioGroupItem value="automatic" />自动拼接</Label>
              </RadioGroup>
              <Button disabled={running || !selectedShotIDs.length || (smart && !props.models.includes(node.generation_text_model || props.defaultModel))} onClick={() => { props.onSynthesize(selectedShotIDs, smart); setSynthesisOpen(false); }}>确认合成</Button>
            </footer>
          </DialogContent>
        </Dialog>
        <Dialog
          open={Boolean(promptShot)}
          onOpenChange={(open) => {
            if (!open) setPromptShotID("");
          }}
        >
          <DialogContent className="w-[min(960px,calc(100vw-2rem))] sm:max-w-none">
            <DialogTitle>
              第 {project.shots.findIndex((shot) => shot.id === promptShotID) + 1} 镜：最终提示词
            </DialogTitle>
            <DialogDescription>修改自动保存；再次合成会覆盖当前提示词。</DialogDescription>
            {promptShot ? (
              <>
                <ScrollArea className="min-h-0 min-w-0 flex-1" contentClassName="space-y-5">
                  <LabeledField className="grid gap-2 text-sm" label="分镜提示词">{(fieldId) => <PromptInput><InputGroupTextarea id={fieldId}
                      aria-label="分镜提示词"
                      disabled={running}
                      value={promptShot.image_prompt}
                      onChange={(event) =>
                        changeShot(promptShot.id, { image_prompt: event.target.value })
                      }
                      className="min-h-40"
                      placeholder="点击立即合成提示词，或手动输入"
                    /></PromptInput>}</LabeledField>
                  <LabeledField className="grid gap-2 text-sm" label="视频运动提示词">{(fieldId) => <PromptInput><InputGroupTextarea id={fieldId}
                      aria-label="视频运动提示词"
                      disabled={running}
                      value={promptShot.video_prompt}
                      onChange={(event) =>
                        changeShot(promptShot.id, { video_prompt: event.target.value })
                      }
                      className="min-h-40"
                      placeholder="描述运动、运镜、对白和音效"
                    /></PromptInput>}</LabeledField>
                </ScrollArea>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                  <CanvasInlineModelSelect
                    label="提示词合成模型"
                    models={props.models}
                    value={node.generation_text_model || props.defaultModel}
                    onChange={props.onModelChange}
                    className="max-w-64"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <RadioGroup value={smart ? "smart" : "automatic"} onValueChange={(value) => setSmart(value === "smart")} aria-label="提示词合成方式" className="flex w-auto">
                      <Label className="flex items-center gap-1.5 text-xs"><RadioGroupItem value="smart" />智能合成</Label>
                      <Label className="flex items-center gap-1.5 text-xs"><RadioGroupItem value="automatic" />自动拼接</Label>
                    </RadioGroup>
                    <Button
                      disabled={running || !promptShot.description.trim()}
                      onClick={() => props.onSynthesize([promptShot.id], smart)}
                    >
                      {running ? <Spinner /> : null}
                      立即合成提示词
                    </Button>
                  </div>
                </div>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

function ScriptCell({
  label,
  value,
  disabled,
  children,
}: {
  label: string;
  value: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost"
          type="button"
          disabled={disabled}
          aria-label={label}
          className="h-auto p-0 block min-h-20 w-full whitespace-pre-wrap break-words px-3 py-3 text-left align-top"
        >
          <span className={cn("line-clamp-3", !value && "text-muted-foreground/50")}>
            {value || "点击填写"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-[min(480px,calc(100vw-2rem))]"
      >
        <ScrollArea className="min-h-0 min-w-0 flex-1 max-h-[55dvh]" contentClassName="space-y-3">{children}</ScrollArea>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">失焦自动保存</span>
          <Button size="sm" onClick={() => setOpen(false)}>
            保存
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TextEditor({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Textarea
      aria-label={placeholder}
      value={value}
      placeholder={placeholder}
      maxLength={20000}
      onChange={(event) => onChange(event.target.value)}
      className="min-h-24"
    />
  );
}

function ScriptDescriptionEditor({
  shot,
  assets,
  onChange,
}: {
  shot: CanvasScriptShot;
  assets: CanvasScriptAsset[];
  onChange: (patch: Partial<CanvasScriptShot>) => void;
}) {
  const mention = shot.description.match(/@([^\s@]*)$/);
  const candidates = mention ? assets.filter((asset) => asset.name.includes(mention[1])) : assets;
  return (
    <>
      <TextEditor
        value={shot.description}
        placeholder="描述主体、动作与场景"
        onChange={(description) => onChange({ description })}
      />
      <p className="text-xs text-muted-foreground">输入 @ 选择资产，点击已选资产可取消引用</p>
      <div className="flex flex-wrap gap-1">
        {candidates.map((asset) => {
          const selected = shot.asset_ids.includes(asset.id);
          return (
            <Toggle
              key={asset.id}
              pressed={selected}

              size="sm"
              onClick={() => {
                const adding = Boolean(mention) || !selected;
                const description = mention
                  ? shot.description.slice(0, mention.index) + `@${asset.name} `
                  : adding
                    ? `${shot.description}${shot.description ? " " : ""}@${asset.name || "未命名资产"}`
                    : shot.description;
                onChange({
                  asset_ids: adding
                    ? [...new Set([...shot.asset_ids, asset.id])]
                    : shot.asset_ids.filter((id) => id !== asset.id),
                  description,
                });
              }}
            >
              {selected ? <Check  /> : <Plus  />}
              {asset.name || "未命名资产"}
            </Toggle>
          );
        })}
      </div>
      {mention && !candidates.length ? (
        <EmptyState compact title="暂无匹配资产" description="可在「准备资产」中新增" className="min-h-0 p-2" />
      ) : null}
    </>
  );
}
