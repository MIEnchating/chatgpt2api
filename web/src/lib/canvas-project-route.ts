const CANVAS_PROJECT_ID_PREFIX = "canvas-";

export function canvasProjectPath(projectID: string, agentSessionID?: string) {
  if (!projectID.startsWith(CANVAS_PROJECT_ID_PREFIX)) {
    throw new Error("画布项目 ID 格式无效");
  }
  const path = `/canvas/${encodeURIComponent(projectID.slice(CANVAS_PROJECT_ID_PREFIX.length))}`;
  return agentSessionID ? `${path}?${new URLSearchParams({ agent_session: agentSessionID })}` : path;
}

export function canvasProjectIDFromRoute(routeProjectID?: string) {
  return routeProjectID ? `${CANVAS_PROJECT_ID_PREFIX}${routeProjectID}` : undefined;
}
