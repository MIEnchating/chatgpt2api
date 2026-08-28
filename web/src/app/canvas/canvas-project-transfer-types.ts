import type { CanvasDocument } from "../../services/api/canvas.ts";

export type CanvasExportAsset = {
  storageKey: string;
  path: string;
  mimeType: string;
  bytes: number;
};

export type CanvasExportFile = {
  app: "infinite-canvas";
  version: 3;
  exportedAt: string;
  projects: Array<{
    project: CanvasDocument;
    files: CanvasExportAsset[];
  }>;
};

export function isCanvasExportFile(value: unknown): value is CanvasExportFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanvasExportFile>;
  if (candidate.app !== "infinite-canvas" || candidate.version !== 3 || !Array.isArray(candidate.projects)) return false;
  return candidate.projects.every((item) => {
    if (!item || typeof item !== "object") return false;
    const projectItem = item as { project?: Partial<CanvasDocument>; files?: unknown };
    return typeof projectItem.project?.id === "string"
      && Array.isArray(projectItem.project.nodes)
      && Array.isArray(projectItem.project.connections)
      && Array.isArray(projectItem.files)
      && projectItem.files.every(isCanvasExportAsset);
  });
}

function isCanvasExportAsset(value: unknown): value is CanvasExportAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<CanvasExportAsset>;
  return typeof asset.storageKey === "string"
    && typeof asset.path === "string"
    && typeof asset.mimeType === "string"
    && typeof asset.bytes === "number";
}
