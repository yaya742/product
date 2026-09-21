import { z } from 'zod';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel } from '../runtime/policy';
import type { CapabilityBroker, CapabilityDefinition, CapabilityProvider } from './broker';
import { HarnessError } from '../../shared/harness';
import { calendarFieldsSchema, localCalendarChangeSchema } from '../../shared/calendar';
import { expandAgenda } from '../actions/calendar';

const jsonObject = z.record(z.string(), z.json());

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
  license: 'project-owned adapter',
});

export function registerBuiltins(
  broker: CapabilityBroker,
  policy: PolicyKernel,
  repo: KernelRepository,
) {
  const register = (provider: CapabilityProvider) =>
    broker.register(provider, { reviewed: true, source: 'bundled source review' });

  register({
    manifest: manifest('local-agenda', 'local-agenda', [
      base('local.agenda.change', localCalendarChangeSchema, z.object({}).strict(), ['local:write'], {
        displayName: '更改本地安排',
        effect: 'local_write',
        worlds: ['real'],
        supportsIdempotency: true,
        supportsInspect: true,
        supportsCancel: true,
        description: '按对象版本修改、删除本地安排或更改单个重复实例；事务执行并支持受版本保护的撤销。',
      }),
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
        z
          .object({
            query: z.string().max(100).optional(),
            from: z.string().datetime({ offset: true }).optional(),
            to: z.string().datetime({ offset: true }).optional(),
            timeZone: z.string().max(100).optional(),
          })
          .strict(),
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
        return {
          status: expanded.status,
          sourceId: 'local-agenda',
          data: { items: expanded.items, issues: expanded.issues },
          coverage: { complete: expanded.coverage.complete, scope: `dated occurrences from ${args.from} to ${args.to}; undated tasks excluded` },
          fetchedAt: repo.clock.now(),
          simulated: false,
        };
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
