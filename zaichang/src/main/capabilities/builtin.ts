import { z } from 'zod';
import type { CampusMapAdapter } from '../mapService';
import { CAMPUS_ACCOUNT_SOURCE_ID, type ZjuAdapter, type CampusDomain } from '../zjuAdapter';
import type { DomainService } from '../storage/domains';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel } from '../runtime/policy';
import type { CapabilityBroker, CapabilityDefinition, CapabilityProvider, CapabilityResult } from './broker';
import { HarnessError, type KnowledgeStatus } from '../../shared/harness';
import { calendarFieldsSchema, localCalendarChangeSchema } from '../../shared/calendar';
import { expandAgenda } from '../actions/calendar';
import type { LocationStatusResult, MapOverview } from '../../shared/map-v2';

export interface BuiltinConnections {
  map?: CampusMapAdapter;
  campus?: ZjuAdapter;
  location?: {
    read(manifest: MapOverview): Promise<LocationStatusResult>;
  };
}
const jsonObject = z.record(z.string(), z.json());
const campusDomains = [
  'schedule',
  'courses',
  'learning_courses',
  'exams',
  'assignments',
  'grades',
  'gpa',
  'gpa_semesters',
  'gpa_cumulative',
  'retakes',
  'practice',
  'projects',
  'activities',
  'sports',
  'reservations',
  'reservation_violations',
  'card',
  'transactions',
  'profile',
  'roles',
  'calendar_pending',
  'cancelled_classes',
  'holidays',
  'notices',
  'source_status',
  'places',
  'rules',
] as const;
export const campusInput = z
  .object({
    domain: z.enum(campusDomains),
    courseId: z.string().regex(/^\d{1,32}$/).optional(),
    academicYear: z.string().regex(/^20\d{2}-20\d{2}$/).optional(),
    term: z.enum(['1', '2']).optional(),
    query: z.string().max(100).optional(),
    page: z.number().int().min(1).max(50).optional(),
    detail: z.boolean().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    at: z.string().datetime({ offset: true }).optional(),
    timeMode: z.enum(['overlap', 'starts', 'contained']).optional(),
    fields: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/))
      .max(24)
      .optional(),
    filters: z.array(z.string().max(160)).max(6).optional(),
    sort: z.string().max(100).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
    window: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(50).default(12),
    refresh: z.boolean().default(false),
  })
  .strict();
const campusOverviewInput = z
  .object({
    refresh: z.boolean().default(false),
    includeSensitiveDomains: z.boolean().default(false),
    academicYear: z.string().regex(/^20\d{2}-20\d{2}$/).optional(),
    term: z.enum(['1', '2']).optional(),
  })
  .strict();
const campusAccountOutput = z
  .object({
    domain: z.string(),
    records: z.array(jsonObject),
    conflicts: z.array(jsonObject).optional(),
    source: z.string(),
    institutionId: z.string(),
    termId: z.string(),
    live: z.boolean(),
    origin: z.enum(['zju_account', 'zju_public']),
    authenticated: z.boolean(),
    total: z.number().int().nonnegative().optional(),
    cached: z.boolean(),
    snapshotAt: z.string().optional(),
  })
  .strict();
const campusImportOutput = z
  .object({
    domain: z.string(),
    records: z.array(jsonObject),
    conflicts: z.array(jsonObject).optional(),
    source: z.string(),
    institutionId: z.string(),
    termId: z.string(),
    live: z.literal(false),
    origin: z.literal('legacy_import'),
    authenticated: z.literal(false),
    total: z.number().int().nonnegative().optional(),
    cached: z.literal(true),
    snapshotAt: z.string().optional(),
  })
  .strict();
export const localActionInput = z
  .object({
    ...calendarFieldsSchema.shape,
    title: z.string().min(1).max(160),
    detail: z.string().max(1500),
    startsAt: z.string().datetime({ offset: true }).optional(),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
    demo: z.boolean().optional(),
  })
  .strict();
const base = (
  name: string,
  input: z.ZodType,
  output: z.ZodType,
  requiredScopes: string[],
  extra: Partial<CapabilityDefinition> = {},
): CapabilityDefinition => ({
  name,
  version: '1',
  input,
  output,
  effect: 'read',
  requiredScopes,
  subjects: ['self'],
  worlds: ['real', 'scenario'],
  timeoutMs: 15000,
  maxBytes: 80000,
  supportsIdempotency: false,
  supportsInspect: false,
  supportsCancel: false,
  ...extra,
});
const manifest = (
  id: string,
  sourceId: string,
  capabilities: CapabilityDefinition[],
  egressHosts: string[] = [],
  metadata: Pick<CapabilityProvider['manifest'], 'displayName' | 'description'> = {},
): CapabilityProvider['manifest'] => ({
  id,
  sourceId,
  version: '1',
  ...metadata,
  capabilities,
  egressHosts,
  platforms: ['*'],
  simulated: false,
  trust: 'bundled_reviewed',
  offline: 'read_cache',
  license: 'project-owned adapter; underlying sources retain original licenses',
});
function statusOf(value: any): KnowledgeStatus {
  if (value?.stale || value?.freshness?.stale) return 'stale';
  if (value?.status === 'forbidden' || value?.status === 'auth_required') return 'forbidden';
  if (value?.status === 'unavailable' || value?.status === 'unsupported') return 'unsupported';
  if (value?.status === 'error' || value?.status === 'failed') return 'failed';
  if (value?.status === 'conflict') return 'conflict';
  if (
    value?.status === 'partial' ||
    value?.coverage?.complete === false ||
    value?.completeness?.complete === false
  )
    return 'unknown';
  return ['ok', 'fresh'].includes(String(value?.status))
    ? 'fresh'
    : value?.status === 'not_found'
      ? 'not_found'
      : 'unknown';
}
function sourceObservationAt(value: any): string | undefined {
  const mapped = value?.coverage?.source_fetched_at;
  const candidates = [
    value?.fetched_at,
    value?.collected_at,
    ...(mapped && typeof mapped === 'object' ? Object.values(mapped) : []),
  ]
    .filter((item): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return candidates[0];
}
function safeRecord(value: unknown, depth = 0): any {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => safeRecord(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(?:password|secret|token|ticket|cookie|authorization|credential|raw_response|data_path|body_b64|email|phone|mobile|account|sno|xh|yhm|xm|zgh|custid|custmemberid|acctid|cardid|bankacc|cert|schcode|yktschoolcode)$/i.test(key) &&
            !/(身份证|学号|手机号|邮箱)/.test(key),
        )
        .map(([k, v]) => [k, safeRecord(v, depth + 1)]),
    );
  return typeof value === 'string' ? value.slice(0, 4000) : value;
}

const sensitiveCampusGrant: Partial<Record<(typeof campusDomains)[number], string>> = {
  grades: 'campus:grades:read',
  gpa: 'campus:gpa:read',
  gpa_semesters: 'campus:gpa:read',
  gpa_cumulative: 'campus:gpa:read',
  retakes: 'campus:grades:read',
  reservations: 'campus:reservations:read',
  reservation_violations: 'campus:reservations:read',
  card: 'campus:card:read',
  transactions: 'campus:transactions:read',
  profile: 'campus:profile:read',
  roles: 'campus:profile:read',
};
export function registerBuiltins(
  broker: CapabilityBroker,
  policy: PolicyKernel,
  repo: KernelRepository,
  domains: DomainService,
  connections: BuiltinConnections,
) {
  const register = (provider: CapabilityProvider) =>
    broker.register(provider, { reviewed: true, source: 'bundled source review' });
  register({
    manifest: manifest('local-agenda', 'local-agenda', [
      base('local.agenda.change', localCalendarChangeSchema, z.object({}).strict(), ['local:write'], { displayName: '更改本地安排', effect: 'local_write', worlds: ['real'], supportsIdempotency: true, supportsInspect: true, supportsCancel: true, description: '按对象版本修改、删除本地安排或更改单个重复实例；事务执行并支持受版本保护的撤销。' }),
      base('local.agenda.save', localActionInput, z.object({}).strict(), ['local:write'], {
        displayName: '保存本地安排',
        effect: 'local_write',
        worlds: ['real'],
        supportsIdempotency: true,
        supportsInspect: true,
        supportsCancel: true,
      }),
      base(
        'local.agenda.read',
        z.object({ query: z.string().max(100).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), timeZone: z.string().max(100).optional() }).strict(),
        z.object({ items: z.array(jsonObject), issues: z.array(jsonObject).optional() }).strict(),
        ['evidence:read'],
        { displayName: '读取本地安排' },
      ),
    ], [], { displayName: '本地安排', description: '读取和管理保存在本机的安排与行动回执。' }),
    invoke: (name, args, ctx) => {
      if (name === 'local.agenda.save' || name === 'local.agenda.change')
        throw new HarnessError('transaction_required', '本地安排必须由受控事务提交。');
      policy.validate(ctx.scope);
      const items = repo.db
        .prepare('SELECT payload FROM agenda')
        .all()
        .map((r) => JSON.parse(String(r.payload)))
        .filter((a) => !a.done && (!args.query || a.title.includes(args.query)));
      if (args.from || args.to) {
        if (!args.from || !args.to) throw new HarnessError('time_window', '按时间查询需要明确起止范围。');
        const expanded = expandAgenda(items, args.from, args.to, args.timeZone || 'Asia/Shanghai');
        return { status: expanded.status, sourceId: 'local-agenda', data: { items: expanded.items, issues: expanded.issues }, coverage: { complete: expanded.coverage.complete, scope: `dated occurrences from ${args.from} to ${args.to}; undated tasks excluded` }, fetchedAt: repo.clock.now(), simulated: false };
      }
      return {
        status: items.length ? 'fresh' : 'known_absent',
        sourceId: 'local-agenda',
        data: { items },
        coverage: { complete: true, scope: 'unfinished local agenda' },
        fetchedAt: repo.clock.now(),
        simulated: false,
      };
    },
  });
  register({
    manifest: manifest('campus-read', CAMPUS_ACCOUNT_SOURCE_ID, [
      base(
        'campus.lookup',
        campusInput,
        campusAccountOutput,
        ['campus:read'],
        { displayName: '查询校园资料', timeoutMs: 90000 },
      ),
      base('campus.overview', campusOverviewInput, jsonObject, ['campus:read'], {
        displayName: '查看校园资料总览',
        timeoutMs: 90000,
        maxBytes: 140000,
      }),
    ], [], { displayName: '校园账号（本机兼容连接）', description: '按需读取已连接的浙大校园资料；不是浙大官方授权接口。' }),
    connectionStatus: () => {
      const status = connections.campus?.describe();
      return { connected: !!status?.available && status.credentialsConfigured !== false, reason: status?.reason || '尚未连接校园账号', entry: '连接与偏好 → 校园资料' };
    },
    invoke: async (name, args, ctx) => {
      const sourceId = CAMPUS_ACCOUNT_SOURCE_ID;
      const connector = connections.campus?.describe();
      if (!connections.campus || !connector?.available)
        return {
          status: 'not_connected',
          sourceId,
          reason: connector?.reason || '还没有连接浙大校园账号。',
          simulated: false,
        };
      if (connector.credentialsConfigured === false && !(name === 'campus.lookup' && ['holidays', 'notices'].includes(args.domain)))
        return {
          status: 'forbidden',
          sourceId,
          reason: '请先在校园资料中登录浙大账号。',
          simulated: false,
        };
      if (name === 'campus.overview') {
        if (args.includeSensitiveDomains) {
          for (const grant of [
            'campus:grades:read',
            'campus:gpa:read',
            'campus:reservations:read',
            'campus:card:read',
            'campus:transactions:read',
            'campus:profile:read',
          ]) policy.require(ctx.scope, grant);
        }
        const result = await connections.campus.fullContext(
          {
            refresh: args.refresh,
            includeSensitiveDomains: args.includeSensitiveDomains,
            academicYear: args.academicYear,
            term: args.term,
          },
          ctx.signal,
        );
        policy.validate(ctx.scope);
        const batches = Array.isArray(result?.batches) ? result.batches : [];
        const domains = batches
          .filter((batch: any) => batch.scope !== 'academic')
          .map((batch: any) => {
            const data = batch.data || {};
            return {
              domain: String(batch.scope),
              status: String(data.status || 'unknown'),
              total: typeof data.total_matches === 'number' ? data.total_matches : undefined,
              records: (Array.isArray(data.records) ? data.records : [])
                .slice(0, 4)
                .map((record: any) => safeRecord(record)),
              fetchedAt: sourceObservationAt(data),
              complete: data.coverage?.complete === true || data.completeness?.complete === true,
              issues: Array.isArray(data.coverage?.issues) ? data.coverage.issues.slice(0, 8) : undefined,
            };
          });
        const overviewSnapshotAt = domains
          .map((domain: any) => domain.fetchedAt)
          .filter((item: unknown): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item)))
          .sort((a: string, b: string) => Date.parse(a) - Date.parse(b))[0];
        return {
          status: statusOf(result),
          sourceId,
          data: JSON.parse(
            JSON.stringify(
              safeRecord({
                origin: 'zju_account',
                authenticated: connector.authStatus === 'verified' || !!result?.authenticatedAt,
                refreshed: Boolean(result?.refreshed),
                snapshotAt: overviewSnapshotAt,
                domains,
                missingDomains: result?.missingScopes || [],
                incompleteDomains: result?.incompleteScopes || [],
                source: '浙大本人账号（本机兼容连接）',
              }),
            ),
          ),
          fetchedAt: overviewSnapshotAt,
          expiresAt: overviewSnapshotAt
            ? new Date(Date.parse(overviewSnapshotAt) + 300000).toISOString()
            : undefined,
          coverage: {
            complete: result?.status === 'ok',
            scope: args.includeSensitiveDomains ? 'all supported account domains' : 'supported non-sensitive account domains',
          },
          reason: result?.reason,
          simulated: false,
        };
      }
      const grant = sensitiveCampusGrant[args.domain as (typeof campusDomains)[number]];
      if (grant) policy.require(ctx.scope, grant);
      if (!['places', 'rules'].includes(args.domain)) {
        const wrapped = (await connections.campus!.read(
          {
            domain: args.domain as CampusDomain,
            courseId: args.courseId,
            academicYear: args.academicYear,
            term: args.term,
            query: args.query,
            page: args.page,
            detail: args.detail,
            from: args.from,
            to: args.to,
            at: args.at,
            timeMode: args.timeMode,
            fields: args.fields,
            filters: args.filters,
            sort: args.sort,
            offset: args.offset,
            window: args.window,
            limit: args.limit,
            refresh: args.refresh,
          },
          ctx.signal,
        )) as any;
        const result = wrapped?.data && typeof wrapped.data === 'object' ? wrapped.data : wrapped;
        const snapshotAt = sourceObservationAt(result);
        policy.validate(ctx.scope);
        const records = result.records || result.result || [];
        return {
          status: statusOf(result),
          sourceId,
          data: {
            domain: args.domain,
            records: (Array.isArray(records) ? records : [records])
              .map((r: any) => safeRecord(r))
              .filter((r: any) => r && typeof r === 'object' && !Array.isArray(r)),
            source: ['holidays', 'notices'].includes(args.domain) ? '浙江大学官方公开信息' : '浙大本人账号（本机兼容连接）',
            institutionId: 'zju',
            termId: String(result.semester_id || 'unspecified'),
            live: args.refresh,
            origin: ['holidays', 'notices'].includes(args.domain) ? 'zju_public' : 'zju_account',
            authenticated: ['holidays', 'notices'].includes(args.domain) ? false : connector.authStatus === 'verified' || !!result.authenticated_at,
            total: typeof result.total_matches === 'number' ? result.total_matches : undefined,
            cached: !args.refresh,
            snapshotAt,
          },
          fetchedAt: snapshotAt,
          expiresAt:
            snapshotAt && Number.isFinite(Date.parse(snapshotAt))
              ? new Date(Date.parse(snapshotAt) + 300000).toISOString()
              : undefined,
          coverage: {
            complete: result.coverage?.complete === true || result.completeness?.complete === true,
            scope: args.domain,
          },
          reason: result.reason || result.error?.message,
          simulated: false,
        };
      }
      return {
        status: 'unsupported',
        sourceId,
        reason: '这个类别还不能从浙大账号读取；没有改用本地导入资料冒充。',
        simulated: false,
      };
    },
  });
  // A legacy import remains available only for explicit offline migration. It
  // has a different source ID and is never selected when the account skill is
  // configured, so it cannot masquerade as a current ZJU account result.
  register({
    manifest: manifest('campus-import', 'campus:local', [
      base('campus.imported_lookup', campusInput, campusImportOutput, ['campus:read'], { displayName: '读取离线校园资料' }),
    ], [], { displayName: '校园资料导入', description: '读取用户主动导入的离线校园资料，不代表当前校园系统。' }),
    invoke: async (_name, args, ctx) => {
      const metadata = repo.getMeta<{ institutionId: string; termId: string; source: string; updatedAt?: string }>(
        'campus_import_metadata',
      );
      if (!metadata)
        return {
          status: 'unsupported',
          sourceId: 'campus:local',
          reason: '没有离线快照；请登录浙大账号读取本人资料。',
          simulated: false,
        };
      const result = domains.resolve(ctx.scope, args.domain === 'practice' || args.domain === 'sports' ? 'sports' : args.domain, {
        institutionId: metadata.institutionId,
        termId: metadata.termId,
        from: args.from,
        to: args.to,
        query: args.query,
        limit: 6000,
      });
      let records = result.records;
      if (args.from)
        records = records.filter(
          (r) => !r.value.endsAt || Date.parse(String(r.value.endsAt)) > Date.parse(args.from),
        );
      if (args.to)
        records = records.filter(
          (r) => !r.value.startsAt || Date.parse(String(r.value.startsAt)) < Date.parse(args.to),
        );
      if (args.query) records = records.filter((r) => JSON.stringify(r.value).includes(args.query));
      const status = result.status === 'conflict' ? 'conflict' : records.length ? 'stale' : 'not_found';
      return {
        status,
        sourceId: 'campus:local',
        data: {
          domain: args.domain,
          records: records.slice(0, args.limit).map((r) => safeRecord(r.value)),
          conflicts: result.conflicts.map((g) => ({ id: g[0].id, sources: g.map((r) => r.sourceId) })),
          source: metadata.source,
          institutionId: metadata.institutionId,
          termId: metadata.termId,
          live: false,
          origin: 'legacy_import',
          authenticated: false,
          total: records.length,
          cached: true,
          snapshotAt: metadata.updatedAt,
        },
        fetchedAt: metadata.updatedAt || records[0]?.fetchedAt,
        coverage: { complete: result.records.length <= args.limit, scope: args.domain },
        reason: '这是本地离线快照，不是当前浙大账号查询。',
        simulated: false,
      };
    },
  });
  const place = z.object({ kind: z.enum(['place', 'node']), id: z.string().min(1).max(100) }).strict();
  const routeInput = z
    .object({
      from: z.union([place, z.object({ kind: z.literal('current') }).strict()]).optional(),
      to: place.optional(),
      avoidStairs: z.boolean().optional(),
      version: z.string().optional(),
    })
    .strict();
  register({
    manifest: manifest('spatial', 'map:local', [
      base('map.overview', z.object({}).strict(), jsonObject, ['map:read'], {
        displayName: '查看地图概览',
        subjects: ['self', 'other', 'fictional'],
      }),
      base(
        'map.search',
        z
          .object({ query: z.string().min(1).max(100), limit: z.number().int().min(1).max(10).default(5) })
          .strict(),
        z.object({ matches: z.array(jsonObject) }).strict(),
        ['map:read'],
        { displayName: '搜索地图地点', subjects: ['self', 'other', 'fictional'] },
      ),
      base('map.route', routeInput, jsonObject, ['map:read'], { displayName: '规划步行路线', subjects: ['self', 'other', 'fictional'] }),
      base('map.location_status', z.object({}).strict(), jsonObject, ['map:read'], { displayName: '查看定位状态' }),
    ], [], { displayName: '地图', description: '校园地图、地点搜索和步行路线。' }),
    invoke: (name, args) => {
      if (!connections.map)
        return {
          status: 'unsupported',
          sourceId: 'map:local',
          reason: '地图数据尚未装配。',
          simulated: false,
        };
      const value =
        name === 'map.overview'
          ? connections.map.overview()
          : name === 'map.search'
            ? { matches: connections.map.search(args.query, args.limit) }
            : name === 'map.route'
              ? connections.map.route(args)
              : connections.map.locationStatus();
      const v = value as any,
        status: KnowledgeStatus =
          name === 'map.route' && v.status !== 'ready' && v.status !== 'ok' && v.status !== 'success'
            ? 'unknown'
            : name === 'map.location_status'
              ? 'unknown'
              : 'fresh';
      return {
        status,
        sourceId: 'map:local',
        data: JSON.parse(JSON.stringify(value)),
        fetchedAt: repo.clock.now(),
        coverage: {
          complete: name !== 'map.route' || status === 'fresh',
          scope: 'OSM building entrances and walking graph',
        },
        reason: v.reason,
        simulated: false,
      };
    },
  });
  // Weather is intentionally not registered here. It is a versioned external
  // plugin so the Agent only sees it after the plugin manager has installed,
  // validated, and explicitly enabled the provider.
  register({
    manifest: manifest('evidence', 'history:self', [
      base(
        'evidence.search',
        z.object({ query: z.string().min(1).max(100) }).strict(),
        z.object({ results: z.array(jsonObject) }).strict(),
        ['evidence:read'],
        { displayName: '搜索历史证据' },
      ),
    ], [], { displayName: '历史证据', description: '在当前授权范围内搜索对话与资料证据。' }),
    invoke: (_name, args, ctx) => ({
      status: 'fresh',
      sourceId: 'history:self',
      data: {
        results: repo.searchEvidence(ctx.scope, args.query).map((e) => ({
          id: e.id,
          text: e.text,
          sourceId: e.sourceId,
          contentVersion: e.contentVersion,
          receivedAt: e.receivedAt,
          authority: e.authority,
        })),
      },
      fetchedAt: repo.clock.now(),
      simulated: false,
    }),
  });
}
