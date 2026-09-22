import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  emptyRoute,
  type MapOverview,
  type MapPoint,
  type MapGraph,
  type MapRouteQuery,
  type MapRouteResult,
  type MapEndpoint,
  type LocationStatusResult,
} from '../shared/map-v2';
import { WalkingGraph } from '../shared/map-routing';
export class CampusMapAdapter {
  private manifest: MapOverview;
  private points: MapPoint[];
  private byId: Map<string, MapPoint>;
  readonly walking: WalkingGraph;
  private cache = new Map<string, MapRouteResult>();
  constructor(directory: string) {
    const read = (name: string) => JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
    this.points = [];
    this.manifest = {
      schemaVersion: 'campus-map/v2',
      version: 'unavailable',
      sourceDate: '',
      acquiredAt: '',
      bounds: [120.06, 30.293, 120.101, 30.326],
      campusBounds: [120.063, 30.296, 120.088, 30.319],
      label: '紫金港 · 望月公寓（桂花苑）',
      crs: 'EPSG:4326',
      coordinateOrder: 'longitude, latitude',
      renderProjection: 'EPSG:3857',
      distance: 'meters',
      license: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors',
      source: 'https://www.openstreetmap.org',
      copyright: 'https://www.openstreetmap.org/copyright',
      buildings: 0,
      selectable: 0,
      entrances: 0,
      connectedEntrances: 0,
      routableBuildings: 0,
      nodes: 0,
      edges: 0,
      features: 0,
      rejected: {},
      limitations: [],
    };
    let walking: WalkingGraph | undefined;
    try {
      const manifest: MapOverview = read('manifest.json');
      if (manifest.schemaVersion !== 'campus-map/v2') throw new Error('incompatible');
      this.manifest = { ...manifest, dataStatus: 'ready' };
      this.points = read('places.json');
      if (
        !Array.isArray(this.points) ||
        this.points.some(
          (p) =>
            !p ||
            typeof p.id !== 'string' ||
            typeof p.displayName !== 'string' ||
            !Array.isArray(p.coordinate) ||
            p.coordinate.length !== 2 ||
            !p.coordinate.every(Number.isFinite) ||
            !Array.isArray(p.bounds) ||
            p.bounds.length !== 4 ||
            !p.bounds.every(Number.isFinite) ||
            !Array.isArray(p.entrances),
        )
      ) {
        this.points = [];
        throw new Error('places');
      }
      const graph: MapGraph = read('network.json');
      if (graph.version !== this.manifest.version) throw new Error('version');
      walking = new WalkingGraph(graph);
    } catch {
      this.manifest = {
        ...this.manifest,
        dataStatus: this.points.length ? 'partial' : 'error',
        dataError: '地图路网文件未能完整载入。已载入的地图仍可浏览，对话功能不受影响。',
      };
    }
    this.byId = new Map(this.points.map((p) => [p.id, p]));
    this.walking = walking || new WalkingGraph({ version: this.manifest.version, nodes: [], edges: [] });
  }
  overview() {
    return this.manifest;
  }
  search(query: string, limit = 20) {
    const q = query.trim().toLocaleLowerCase().replace(/\s/g, '');
    return this.points
      .map((p) => ({
        p,
        names: [p.displayName, ...p.aliases].map((n) => n.toLocaleLowerCase().replace(/\s/g, '')),
      }))
      .filter(({ names }) => names.some((n) => n.includes(q)))
      .sort(
        (a, b) =>
          Number(b.names.includes(q)) - Number(a.names.includes(q)) ||
          a.p.displayName.localeCompare(b.p.displayName, 'zh-CN'),
      )
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((x) => x.p);
  }
  locationStatus(): LocationStatusResult {
    return {
      status: 'idle',
      source: 'windows-native',
      phoneConnected: false,
      reason: '可在地图中读取 Windows 本机位置；模型工具不读取或保存坐标，也可以手动选择起点。',
    };
  }
  private resolve(e?: MapEndpoint): MapPoint | undefined {
    if (e?.kind === 'place') return this.byId.get(e.id);
    if (e?.kind === 'node') {
      const n = this.walking.nodes.get(e.id);
      if (!n) return;
      return {
        id: `node/${n.id}`,
        displayName: n.name || '已确认的道路点',
        aliases: [],
        kind: 'node',
        coordinate: n.coordinate,
        bounds: [...n.coordinate, ...n.coordinate],
        entrances: [
          {
            id: n.id,
            name: n.name || '道路点',
            coordinate: n.coordinate,
            connected: true,
            source: `https://www.openstreetmap.org/node/${n.id}`,
          },
        ],
        source: { url: `https://www.openstreetmap.org/node/${n.id}` },
        geometryStatus: 'mapped',
      };
    }
  }
  route(query: MapRouteQuery): MapRouteResult {
    const start = performance.now(),
      from = this.resolve(query.from),
      to = this.resolve(query.to);
    const base: MapRouteResult = {
      ...emptyRoute(),
      from,
      to,
      source: { version: this.manifest.version, kind: 'osm', date: this.manifest.sourceDate },
    };
    const fail = (status: MapRouteResult['status'], reason: string) => ({
      ...base,
      status,
      reason,
      elapsedMs: performance.now() - start,
    });
    if (this.manifest.dataStatus !== 'ready') return fail('error', this.manifest.dataError || '路网未载入。');
    if (query.version && query.version !== this.manifest.version)
      return fail('error', '地图数据已更新，请重新选择起终点。');
    if (!query.to) return fail('missing_destination', '请选择目的地。');
    if (!to) return fail('outside', '这个地点不在当前地图的数据范围内。');
    if (!query.from) return fail('missing_origin', '请选择起点，或开启本机定位。');
    if (query.from.kind === 'current')
      return fail(
        'origin_confirmation',
        '位置已显示；尚未确认你到路网的步行连接，请选择你实际所在、且有已知入口的建筑作为起点。',
      );
    if (!from) return fail('outside', '起点不在当前地图的数据范围内。');
    if (from.id === to.id) return fail('same', '起点与终点是同一地点，无需绘制路线。');
    const a = from.entrances.filter((e) => e.connected),
      b = to.entrances.filter((e) => e.connected);
    if (!a.length || !b.length)
      return fail(
        'unknown_entrance',
        `${!a.length ? from.displayName : to.displayName}的可通行入口尚未完整记录。可以浏览和选择，暂不能给出到楼路线。`,
      );
    const key = JSON.stringify([this.manifest.version, from.id, to.id, !!query.avoidStairs]);
    const cached = this.cache.get(key);
    if (cached) return structuredClone(cached);
    const found = this.walking.shortest(
      a.map((e) => e.id),
      b.map((e) => e.id),
      query.avoidStairs,
    );
    if (!found) return fail('unreachable', '已知路网中没有连通的步行路线；没有用直线替代缺失路段。');
    const used = found.edgeIds.map((id) => this.walking.edges.get(id)!);
    const warnings = ['按已记录且允许步行的路段长度计算；门禁、施工和实时通行请以现场为准。'];
    if (used.some((e) => e.stairs)) warnings.push('路线包含台阶。');
    if (used.some((e) => e.gate)) warnings.push('路线经过出入口，通行状态未实时核实。');
    const result: MapRouteResult = {
      ...base,
      status: 'ready',
      reason: '已知路网内的最短步行路线',
      coordinates: found.coordinates,
      nodeIds: found.nodeIds,
      edgeIds: found.edgeIds,
      distance: { totalM: found.meters, networkM: found.meters, connectorM: 0 },
      originEntrance: a.find((e) => e.id === found.nodeIds[0]),
      destinationEntrance: b.find((e) => e.id === found.nodeIds.at(-1)),
      warnings,
      elapsedMs: performance.now() - start,
    };
    this.cache.set(key, result);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return structuredClone(result);
  }
}
