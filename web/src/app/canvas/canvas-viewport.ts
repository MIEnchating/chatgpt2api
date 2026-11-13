export type CanvasViewport = { zoom: number; x: number; y: number };

type CanvasConnectionLike = { from_node_id: string; to_node_id: string };
type CanvasConnectionBounds = { left: number; top: number; right: number; bottom: number };
type CanvasNodeGeometry = { x: number; y: number; width: number; height: number };

export type CanvasConnectionIndex = {
  cellSize: number;
  cells: Map<string, number[]>;
  spanning: Set<number>;
  bounds: Array<CanvasConnectionBounds | undefined>;
  connectionCells: string[][];
  connectionsByNode: Map<string, number[]>;
  geometryByNode: Map<string, { x: number; y: number; width: number; height: number }>;
  connections: readonly CanvasConnectionLike[];
  nodesSnapshot?: readonly object[];
};

export const CANVAS_MIN_ZOOM = 0.05;
export const CANVAS_MAX_ZOOM = 8;

export function clampCanvasZoom(value: number) {
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, value));
}

export function resetCanvasViewport(canvasSize: { width: number; height: number }): CanvasViewport {
  return {
    zoom: 1,
    x: canvasSize.width / 2,
    y: canvasSize.height / 2,
  };
}

export function setCanvasViewportZoom(
  viewport: CanvasViewport,
  canvasSize: { width: number; height: number },
  value: number,
): CanvasViewport {
  const zoom = clampCanvasZoom(value);
  const centerX = canvasSize.width / 2;
  const centerY = canvasSize.height / 2;
  return {
    zoom,
    x: centerX - ((centerX - viewport.x) / viewport.zoom) * zoom,
    y: centerY - ((centerY - viewport.y) / viewport.zoom) * zoom,
  };
}

export function zoomCanvasViewport(viewport: CanvasViewport, localPoint: { x: number; y: number }, deltaY: number): CanvasViewport {
  const factor = Math.pow(1.1, -deltaY / 100);
  const zoom = clampCanvasZoom(viewport.zoom * factor);
  const worldX = (localPoint.x - viewport.x) / viewport.zoom;
  const worldY = (localPoint.y - viewport.y) / viewport.zoom;
  return {
    zoom,
    x: localPoint.x - worldX * zoom,
    y: localPoint.y - worldY * zoom,
  };
}

export function canvasGridMetrics(viewport: CanvasViewport) {
  let size = 48 * viewport.zoom;
  // Skip grid subdivisions when zoomed out to keep the canvas legible.
  while (size > 0 && size < 16) size *= 2;
  return {
    size,
    x: viewport.x % size,
    y: viewport.y % size,
    dotSize: viewport.zoom < 0.12 ? 0.8 : 1.15,
  };
}

export function canvasNodesInViewport<T extends { x: number; y: number; width: number; height: number }>(
  nodes: readonly T[],
  viewport: CanvasViewport,
  canvasSize: { width: number; height: number },
  padding = 280,
) {
  const zoom = Math.max(CANVAS_MIN_ZOOM, viewport.zoom);
  const viewLeft = -viewport.x / zoom - padding;
  const viewTop = -viewport.y / zoom - padding;
  const viewRight = viewLeft + canvasSize.width / zoom + padding * 2;
  const viewBottom = viewTop + canvasSize.height / zoom + padding * 2;
  return nodes.filter((node) => (
    node.x + node.width > viewLeft
    && node.x < viewRight
    && node.y + node.height > viewTop
    && node.y < viewBottom
  ));
}

export function canvasConnectionBounds(start: { x: number; y: number }, end: { x: number; y: number }): CanvasConnectionBounds {
  const curvature = Math.max(Math.abs(end.x - start.x) * 0.5, 50);
  return {
    left: Math.min(start.x, end.x - curvature),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x + curvature, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

function connectionCellKey(x: number, y: number) {
  return `${x}:${y}`;
}

export function buildCanvasConnectionIndex(
  connections: readonly CanvasConnectionLike[],
  nodeByID: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
  cellSize = 1024,
): CanvasConnectionIndex {
  const cells = new Map<string, number[]>();
  const spanning = new Set<number>();
  const bounds: Array<CanvasConnectionBounds | undefined> = [];
  const connectionCells: string[][] = [];
  const connectionsByNode = new Map<string, number[]>();
  const geometryByNode = new Map([...nodeByID].map(([id, node]) => [id, { x: node.x, y: node.y, width: node.width, height: node.height }]));
  const connectionIndex = { cellSize, cells, spanning, bounds, connectionCells, connectionsByNode, geometryByNode, connections };
  for (let position = 0; position < connections.length; position += 1) {
    const connection = connections[position];
    for (const nodeID of new Set([connection.from_node_id, connection.to_node_id])) {
      const values = connectionsByNode.get(nodeID);
      if (values) values.push(position);
      else connectionsByNode.set(nodeID, [position]);
    }
    addCanvasConnectionToIndex(connectionIndex, position, connection, nodeByID);
  }
  return connectionIndex;
}

function addCanvasConnectionToIndex(index: CanvasConnectionIndex, connectionIndex: number, connection: CanvasConnectionLike, nodeByID: ReadonlyMap<string, CanvasNodeGeometry>) {
    const from = nodeByID.get(connection.from_node_id);
    const to = nodeByID.get(connection.to_node_id);
    if (!from || !to) {
      index.bounds[connectionIndex] = undefined;
      index.connectionCells[connectionIndex] = [];
      return;
    }
    const next = canvasConnectionBounds(
      { x: from.x + from.width, y: from.y + from.height / 2 },
      { x: to.x, y: to.y + to.height / 2 },
    );
    index.bounds[connectionIndex] = next;
    const minX = Math.floor(next.left / index.cellSize);
    const maxX = Math.floor(next.right / index.cellSize);
    const minY = Math.floor(next.top / index.cellSize);
    const maxY = Math.floor(next.bottom / index.cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 64) {
      index.spanning.add(connectionIndex);
      index.connectionCells[connectionIndex] = [];
      return;
    }
    const keys: string[] = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = connectionCellKey(x, y);
        const values = index.cells.get(key);
        if (values) {
          let position = values.length;
          while (position > 0 && values[position - 1] > connectionIndex) position -= 1;
          values.splice(position, 0, connectionIndex);
        }
        else index.cells.set(key, [connectionIndex]);
        keys.push(key);
      }
    }
    index.connectionCells[connectionIndex] = keys;
}

export function canvasConnectionIndexMatchesGeometry(index: CanvasConnectionIndex, nodeByID: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>) {
  if (index.geometryByNode.size !== nodeByID.size) return false;
  for (const [id, node] of nodeByID) {
    const previous = index.geometryByNode.get(id);
    if (!previous || previous.x !== node.x || previous.y !== node.y || previous.width !== node.width || previous.height !== node.height) return false;
  }
  return true;
}

export function updateCanvasConnectionIndex(
  index: CanvasConnectionIndex,
  nodeByID: ReadonlyMap<string, CanvasNodeGeometry>,
  knownChangedNodeIDs?: Iterable<string>,
) {
  const changedGeometry = new Map<string, CanvasNodeGeometry | undefined>();
  if (!knownChangedNodeIDs) {
    for (const [id, node] of nodeByID) {
      const previous = index.geometryByNode.get(id);
      if (!previous || previous.x !== node.x || previous.y !== node.y || previous.width !== node.width || previous.height !== node.height) changedGeometry.set(id, node);
    }
    for (const id of index.geometryByNode.keys()) if (!nodeByID.has(id)) changedGeometry.set(id, undefined);
  } else {
    for (const id of knownChangedNodeIDs) changedGeometry.set(id, nodeByID.get(id));
  }
  return updateCanvasConnectionGeometry(index, changedGeometry);
}

export function updateCanvasConnectionGeometry(index: CanvasConnectionIndex, changedGeometry: ReadonlyMap<string, CanvasNodeGeometry | undefined>, nodesSnapshot?: readonly object[]) {
  if (!changedGeometry.size) return index;
  const actualChanges = new Map<string, CanvasNodeGeometry | undefined>();
  for (const [id, geometry] of changedGeometry) {
    const previous = index.geometryByNode.get(id);
    if (geometry ? !previous || previous.x !== geometry.x || previous.y !== geometry.y || previous.width !== geometry.width || previous.height !== geometry.height : Boolean(previous)) actualChanges.set(id, geometry);
  }
  if (!actualChanges.size) {
    if (nodesSnapshot) index.nodesSnapshot = nodesSnapshot;
    return index;
  }
  const changedConnections = new Set<number>();
  for (const id of actualChanges.keys()) for (const connectionIndex of index.connectionsByNode.get(id) || []) changedConnections.add(connectionIndex);
  for (const connectionIndex of changedConnections) {
    for (const key of index.connectionCells[connectionIndex] || []) {
      const values = index.cells.get(key);
      if (!values) continue;
      const position = values.indexOf(connectionIndex);
      if (position >= 0) values.splice(position, 1);
      if (!values.length) index.cells.delete(key);
    }
    index.spanning.delete(connectionIndex);
  }
  for (const [id, geometry] of actualChanges) {
    if (geometry) index.geometryByNode.set(id, { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height });
    else index.geometryByNode.delete(id);
  }
  for (const connectionIndex of changedConnections) addCanvasConnectionToIndex(index, connectionIndex, index.connections[connectionIndex], index.geometryByNode);
  if (nodesSnapshot) index.nodesSnapshot = nodesSnapshot;
  return index;
}

export function canvasConnectionsInViewport(
  index: CanvasConnectionIndex,
  viewport: CanvasViewport,
  size: { width: number; height: number },
  padding = 40,
) {
  const zoom = Math.max(CANVAS_MIN_ZOOM, viewport.zoom);
  const left = -viewport.x / zoom - padding;
  const top = -viewport.y / zoom - padding;
  const right = left + size.width / zoom + padding * 2;
  const bottom = top + size.height / zoom + padding * 2;
  const minX = Math.floor(left / index.cellSize);
  const maxX = Math.floor(right / index.cellSize);
  const minY = Math.floor(top / index.cellSize);
  const maxY = Math.floor(bottom / index.cellSize);
  const candidates = new Set<number>(index.spanning);
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      for (const candidate of index.cells.get(connectionCellKey(x, y)) || []) candidates.add(candidate);
    }
  }
  return [...candidates].filter((candidate) => {
    const bounds = index.bounds[candidate];
    return bounds && bounds.right > left && bounds.left < right && bounds.bottom > top && bounds.top < bottom;
  }).sort((a, b) => a - b);
}

export function canvasConnectionInViewport(start: { x: number; y: number }, end: { x: number; y: number }, viewport: CanvasViewport, size: { width: number; height: number }) {
  const bounds = canvasConnectionBounds(start, end);
  // The cubic curve lies within its control-point bounds, including links whose endpoints are offscreen.
  return canvasNodesInViewport([{ x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }], viewport, size, 40).length > 0;
}
