import type { CanvasNode } from "@/services/api/canvas";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { resolveStorageObjectURL } from "@/services/api/storage";
import { createZip } from "@/lib/zip";

export async function downloadCanvasNodeMedia(node: CanvasNode) {
  if (node.type === "text" ? !node.prompt?.trim() : !node.url) return;
  const file = await canvasNodeFile(node);
  saveCanvasFile(file.data, file.name);
}

export function downloadCanvasScript(node: CanvasNode) {
  const file = canvasScriptFile(node);
  saveCanvasFile(file.data, file.name);
}

export async function downloadCanvasDeliverables(ids: readonly string[], nodes: readonly CanvasNode[]) {
  const byID = new Map(nodes.map(node => [node.id, node]));
  const files = [];
  for (const id of new Set(ids)) {
    const node = byID.get(id);
    if (!node || ["loading", "error", "cancelled"].includes(node.generation_status || "") ||
      (node.type === "script" ? !node.script_project?.shots.length : node.type === "text" ? !node.prompt?.trim() :
        !["image", "panorama", "video", "audio"].includes(node.type) || !node.url || Boolean(node.task_id && node.generation_status !== "success"))) {
      throw new Error("部分成品已移除或尚未就绪，请核对画布");
    }
    files.push(node.type === "script" ? canvasScriptFile(node) : await canvasNodeFile(node));
  }
  if (files.length === 1) {
    saveCanvasFile(files[0].data, files[0].name);
  } else if (files.length > 1) {
    const archive = await createZip(files.map((file, index) => ({ ...file, name: `${index + 1}-${file.name}` })));
    saveCanvasFile(archive, "本轮成品.zip");
  }
}

async function canvasNodeFile(node: CanvasNode) {
  if (node.type === "text") return { name: canvasFileName(node, "txt"), data: new Blob([node.prompt || ""], { type: "text/plain;charset=utf-8" }) };
  const url = await resolveStorageObjectURL(node.storage_key, node.url || "");
  const data = await fetchAuthenticatedImageBlob(url);
  const subtype = data.type.split("/")[1];
  const extension = ({ jpeg: "jpg", "svg+xml": "svg", "x-wav": "wav", mpeg: node.type === "audio" ? "mp3" : "mpeg", quicktime: "mov" } as Record<string, string>)[subtype]
    || (/^[a-z0-9]{2,10}$/i.test(subtype) && subtype !== "octet-stream" ? subtype : "")
    || node.generation_output_format || (node.type === "video" ? "mp4" : node.type === "audio" ? "mp3" : "png");
  return { name: canvasFileName(node, extension), data };
}

function canvasScriptFile(node: CanvasNode) {
  return { name: canvasFileName(node, "json"), data: new Blob([JSON.stringify({ title: node.title, story: node.prompt, ...node.script_project }, null, 2)], { type: "application/json;charset=utf-8" }) };
}

function canvasFileName(node: CanvasNode, extension: string) {
  const safe = Array.from(node.title || node.type, char => char.charCodeAt(0) < 32 ? "-" : char).join("");
  const title = Array.from(safe.replace(/[\\/:*?"<>|]/g, "-").trim().replace(/^\.+|[. ]+$/g, "")).slice(0, 96).join("") || node.type;
  const stem = title.replace(/\.[a-z0-9]{2,5}$/i, "");
  return `${stem}.${extension}`;
}

function saveCanvasFile(blob: Blob, fileName: string) {
  const objectURL = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectURL;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}
