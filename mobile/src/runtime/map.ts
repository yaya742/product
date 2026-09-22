export type MapCoordinate = [number, number];

export interface MapManifest {
  bounds: [number, number, number, number];
  campusBounds: [number, number, number, number];
  label: string;
  attribution: string;
  source: string;
  limitations: string[];
}

export interface MapPlace {
  id: string;
  displayName: string;
  aliases: string[];
  kind: string;
  coordinate: MapCoordinate;
  bounds?: [number, number, number, number];
}

export interface MapFeature {
  type: 'Feature';
  id?: string;
  properties?: { kind?: string; scope?: string; name?: string; [key: string]: unknown };
  geometry: {
    type: 'Polygon' | 'MultiPolygon' | 'LineString' | 'MultiLineString';
    coordinates: unknown;
  };
}

export interface MapGraphNode {
  id: string;
  coordinate: MapCoordinate;
}

export interface MapGraphEdge {
  id: string;
  from: string;
  to: string;
  meters: number;
  name?: string;
  stairs?: boolean;
  oneway?: boolean;
}

export interface MapData {
  manifest: MapManifest;
  features: MapFeature[];
  places: MapPlace[];
  nodes: MapGraphNode[];
  edges: MapGraphEdge[];
}

export interface MapRoute {
  coordinates: MapCoordinate[];
  meters: number;
}

function assertArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function isCoordinate(value: unknown): value is MapCoordinate {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function normalisePlace(value: unknown): MapPlace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.displayName !== 'string' || !isCoordinate(item.coordinate)) return undefined;
  const aliases = Array.isArray(item.aliases) ? item.aliases.filter((alias): alias is string => typeof alias === 'string') : [];
  const bounds = Array.isArray(item.bounds) && item.bounds.length === 4 && item.bounds.every((point) => typeof point === 'number')
    ? item.bounds as [number, number, number, number]
    : undefined;
  return {
    id: item.id,
    displayName: item.displayName,
    aliases,
    kind: typeof item.kind === 'string' ? item.kind : 'place',
    coordinate: [item.coordinate[0], item.coordinate[1]],
    bounds,
  };
}

function normaliseNode(value: unknown): MapGraphNode | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && isCoordinate(item.coordinate)
    ? { id: item.id, coordinate: [item.coordinate[0], item.coordinate[1]] }
    : undefined;
}

function normaliseEdge(value: unknown): MapGraphEdge | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.from === 'string' && typeof item.to === 'string' && typeof item.meters === 'number'
    ? {
      id: item.id,
      from: item.from,
      to: item.to,
      meters: item.meters,
      name: typeof item.name === 'string' ? item.name : undefined,
      stairs: item.stairs === true,
      oneway: item.oneway === true,
    }
    : undefined;
}

async function loadJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`./map-v2/${path}`, { signal });
  if (!response.ok) throw new Error(`地图数据加载失败（${response.status}）`);
  return response.json() as Promise<T>;
}

export async function loadMapData(signal?: AbortSignal): Promise<MapData> {
  const [manifest, geography, places, network] = await Promise.all([
    loadJson<MapManifest>('manifest.json', signal),
    loadJson<{ type: string; features: unknown[] }>('geography.geojson', signal),
    loadJson<unknown>('places.json', signal),
    loadJson<{ nodes: unknown[]; edges: unknown[] }>('network.json', signal),
  ]);
  const features = assertArray(geography.features, '地图几何数据格式错误').filter((item): item is MapFeature => {
    if (!item || typeof item !== 'object') return false;
    const feature = item as MapFeature;
    return feature.type === 'Feature' && !!feature.geometry;
  });
  const placeValues = Array.isArray(places) ? places : (places && typeof places === 'object' && Array.isArray((places as { places?: unknown[] }).places) ? (places as { places: unknown[] }).places : []);
  return {
    manifest,
    features,
    places: placeValues.map(normalisePlace).filter((item): item is MapPlace => !!item),
    nodes: assertArray(network.nodes, '地图路网节点格式错误').map(normaliseNode).filter((item): item is MapGraphNode => !!item),
    edges: assertArray(network.edges, '地图路网边格式错误').map(normaliseEdge).filter((item): item is MapGraphEdge => !!item),
  };
}

function metersBetween(a: MapCoordinate, b: MapCoordinate): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * rad) / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

class MinHeap {
  private values: Array<[number, string]> = [];

  get length() { return this.values.length; }

  push(value: [number, string]) {
    let index = this.values.push(value) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.values[parent][0] <= value[0]) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): [number, string] | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length && last) {
      let index = 0;
      while (index * 2 + 1 < this.values.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.values.length && this.values[child + 1][0] < this.values[child][0]) child++;
        if (this.values[child][0] >= last[0]) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return first;
  }
}

export function findWalkingRoute(data: Pick<MapData, 'nodes' | 'edges'>, origin: MapCoordinate, destination: MapCoordinate): MapRoute | undefined {
  if (!data.nodes.length || !data.edges.length) return undefined;
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Array<{ to: string; edge: MapGraphEdge }>>();
  for (const edge of data.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || !Number.isFinite(edge.meters) || edge.meters <= 0) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) || []), { to: edge.to, edge }]);
    if (!edge.oneway) adjacency.set(edge.to, [...(adjacency.get(edge.to) || []), { to: edge.from, edge }]);
  }
  const nearest = (coordinate: MapCoordinate) => data.nodes.reduce((best, node) => (
    metersBetween(coordinate, node.coordinate) < metersBetween(coordinate, best.coordinate) ? node : best
  ));
  const source = nearest(origin).id;
  const target = nearest(destination).id;
  const distances = new Map<string, number>([[source, 0]]);
  const previous = new Map<string, string>();
  const heap = new MinHeap();
  heap.push([0, source]);
  while (heap.length) {
    const current = heap.pop();
    if (!current) break;
    const [cost, id] = current;
    if (cost !== distances.get(id)) continue;
    if (id === target) break;
    for (const next of adjacency.get(id) || []) {
      const nextCost = cost + next.edge.meters;
      if (nextCost < (distances.get(next.to) ?? Infinity)) {
        distances.set(next.to, nextCost);
        previous.set(next.to, id);
        heap.push([nextCost, next.to]);
      }
    }
  }
  const total = distances.get(target);
  if (total === undefined) return undefined;
  const ids = [target];
  while (ids[0] !== source) {
    const parent = previous.get(ids[0]);
    if (!parent) return undefined;
    ids.unshift(parent);
  }
  return { coordinates: ids.map((id) => nodes.get(id)!.coordinate), meters: total };
}
