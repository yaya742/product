import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  HarnessError,
  knowledgeStatus,
  type ContextContract,
  type KnowledgeStatus,
  type Need,
  type ScopeHandle,
  type TypedValue,
} from '../../shared/harness';
import type { PolicyKernel } from '../runtime/policy';
import type { WorkService } from '../runtime/work';
import { canonical } from '../runtime/semantics';

/** JSON Schema metadata exposed to the Agent for plugin capability discovery. */
export type CapabilityJsonSchema = Record<string, unknown>;

export interface CapabilityResult<T = unknown> {
  status: KnowledgeStatus;
  data?: T;
  sourceId: string;
  observedAt?: string;
  fetchedAt?: string;
  expiresAt?: string;
  coverage?: { complete: boolean; scope: string; until?: string };
  reason?: string;
  simulated: boolean;
}
export interface CapabilityDefinition {
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  input: z.ZodType;
  output: z.ZodType;
  /** Optional schema authored by an external plugin and checked by the host. */
  inputSchema?: CapabilityJsonSchema;
  outputSchema?: CapabilityJsonSchema;
  effect: 'read' | 'local_write' | 'external_write';
  requiredScopes: string[];
  subjects: ('self' | 'other' | 'fictional')[];
  worlds: ('real' | 'scenario')[];
  timeoutMs: number;
  maxBytes: number;
  supportsIdempotency: boolean;
  supportsInspect: boolean;
  supportsCancel: boolean;
}
export interface CapabilityManifest {
  id: string;
  version: string;
  displayName?: string;
  description?: string;
  trust: 'bundled_reviewed' | 'external_reviewed' | 'untrusted_disabled';
  sourceId: string;
  capabilities: CapabilityDefinition[];
  egressHosts: string[];
  platforms: string[];
  simulated: boolean;
  offline: 'read_cache' | 'unsupported';
  license: string;
}
export interface CapabilityProviderSnapshot {
  id: string;
  version: string;
  displayName?: string;
  description?: string;
  trust: CapabilityManifest['trust'];
  sourceId: string;
  egressHosts: string[];
  platforms: string[];
  simulated: boolean;
  offline: CapabilityManifest['offline'];
  license: string;
  enabled: boolean;
  connection: { connected: boolean; reason?: string; entry?: string };
  capabilities: {
    name: string;
    displayName?: string;
    description?: string;
    version: string;
    effect: CapabilityDefinition['effect'];
    requiredScopes: string[];
    timeoutMs: number;
    maxBytes: number;
    supportsIdempotency: boolean;
    supportsInspect: boolean;
    supportsCancel: boolean;
  }[];
}
export interface InvocationContext {
  signal: AbortSignal;
  scope: ScopeHandle;
  capability: string;
  deadline: string;
  idempotencyKey?: string;
  /** Only the broker's mediated network port is part of the provider API; interfaces alone are not an OS sandbox. */
  request(url: string, init?: RequestInit): Promise<Response>;
}
export interface CapabilityProvider {
  manifest: CapabilityManifest;
  connectionStatus?: () => { connected: boolean; reason?: string; entry?: string };
  invoke(name: string, args: any, context: InvocationContext): Promise<unknown> | unknown;
  inspect?(name: string, key: string, context: InvocationContext): Promise<unknown>;
  cancel?(name: string, key: string, context: InvocationContext): Promise<unknown>;
}
export interface Recipe {
  id: string;
  version: string;
  triggers: string[];
  capabilities: string[];
  needs: Need[];
  status: 'reviewed' | 'candidate' | 'rejected';
}
export interface InvocationAudit {
  id: string;
  capability: string;
  providerId: string;
  version: string;
  status: KnowledgeStatus;
  scopeId: string;
  simulated: boolean;
  bytes: number;
}
const resultSchema = z
  .object({
    status: knowledgeStatus,
    data: z.unknown().optional(),
    sourceId: z.string(),
    observedAt: z.string().optional(),
    fetchedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    coverage: z
      .object({ complete: z.boolean(), scope: z.string(), until: z.string().optional() })
      .strict()
      .optional(),
    reason: z.string().max(500).optional(),
    simulated: z.boolean(),
  })
  .strict();
export class CapabilityBroker {
  private providers = new Map<string, CapabilityProvider>();
  private disabledProviders = new Set<string>();
  private capabilities = new Map<
    string,
    { provider: CapabilityProvider; definition: CapabilityDefinition }
  >();
  private recipes = new Map<string, Recipe[]>();
  private cached = new Map<string, CapabilityResult>();
  private inFlight = new Map<string, Promise<CapabilityResult>>();
  private active = new Set<AbortController>();
  readonly invocations: InvocationAudit[] = [];
  readonly rejections: { capability: string; code: string }[] = [];
  private budgets = new Map<string, { calls: number; bytes: number }>();
  constructor(
    readonly policy: PolicyKernel,
    private fetcher: typeof fetch = fetch,
  ) {
    policy.onBarrier(() => {
      for (const c of this.active) c.abort(new HarnessError('stale_scope', '资料范围已改变。'));
      this.cached.clear();
      this.inFlight.clear();
    });
  }
  register(
    provider: CapabilityProvider,
    approval: { reviewed: boolean; source: string; allowUntrustedDisabled?: boolean },
  ) {
    const m = provider.manifest;
    if (!approval.reviewed || !approval.source || (m.trust === 'untrusted_disabled' && !approval.allowUntrustedDisabled))
      throw new HarnessError('unreviewed_provider', '未审核扩展不能运行。');
    if (this.providers.has(m.id)) throw new HarnessError('provider_exists', '扩展已登记，升级需要显式替换。');
    if (
      !/^[a-zA-Z0-9_.:-]{1,100}$/.test(m.id) ||
      !m.version ||
      !m.sourceId ||
      !m.license ||
      m.capabilities.length > 32
    )
      throw new HarnessError('invalid_manifest', '扩展登记信息不完整。');
    for (const d of m.capabilities) {
      if (
        this.capabilities.has(d.name) ||
        !d.name ||
        !d.input ||
        !d.output ||
        d.timeoutMs <= 0 ||
        d.timeoutMs > 90000 ||
        d.maxBytes <= 0 ||
        d.maxBytes > 150000
      )
        throw new HarnessError('invalid_capability', '能力名称冲突或预算无效。');
      if (d.effect !== 'read' && d.worlds.includes('scenario'))
        throw new HarnessError('scenario_effect', '假设世界不能执行副作用。');
    }
    this.providers.set(m.id, provider);
    if (m.trust === 'untrusted_disabled') this.disabledProviders.add(m.id);
    for (const definition of m.capabilities) this.capabilities.set(definition.name, { provider, definition });
    this.policy.registerSource(m.sourceId);
  }
  unregister(id: string) {
    const p = this.providers.get(id);
    if (!p) return;
    for (const c of p.manifest.capabilities) this.capabilities.delete(c.name);
    this.providers.delete(id);
    this.disabledProviders.delete(id);
    this.cached.clear();
  }
  providerSnapshots(): CapabilityProviderSnapshot[] {
    return [...this.providers.values()].map((provider) => {
      const m = provider.manifest;
      return {
        id: m.id,
        version: m.version,
        displayName: m.displayName,
        description: m.description,
        trust: m.trust,
        sourceId: m.sourceId,
        egressHosts: [...m.egressHosts],
        platforms: [...m.platforms],
        simulated: m.simulated,
        offline: m.offline,
        license: m.license,
        enabled: !this.disabledProviders.has(m.id),
        connection: { ...(provider.connectionStatus?.() || { connected: true }) },
        capabilities: m.capabilities.map((d) => ({
          name: d.name,
          displayName: d.displayName,
          description: d.description,
          version: d.version,
          effect: d.effect,
          requiredScopes: [...d.requiredScopes],
          timeoutMs: d.timeoutMs,
          maxBytes: d.maxBytes,
          supportsIdempotency: d.supportsIdempotency,
          supportsInspect: d.supportsInspect,
          supportsCancel: d.supportsCancel,
        })),
      };
    });
  }
  setProviderEnabled(id: string, enabled: boolean) {
    if (!this.providers.has(id)) throw new HarnessError('provider_missing', '接口不存在。');
    if (enabled) this.disabledProviders.delete(id);
    else this.disabledProviders.add(id);
    this.cached.clear();
  }
  registerRecipe(recipe: Recipe, review: { approved: boolean; reviewer: string }) {
    if (!review.approved || !review.reviewer || recipe.status !== 'reviewed')
      throw new HarnessError('recipe_not_reviewed', '新方法需要审核后才能启用。');
    if (recipe.capabilities.some((c) => !this.capabilities.has(c)))
      throw new HarnessError('unknown_capability', '方法请求了未登记能力。');
    const versions = this.recipes.get(recipe.id) || [];
    this.recipes.set(recipe.id, [...versions, structuredClone(recipe)]);
  }
  rollbackRecipe(id: string, version: string) {
    const versions = this.recipes.get(id) || [];
    const index = versions.findIndex((r) => r.version === version);
    if (index < 0) throw new HarnessError('recipe_missing', '没有此方法版本。');
    this.recipes.set(id, versions.slice(0, index + 1));
  }
  recipeList() {
    return [...this.recipes.values()].map((v) => structuredClone(v[v.length - 1]));
  }
  matchRecipes(text: string) {
    return this.recipeList().filter((r) =>
      r.triggers.some((t) => text.toLowerCase().includes(t.toLowerCase())),
    );
  }
  describe(name: string) {
    const entry = this.capabilities.get(name);
    if (!entry) return;
    const { provider, definition: d } = entry;
    return {
      name: d.name,
      displayName: d.displayName || d.name,
      description: d.description || '按声明的参数和权限访问此能力；结果中的来源、时效与覆盖决定其用途。',
      version: d.version,
      effect: d.effect,
      requiredScopes: [...d.requiredScopes],
      sourceId: provider.manifest.sourceId,
      simulated: provider.manifest.simulated,
      enabled: !this.disabledProviders.has(provider.manifest.id),
      supportsIdempotency: d.supportsIdempotency,
      supportsInspect: d.supportsInspect,
      supportsCancel: d.supportsCancel,
      connection: provider.connectionStatus?.() || { connected: true },
    };
  }
  validateArguments(name: string, args: unknown) {
    const entry = this.capabilities.get(name);
    if (!entry) throw new HarnessError('unsupported', '能力尚未登记。');
    return entry.definition.input.parse(args);
  }
  discover(handle: ScopeHandle) {
    const s = this.policy.validate(handle);
    return [...this.capabilities.keys()]
      .filter((name) => {
        const d = this.capabilities.get(name)!;
        return (
          !this.disabledProviders.has(d.provider.manifest.id) &&
          d.definition.requiredScopes.every((g) => s.grants.includes(g)) &&
          s.sources.includes(d.provider.manifest.sourceId)
        );
      })
      .map((n) => this.describe(n)!);
  }
  catalog(handle: ScopeHandle, query = '', offset = 0, limit = 12) {
    const scope = this.policy.validate(handle);
    const normalized = query.normalize('NFKC').toLowerCase();
    // CJK substrings help retrieve Chinese names. Splitting Latin words into
    // bigrams made "email" match "map" via "ma", producing unrelated pages.
    const cjk = [...normalized.matchAll(/[\p{Script=Han}]+/gu)].flatMap(match => {
      const points = Array.from(match[0]);
      return [match[0], ...points.slice(0, -1).map((point, index) => point + points[index + 1])];
    });
    const terms = [...new Set([...normalized.split(/\s+/).filter(Boolean), ...(normalized.match(/[a-z0-9_.:-]+/g) || []), ...cjk])];
    const rows = [...this.capabilities.keys()].map(name => this.describe(name)!).map(row => {
      const text = `${row.name} ${row.displayName} ${row.description}`.normalize('NFKC').toLowerCase();
      return { row, score: terms.reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0) };
    }).filter(result => !query || result.score > 0).sort((a, b) => b.score - a.score).map(result => result.row);
    const items = rows.slice(offset, offset + limit).map(row => ({ ...row,
      executable: row.enabled && row.connection.connected && row.requiredScopes.every(grant => scope.grants.includes(grant)) && scope.sources.includes(row.sourceId),
    }));
    return { items, nextOffset: offset + limit < rows.length ? offset + limit : null, total: rows.length, catalogOnly: true,
      coverage: { query, matchingOnly: !!query, returned: items.length, totalMatches: rows.length, meaning: 'This is a capability-description page. An omitted item in a filtered search is not proof it is absent. Described or connected does not mean an action ran.' },
    };
  }
  detail(handle: ScopeHandle, name: string) {
    this.policy.validate(handle);
    const entry = this.capabilities.get(name);
    if (!entry) return { status: 'not_found' };
    const declaredInputSchema = entry.definition.inputSchema;
    const inputSchema = declaredInputSchema
      ? structuredClone(declaredInputSchema)
      : (() => {
          const { $schema: _, ...generated } = z.toJSONSchema(entry.definition.input);
          return generated;
        })();
    const declaredOutputSchema = entry.definition.outputSchema;
    const outputSchema = declaredOutputSchema
      ? structuredClone(declaredOutputSchema)
      : (() => {
          const { $schema: _, ...generated } = z.toJSONSchema(entry.definition.output);
          return generated;
        })();
    return { ...this.describe(name), inputSchema, outputSchema, status: 'described', effectMeaning: entry.definition.effect, timeoutMs: entry.definition.timeoutMs, outputBytesLimit: entry.definition.maxBytes };
  }
  private context(
    handle: ScopeHandle,
    name: string,
    controller: AbortController,
    idempotencyKey?: string,
  ): InvocationContext {
    const entry = this.capabilities.get(name)!;
    const d = entry.definition,
      m = entry.provider.manifest;
    return {
      scope: handle,
      signal: controller.signal,
      capability: name,
      idempotencyKey,
      deadline: new Date(Date.parse(this.policy.repo.clock.now()) + d.timeoutMs).toISOString(),
      request: async (url, init = {}) => {
        this.policy.validate(handle);
        const parsed = new URL(url),
          method = (init.method || 'GET').toUpperCase();
        if (
          !m.egressHosts.includes(parsed.host) ||
          !['https:', 'http:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
        )
          throw new HarnessError('egress_forbidden', '此目标地址不在扩展的出站范围内。');
        if (d.effect === 'read' && !['GET', 'HEAD'].includes(method))
          throw new HarnessError('effect_mismatch', '只读扩展不能发起写请求。');
        if (d.effect === 'external_write' && !idempotencyKey)
          throw new HarnessError('approval_required', '外部请求缺少获批动作。');
        return this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      },
    };
  }
  async invoke(
    handle: ScopeHandle,
    name: string,
    args: unknown,
    signal: AbortSignal,
    options: {
      actionAttempt?: { id: string; key: string };
      inspectKey?: string;
      cancelKey?: string;
      maxCalls?: number;
      refresh?: boolean;
    } = {},
  ): Promise<CapabilityResult> {
    const attemptId = randomUUID();
    let entry = this.capabilities.get(name);
    if (!entry)
      return {
        status: 'unsupported',
        sourceId: 'unregistered',
        reason: '这项能力尚未接入。',
        simulated: false,
      };
    const { definition: d, provider } = entry,
      m = provider.manifest;
    try {
      signal.throwIfAborted();
      const s = this.policy.validate(handle);
      if (this.disabledProviders.has(m.id)) throw new HarnessError('provider_disabled', '该接口已停用。');
      for (const grant of d.requiredScopes) this.policy.require(handle, grant);
      if (!s.sources.includes(m.sourceId))
        throw new HarnessError('source_forbidden', '此来源不在当前资料范围内。');
      const subject =
        s.subjectId === s.principalId ? 'self' : s.subjectId.startsWith('fictional:') ? 'fictional' : 'other';
      if (!d.subjects.includes(subject) || !d.worlds.includes(s.worldId === 'real' ? 'real' : 'scenario'))
        throw new HarnessError('scope_mismatch', '能力不适用于当前主体或世界。');
      if (!m.platforms.includes(process.platform) && !m.platforms.includes('*'))
        return {
          status: 'unsupported',
          sourceId: m.sourceId,
          reason: '当前设备不支持这项能力。',
          simulated: m.simulated,
        };
      if (d.effect !== 'read' && !options.actionAttempt && !options.inspectKey && !options.cancelKey)
        throw new HarnessError('approval_required', '请先确认具体动作。');
      if (s.child && d.effect !== 'read') throw new HarnessError('child_write', '只读子任务不能执行动作。');
      const parsed = d.input.parse(args);
      if (options.actionAttempt) {
        const row = this.policy.repo.db
          .prepare(
            'SELECT t.action_id,t.idempotency_key,t.status,t.epoch,a.payload FROM h_attempts t JOIN h_actions a ON a.id=t.action_id WHERE t.id=? AND a.owner=? AND a.workspace=? AND a.subject=? AND a.world=?',
          )
          .get(options.actionAttempt.id, s.principalId, s.workspaceId, s.subjectId, s.worldId);
        const action = row ? JSON.parse(String(row.payload)) : undefined;
        if (
          !row ||
          row.idempotency_key !== options.actionAttempt.key ||
          row.status !== 'dispatching' ||
          Number(row.epoch) !== s.privacyEpoch ||
          action.capability !== name ||
          canonical(action.arguments) !== canonical(parsed)
        )
          throw new HarnessError('invalid_attempt', '执行凭据与实际参数不匹配。');
      }
      if (options.inspectKey || options.cancelKey) {
        const row = this.policy.repo.db
          .prepare(
            "SELECT id FROM h_actions WHERE owner=? AND workspace=? AND subject=? AND world=? AND json_extract(payload,'$.capability')=? AND json_extract(payload,'$.idempotencyKey')=?",
          )
          .get(
            s.principalId,
            s.workspaceId,
            s.subjectId,
            s.worldId,
            name,
            options.inspectKey || options.cancelKey!,
          );
        if (!row) throw new HarnessError('invalid_attempt', '核查标识不属于当前获准的动作。');
      }
      const fingerprint = canonical({
        sources: s.sources,
        subject: s.subjectId,
        world: s.worldId,
        purposes: s.purposes,
        audience: s.audience,
        epoch: s.privacyEpoch,
        revision: s.policyRevision,
        domainRevision: this.policy.repo.domainRevision,
        current: ['history:self', 'current'].includes(m.sourceId) ? s.currentEventIds : [],
      });
      const key = fingerprint + ':' + name + ':' + canonical(parsed);
      const cached = !options.refresh && d.effect === 'read' ? this.cached.get(key) : undefined;
      if (cached?.expiresAt && Date.parse(cached.expiresAt) > Date.parse(this.policy.repo.clock.now())) {
        this.policy.validate(handle);
        return structuredClone(cached);
      }
      const existing = d.effect === 'read' && !options.refresh ? this.inFlight.get(key) : undefined;
      if (existing) {
        const result = await existing;
        signal.throwIfAborted();
        this.policy.validate(handle);
        return structuredClone(result);
      }
      const budget = this.budgets.get(handle.id) || { calls: 0, bytes: 0 };
      if (++budget.calls > (options.maxCalls || 12))
        throw new HarnessError('tool_budget', '本轮读取达到上限，请缩小范围。');
      this.budgets.set(handle.id, budget);
      const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new HarnessError('provider_timeout', '来源读取超时。')),
        d.timeoutMs,
      );
      this.active.add(controller);
      const invocation = this.context(
        handle,
        name,
        controller,
        options.actionAttempt?.key || options.inspectKey || options.cancelKey,
      );
      const bounded = async <T>(operation: () => Promise<T> | T): Promise<T> => {
        let cancelled!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          cancelled = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', cancelled, { once: true });
          if (controller.signal.aborted) cancelled();
        });
        try {
          return await Promise.race([Promise.resolve().then(operation), interrupted]);
        } finally {
          controller.signal.removeEventListener('abort', cancelled);
        }
      };
      const run = async (): Promise<CapabilityResult> => {
        try {
          let raw: unknown;
          if (options.inspectKey) {
            if (!d.supportsInspect || !provider.inspect)
              return {
                status: 'unsupported',
                sourceId: m.sourceId,
                reason: '提供方不支持核查，请人工核实。',
                simulated: m.simulated,
              };
            raw = await bounded(() => provider.inspect!(name, options.inspectKey!, invocation));
          } else if (options.cancelKey) {
            if (!d.supportsCancel || !provider.cancel)
              return {
                status: 'unsupported',
                sourceId: m.sourceId,
                reason: '提供方不支持撤销。',
                simulated: m.simulated,
              };
            raw = await bounded(() => provider.cancel!(name, options.cancelKey!, invocation));
          } else raw = await bounded(() => provider.invoke(name, parsed, invocation));
          controller.signal.throwIfAborted();
          this.policy.validate(handle);
          const bytes = Buffer.byteLength(JSON.stringify(raw));
          if (bytes > d.maxBytes || budget.bytes + bytes > 180000)
            throw new HarnessError('output_budget', '来源内容过大，请缩小查询。');
          budget.bytes += bytes;
          const result = resultSchema.parse(raw) as CapabilityResult;
          if (result.sourceId !== m.sourceId || result.simulated !== m.simulated)
            throw new HarnessError('provenance_mismatch', '来源或模拟状态不符合登记信息。');
          if (result.data !== undefined) result.data = d.output.parse(result.data);
          if (
            result.status === 'fresh' &&
            result.expiresAt &&
            Date.parse(result.expiresAt) <= Date.parse(this.policy.repo.clock.now())
          )
            result.status = 'stale';
          if (result.status === 'known_absent' && result.coverage?.complete !== true)
            throw new HarnessError('incomplete_absence', '不完整结果不能证明没有约束。');
          if (d.effect === 'read' && result.status === 'fresh' && result.expiresAt)
            this.cached.set(key, structuredClone(result));
          this.invocations.push({
            id: attemptId,
            capability: name,
            providerId: m.id,
            version: d.version,
            status: result.status,
            scopeId: handle.id,
            simulated: m.simulated,
            bytes,
          });
          return result;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          this.active.delete(controller);
          this.inFlight.delete(key);
        }
      };
      const pending = run();
      if (d.effect === 'read') this.inFlight.set(key, pending);
      return await pending;
    } catch (error) {
      if (signal.aborted) throw error;
      const code =
        error instanceof HarnessError
          ? error.code
          : error instanceof z.ZodError
            ? 'schema_rejected'
            : 'provider_failed';
      this.rejections.push({ capability: name, code });
      const forbidden = [
        'forbidden',
        'source_forbidden',
        'scope_mismatch',
        'approval_required',
        'invalid_attempt',
        'stale_scope',
        'egress_forbidden',
        'effect_mismatch',
        'provider_disabled',
      ].includes(code);
      if (d.effect !== 'read' && !forbidden) throw error; // An action timeout must reach ActionRuntime as outcome_unknown.
      const status: KnowledgeStatus = forbidden ? 'forbidden' : 'failed';
      this.invocations.push({
        id: attemptId,
        capability: name,
        providerId: m.id,
        version: d.version,
        status,
        scopeId: handle.id,
        simulated: m.simulated,
        bytes: 0,
      });
      return {
        status,
        sourceId: m.sourceId,
        reason: error instanceof HarnessError ? error.message : '来源返回无效或未完成的数据。',
        simulated: m.simulated,
      };
    }
  }
  async runRecipes(contract: ContextContract, text: string, work: WorkService, signal: AbortSignal) {
    const facts: Record<string, TypedValue> = {},
      results: { key: string; capability: string; result: CapabilityResult }[] = [];
    const updatedOptions: import('../../shared/harness').WorkRecord[] = [];
    for (const recipe of this.matchRecipes(text))
      for (const need of recipe.needs) {
        if (!need.capability || !recipe.capabilities.includes(need.capability)) continue;
        const result = await this.invoke(contract.scope, need.capability, need.args, signal);
        results.push({ key: need.key, capability: need.capability, result });
        const data = result.data as { available?: boolean; affordances?: string[] } | undefined;
        if (result.status === 'fresh' && typeof data?.available === 'boolean')
          facts['capability:' + need.capability] = { type: 'boolean', value: data.available };
      }
    if (Object.keys(facts).length && this.policy.can(contract.scope, 'work:write')) {
      const updated = work.revalidateRejections(contract.scope, facts);
      updatedOptions.push(...updated);
      for (const option of updated) {
        const checks = results.filter((r) => r.result.status === 'fresh'),
          expiresAt = checks
            .map(
              (r) =>
                r.result.expiresAt ||
                new Date(Date.parse(this.policy.repo.clock.now()) + 300000).toISOString(),
            )
            .sort()[0];
        work.update(contract.scope, option.id, option.revision, {
          data: {
            ...option.data,
            rejectionCheckExpiresAt: expiresAt,
            checkedCapabilities: checks.map((r) => r.capability),
          },
        });
        for (const check of checks)
          for (const grant of this.capabilities.get(check.capability)?.definition.requiredScopes || [])
            this.policy.repo.addDependency(contract.scope, {
              consumerId: option.id,
              producerId: 'grant:' + grant,
              producerRevision: contract.policyRevision,
              sensitivity: 'privacy',
              invalidation: 'block',
            });
      }
    }
    return { results, updatedOptions };
  }
}
