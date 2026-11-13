import type { CanvasNode } from "@/services/api/canvas";

export function canvasScriptProductionNodes(script: CanvasNode, nodes: readonly CanvasNode[]) {
  const project = script.script_project;
  const ids = new Set([
    script.id,
    ...(project?.assets.map(asset => asset.image_node_id) || []),
    ...(project?.shots.flatMap(shot => [shot.image_node_id, shot.video_node_id]) || []),
    project?.merged_video_node_id,
  ].filter((id): id is string => Boolean(id)));
  const byID = new Map(nodes.map(node => [node.id, node]));
  const visible = new Map<string, CanvasNode>();
  for (const id of ids) {
    const node = byID.get(id);
    if (!node) continue;
    const root = node.batch_root_id ? byID.get(node.batch_root_id) : undefined;
    const target = root && !root.batch_expanded ? root : node;
    visible.set(target.id, target);
  }
  return [...visible.values()];
}

// Script lanes keep material inputs, paired shots, and the movie in reading order.
export function canvasScriptProductionLayout(script: CanvasNode, nodes: readonly CanvasNode[], origin = { x: script.x, y: script.y }, eligible = new Set(nodes.map(node => node.id))) {
  const project = script.script_project;
  const byID = new Map(nodes.map(node => [node.id, node]));
  const positions = new Map<string, { x: number; y: number }>();
  const materialIDs = [...new Set(project?.assets.map(asset => asset.image_node_id).filter(Boolean))];
  const materials = materialIDs.flatMap(id => byID.has(id) ? [byID.get(id)!] : []);
  const images = project?.shots.flatMap(shot => byID.has(shot.image_node_id || "") ? [byID.get(shot.image_node_id!)!] : []) || [];
  const videos = project?.shots.flatMap(shot => byID.has(shot.video_node_id || "") ? [byID.get(shot.video_node_id!)!] : []) || [];
  const materialWidth = Math.max(240, ...materials.map(node => node.width));
  const materialHeight = Math.max(240, ...materials.map(node => node.height));
  const imageWidth = Math.max(360, ...images.map(node => node.width));
  const videoWidth = Math.max(360, ...videos.map(node => node.width));
  const scriptX = origin.x + (materials.length ? (materialWidth + 36) * Math.min(2, materials.length) + 84 : 0);
  const imageX = scriptX + script.width + 120;
  const videoX = imageX + imageWidth + 80;
  const movieX = videoX + videoWidth + 120;
  const place = (id: string | undefined, x: number, y: number) => {
    if (id && eligible.has(id) && byID.has(id) && !positions.has(id)) positions.set(id, { x, y });
  };
  place(script.id, scriptX, origin.y);
  materials.forEach((node, index) => place(node.id, origin.x + index % 2 * (materialWidth + 36), origin.y + Math.floor(index / 2) * (materialHeight + 36)));
  let y = origin.y;
  for (const shot of project?.shots || []) {
    place(shot.image_node_id, imageX, y);
    place(shot.video_node_id, videoX, y);
    y += Math.max(240, byID.get(shot.image_node_id || "")?.height || 0, byID.get(shot.video_node_id || "")?.height || 0) + 64;
  }
  place(project?.merged_video_node_id, movieX, origin.y);
  const right = Math.max(origin.x, ...[...positions].map(([id, point]) => point.x + byID.get(id)!.width));
  const bottom = Math.max(origin.y, ...[...positions].map(([id, point]) => point.y + byID.get(id)!.height));
  return { positions, right, bottom };
}

// New media use reserved shot rows while existing authored positions stay intact.
export function canvasScriptShotPosition(script: CanvasNode, type: "image" | "video", shotIndex: number, nodes: readonly CanvasNode[], size: { width: number; height: number }) {
  const project = script.script_project;
  const byID = new Map(nodes.map(node => [node.id, node]));
  const images = project?.shots.flatMap(shot => byID.has(shot.image_node_id || "") ? [byID.get(shot.image_node_id!)!] : []) || [];
  const imageX = script.x + script.width + 120;
  const videoX = Math.max(imageX + 480, ...images.map(node => node.x + node.width + 80));
  let y = script.y;
  for (const shot of project?.shots.slice(0, shotIndex) || []) y += Math.max(480, byID.get(shot.image_node_id || "")?.height || 0, byID.get(shot.video_node_id || "")?.height || 0) + 64;
  const paired = type === "video" ? byID.get(project?.shots[shotIndex]?.image_node_id || "") : undefined;
  y = paired?.y ?? y;
  const x = type === "image" ? imageX : videoX;
  while (true) {
    const collision = nodes.find(node => node.type !== "group" && x < node.x + node.width + 24 && x + size.width + 24 > node.x && y < node.y + node.height + 24 && y + size.height + 24 > node.y);
    if (!collision) return { x, y };
    y = collision.y + collision.height + 64;
  }
}
