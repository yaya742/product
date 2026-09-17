import type { GraphEdge, MapGraph, LngLat, LocationFix, LocationState, Bounds } from './map-v2';
export function metersBetween(a: LngLat, b: LngLat) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b[1] - a[1]) * r) / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function inBounds(p: LngLat, b: Bounds) {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}
export function abruptFixJump(f: LocationFix, previous?: LocationFix) {
  if (!previous || previous.source !== f.source) return false;
  const seconds = (f.timestamp - previous.timestamp) / 1000;
  return (
    seconds > 0 &&
    seconds < 15 &&
    metersBetween(f.coordinate, previous.coordinate) >
      Math.max(250, 4 * (f.accuracy + previous.accuracy) + 35 * seconds)
  );
}
export function classifyFix(
  f: LocationFix,
  bounds: Bounds,
  now = Date.now(),
  previous?: LocationFix,
): LocationState {
  if (
    f.crs !== 'EPSG:4326' ||
    !f.coordinate.every(Number.isFinite) ||
    Math.abs(f.coordinate[0]) > 180 ||
    Math.abs(f.coordinate[1]) > 90 ||
    !Number.isFinite(f.accuracy) ||
    f.accuracy <= 0 ||
    !Number.isFinite(f.timestamp) ||
    f.timestamp > now + 10000
  )
    return 'unavailable';
  if (now - f.timestamp > 120000) return 'stale';
  if (!inBounds(f.coordinate, bounds)) return 'outside';
  return f.accuracy > 65 || abruptFixJump(f, previous) ? 'approximate' : 'fresh';
}
class MinHeap {
  a: [number, string][] = [];
  push(x: [number, string]) {
    let i = this.a.push(x) - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p][0] <= x[0]) break;
      this.a[i] = this.a[p];
      i = p;
    }
    this.a[i] = x;
  }
  pop() {
    const first = this.a[0],
      last = this.a.pop();
    if (this.a.length && last) {
      let i = 0;
      while (i * 2 + 1 < this.a.length) {
        let c = i * 2 + 1;
        if (c + 1 < this.a.length && this.a[c + 1][0] < this.a[c][0]) c++;
        if (this.a[c][0] >= last[0]) break;
        this.a[i] = this.a[c];
        i = c;
      }
      this.a[i] = last;
    }
    return first;
  }
}
/** Multi-source / multi-target Dijkstra. No geometric intersection or nearest-node edges. */
export class WalkingGraph {
  nodes: Map<string, MapGraph['nodes'][number]>;
  adjacency = new Map<string, { to: string; edge: GraphEdge }[]>();
  edges: Map<string, GraphEdge>;
  constructor(readonly graph: MapGraph) {
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    this.edges = new Map(graph.edges.map((e) => [e.id, e]));
    for (const e of graph.edges) {
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to) || !Number.isFinite(e.meters) || e.meters <= 0)
        throw new Error('Invalid walking graph');
      this.adjacency.set(e.from, [...(this.adjacency.get(e.from) || []), { to: e.to, edge: e }]);
      if (!e.oneway) this.adjacency.set(e.to, [...(this.adjacency.get(e.to) || []), { to: e.from, edge: e }]);
    }
  }
  shortest(origins: string[], destinations: string[], avoidStairs = false) {
    const targets = new Set(destinations.filter((id) => this.nodes.has(id))),
      dist = new Map<string, number>(),
      prev = new Map<string, { id: string; edge: string }>(),
      heap = new MinHeap();
    for (const id of origins)
      if (this.nodes.has(id)) {
        dist.set(id, 0);
        heap.push([0, id]);
      }
    while (heap.a.length) {
      const [cost, id] = heap.pop();
      if (cost !== dist.get(id)) continue;
      if (targets.has(id)) {
        const nodeIds = [id],
          edgeIds: string[] = [];
        let at = id;
        while (prev.has(at)) {
          const p = prev.get(at)!;
          edgeIds.unshift(p.edge);
          nodeIds.unshift(p.id);
          at = p.id;
        }
        return {
          meters: cost,
          nodeIds,
          edgeIds,
          coordinates: nodeIds.map((n) => this.nodes.get(n)!.coordinate),
        };
      }
      for (const { to, edge } of this.adjacency.get(id) || []) {
        if (avoidStairs && edge.stairs) continue;
        const next = cost + edge.meters;
        if (next < (dist.get(to) ?? Infinity)) {
          dist.set(to, next);
          prev.set(to, { id, edge: edge.id });
          heap.push([next, to]);
        }
      }
    }
    return null;
  }
}
