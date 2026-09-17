/** V2 contract. Coordinates are always [longitude, latitude] in WGS84. */
export type LngLat = [number, number];
export type Bounds = [number, number, number, number];
export interface MapEntrance {
  id: string;
  name: string;
  coordinate: LngLat;
  connected: boolean;
  source: string;
}
export interface MapPoint {
  id: string;
  displayName: string;
  aliases: string[];
  kind: 'building' | 'area' | 'node' | 'landmark';
  coordinate: LngLat;
  bounds: Bounds;
  entrances: MapEntrance[];
  source: { url: string; version?: number; updatedAt?: string };
  geometryStatus: 'mapped';
}
export interface MapOverview {
  schemaVersion: 'campus-map/v2';
  version: string;
  sourceDate: string;
  acquiredAt: string;
  bounds: Bounds;
  campusBounds: Bounds;
  label: string;
  crs: 'EPSG:4326';
  coordinateOrder: string;
  renderProjection: 'EPSG:3857';
  distance: string;
  license: string;
  attribution: string;
  source: string;
  copyright: string;
  buildings: number;
  selectable: number;
  entrances: number;
  connectedEntrances: number;
  routableBuildings: number;
  nodes: number;
  edges: number;
  features: number;
  coreLandmarks?: number;
  rejected: Record<string, number>;
  limitations: string[];
  dataStatus?: 'ready' | 'partial' | 'error';
  dataError?: string;
}
export interface LocationFix {
  coordinate: LngLat;
  crs: 'EPSG:4326';
  timestamp: number;
  accuracy: number;
  source: 'windows-native' | 'browser-local' | 'phone-synced' | 'test';
  deviceLabel: string;
}
export type LocationState =
  'idle' | 'requesting' | 'fresh' | 'approximate' | 'stale' | 'denied' | 'unavailable' | 'outside';
export interface LocationStatusResult {
  status: LocationState;
  reason: string;
  source: string;
  fix?: LocationFix;
  phoneConnected: false;
}
export type MapEndpoint = { kind: 'place' | 'node'; id: string } | { kind: 'current'; fix?: LocationFix };
export interface MapRouteQuery {
  from?: MapEndpoint;
  to?: MapEndpoint;
  avoidStairs?: boolean;
  version?: string;
}
export interface GraphNode {
  id: string;
  coordinate: LngLat;
  entrance?: string;
  name?: string;
  barrier?: string;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  meters: number;
  way: string;
  name: string;
  stairs: boolean;
  bridge: boolean;
  gate: boolean;
  oneway: boolean;
}
export interface MapGraph {
  version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export type RouteStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'same'
  | 'missing_origin'
  | 'missing_destination'
  | 'unknown_entrance'
  | 'unreachable'
  | 'outside'
  | 'origin_confirmation'
  | 'error';
export interface MapRouteResult {
  schemaVersion: 'map-route/v2';
  status: RouteStatus;
  reason: string;
  from?: MapPoint;
  to?: MapPoint;
  originEntrance?: MapEntrance;
  destinationEntrance?: MapEntrance;
  coordinates: LngLat[];
  nodeIds: string[];
  edgeIds: string[];
  distance?: { totalM: number; networkM: number; connectorM: 0 };
  warnings: string[];
  source: { version: string; kind: 'osm'; date: string };
  elapsedMs?: number;
}
export interface MapCard {
  kind: 'route';
  route: MapRouteResult;
}
export function emptyRoute(reason = '选择一个地点，看看怎么走。'): MapRouteResult {
  return {
    schemaVersion: 'map-route/v2',
    status: 'idle',
    reason,
    coordinates: [],
    nodeIds: [],
    edgeIds: [],
    warnings: [],
    source: { version: '', kind: 'osm', date: '' },
  };
}
