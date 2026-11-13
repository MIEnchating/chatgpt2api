import type { CanvasNode } from "@/services/api/canvas";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { resolveStorageObjectURL } from "@/services/api/storage";

export async function downloadCanvasNodeMedia(node: CanvasNode) {
  if (node.type === "text" ? !node.prompt?.trim() : !node.url) return;
  const url = node.type === "text" ? "" : await resolveStorageObjectURL(node.storage_key, node.url || "");
  const blob = node.type === "text" ? new Blob([node.prompt || ""], { type: "text/plain;charset=utf-8" }) : await fetchAuthenticatedImageBlob(url);
  const objectURL = URL.createObjectURL(blob);
  const extension = node.type === "text" ? "txt" : blob.type.split("/")[1]?.replace("jpeg", "jpg") || node.generation_output_format || (node.type === "video" ? "mp4" : node.type === "audio" ? "mp3" : "png");
  const title = (node.title || `${node.type}-${node.id}`).replace(/[\\/:*?"<>|]/g, "-");
  const fileName = (node.type === "text" ? /\.txt$/i : /\.[a-z0-9]{2,5}$/i).test(title) ? title : `${title}.${extension}`;
  const link = document.createElement("a");
  link.href = objectURL;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}
