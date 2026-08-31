const CANVAS_PROJECT_ID_PREFIX = "canvas-";

export function canvasProjectPath(projectID: string) {
  if (!projectID.startsWith(CANVAS_PROJECT_ID_PREFIX)) {
    throw new Error("画布项目 ID 格式无效");
  }
  return `/canvas/${encodeURIComponent(projectID.slice(CANVAS_PROJECT_ID_PREFIX.length))}`;
}

export function canvasProjectIDFromRoute(routeProjectID?: string) {
  return routeProjectID ? `${CANVAS_PROJECT_ID_PREFIX}${routeProjectID}` : undefined;
}
