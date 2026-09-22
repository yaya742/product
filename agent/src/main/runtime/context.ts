import { randomUUID } from 'node:crypto';
import type {
  Assertion,
  ContextContract,
  ContextPack,
  EvidenceBundle,
  EvidenceEvent,
  Need,
  NeedResult,
  TypedValue,
} from '../../shared/harness';
import { always, HarnessError } from '../../shared/harness';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel, IngressDecision } from './policy';
import type { CapabilityBroker, CapabilityResult } from '../capabilities/broker';
import type { DomainService } from '../storage/domains';
import type { WorkService } from './work';
import { canonical, dateInZone, dayBounds, evaluateCondition } from './semantics';
import { redactCredentials } from './redaction';
import type { ProviderMetadata } from '../provider';
import type { ProviderReceipt } from '../../shared/harness';
import { usageCost } from './model-usage';
import type { Completion } from '../provider';

function grams(text: string) {
  const p = Array.from(text.toLowerCase()),
    out = new Set<string>();
  for (let i = 0; i < p.length - 1; i++)
    if (!/[\s，。！？、；：]/.test(p[i] + p[i + 1])) out.add(p[i] + p[i + 1]);
  return out;
}
function lexical(query: string, text: string) {
  const a = grams(query),
    b = grams(text);
  let score = 0;
  for (const g of a) if (b.has(g)) score++;
  return score;
}
export class ContextCompiler {
  private providerMetadata?: ProviderMetadata;
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
    readonly broker: CapabilityBroker,
    readonly domains: DomainService,
    readonly work: WorkService,
  ) {}
  /** Bind only non-secret protocol facts; payloads and credentials never enter the receipt. */
  setProviderMetadata(metadata?: ProviderMetadata) {
    this.providerMetadata = metadata
  }
  /** The main model chooses additional evidence; no word list creates needs. */
  initialNeeds(_contract: ContextContract, _text: string): Need[] { return []; }
  async compile(
    ingress: IngressDecision, currentEvents: EvidenceEvent[], signal: AbortSignal,
    additionalNeeds: Need[] = [], acquire = false, sessionId?: string,
  ): Promise<ContextPack> {
    signal.throwIfAborted();
    const contract = ingress.contract, scope = this.policy.validate(contract.scope);
    // A hypothetical continuation can refer to what this same user just said
    // in this thread. Read only that transcript, never their ambient profile,
    // and never override explicit UI/source restrictions.
    const canReadHistory = this.policy.can(contract.scope, 'evidence:read');
    const historyScope = ingress.threadContextAllowed && canReadHistory ? this.policy.hostScope({ sources: ['current', 'history:self'], subjectId: scope.principalId, worldId: 'real', purposes: scope.purposes, audience: 'self', grants: ['evidence:read'], retention: scope.retention, infer: false }) : contract.scope;
    const history = sessionId && canReadHistory && !ingress.requiresReadPurpose ? this.repo.conversationHistory(historyScope, sessionId, currentEvents.map(e => e.id), ingress.threadContextAllowed ? 6 : 12) : [];
    const currentMatter = sessionId && canReadHistory && !ingress.requiresReadPurpose && contract.enhancements?.currentMatter !== false && scope.sources.includes('work:self') ? this.repo.currentMatter(contract.scope, sessionId) : null;
    const discovered = this.broker.discover(contract.scope);
    const capabilityDirectory = { items: discovered.slice(0, 24).map(item => ({ name: item.name, sourceId: item.sourceId, displayName: item.displayName, description: item.description, effect: item.effect, connected: item.connection.connected, connection: item.connection, executableInThisTurn: item.connection.connected && (item.effect === 'read' || contract.actionMode !== 'respond') })), more: discovered.length > 24, meaning: '仅是许可范围内的非敏感能力说明，没有读取资料或执行动作；存在、已连接、本轮允许执行、实际完成是不同事实。用look_up的capability目录继续搜索、分页或获取输入schema。' };
    const text = canonical({ current: ingress.authoredText, attachments: currentEvents.filter(e => e.speaker === 'external'), history, currentMatter, capabilityDirectory });
    const estimatedTokens = Math.ceil(Array.from(text).length / 1.4), readBytes = Buffer.byteLength(text);
    const blocked = estimatedTokens > contract.budget.maxTokens || readBytes > contract.budget.maxReadBytes;
    const evidenceIds = [...new Set([...currentEvents.map(e => e.id), ...history.filter(m => m.role === 'user').map(m => m.id)])];
    const receipt: ContextPack['receipt'] = {
      mechanismUses: { prefetch: 0, currentMatter: Number(!!currentMatter), repairRejudge: 0, closure: 0 },
      id: randomUUID(), runId: contract.id, contractRevision: contract.revision,
      policyRevision: contract.policyRevision, privacyEpoch: contract.privacyEpoch,
      watermarks: this.repo.watermarks(), providedEvidenceIds: evidenceIds,
      providedSourceIds: [...new Set([...currentEvents.map(e => e.sourceId), ...(history.length ? ['history:self'] : [])])],
      providedObjectVersions: currentEvents.map(e => ({ id: e.id, revision: e.contentVersion, kind: 'evidence' })),
      needResults: [], excludedReasonCounts: Object.fromEntries(contract.excludedReasons.map(reason => [reason, 1])),
      providerVersion: this.providerMetadata ? `${this.providerMetadata.protocol}/${this.providerMetadata.protocolVersion}` : 'unknown',
      ...(this.providerMetadata ? { provider: { ...this.providerMetadata, limits: { ...this.providerMetadata.limits, hostContextTokens: contract.budget.maxTokens } } } : {}),
      toolAttempts: [], coverage: blocked ? 'blocked' : 'conditional', budget: { estimatedTokens, readBytes },
    };
    const pack: ContextPack = {
      contract, bundles: [], assertions: [], evidence: currentEvents, needs: [], receipt,
      currentText: ingress.authoredText,
      data: {
        scope: { subject: scope.subjectId, world: scope.worldId, purpose: contract.purpose, audience: scope.audience, memoryMode: contract.memoryMode, retention: contract.retention },
        time: { now: contract.now, timeZone: contract.timeZone },
        history, ...(ingress.threadContextAllowed ? { historyUse: '仅作为同一对话里用户已提供的背景理解当前假设；不代表假设已在现实发生，也未读取本人长期画像或其他会话。' } : {}), currentSources: currentEvents.map(e => ({ id: e.id, sourceId: e.sourceId, authority: e.authority, text: e.text })),
        currentMatter, capabilityDirectory,
        currentFacts: {}, correctionOverlay: [], workState: [], needs: [],
        coverage: receipt.coverage,
        limitations: blocked ? ['原话及必要前情超过本轮预算，尚未截断；需要分段处理或缩小范围。'] : [],
      },
    };
    this.repo.saveReceipt(contract.scope, receipt);
    if (acquire && additionalNeeds.length) await this.expand(pack, additionalNeeds, signal);
    return pack;
  }
  /** Second layer: model-activated, scoped candidates; original search remains independent. */
  prefetch(pack: ContextPack, query: string, at = pack.contract.now, offset = 0, limit = 8, hardOffset = 0) {
    const scope = this.policy.validate(pack.contract.scope), time = Date.parse(at);
    if (!Number.isFinite(time)) throw new HarnessError('invalid_time', '检索时间不合法。');
    if (!scope.sources.includes('history:self') && !scope.sources.includes('profile:self'))
      return { status: 'forbidden', bundles: [], reason: '本轮资料范围不包括个人历史和记忆。' };
    const relevant = scope.sources.includes('profile:self') ? this.repo.lexicalAssertions(pack.contract.scope, query, 50) : [];
    const hard = scope.sources.includes('profile:self') ? this.repo.assertions(pack.contract.scope, { strength: 'hard', limit: 100 }) : [];
    const candidates = [...new Map([...hard, ...relevant].map(a => [a.id, a])).values()].filter(a =>
      a.status === 'active' && a.verification === 'verified' &&
      (!a.temporal.validFrom || Date.parse(a.temporal.validFrom) <= time) && (!a.temporal.validTo || Date.parse(a.temporal.validTo) > time));
    const orderedHard = [...new Map([...relevant.filter(a => a.strength === 'hard'), ...hard].filter(a => candidates.some(c => c.id === a.id)).map(a => [a.id, a])).values()];
    const selected = [...orderedHard.slice(hardOffset, hardOffset + 8), ...candidates.filter(a => a.strength !== 'hard').slice(offset, offset + limit)];
    const bundles = selected.map(assertion => {
      const related = [assertion, ...assertion.exceptionIds.map(id => this.repo.assertion(pack.contract.scope, id)).filter((a): a is Assertion => !!a && a.status === 'active')];
      const sources = [...new Set(related.flatMap(a => a.evidenceIds))].map(id => this.repo.evidence(pack.contract.scope, id)).filter((e): e is EvidenceEvent => !!e);
      return { assertions: related, sources: sources.map(e => ({ id: e.id, text: e.text, contentVersion: e.contentVersion, receivedAt: e.receivedAt, sourceId: e.sourceId, authority: e.authority })) };
    });
    const raw = scope.sources.includes('history:self') ? [...new Map([
      ...this.repo.searchEvidence(pack.contract.scope, query, 50), ...this.repo.lexicalEvidence(pack.contract.scope, query, 50),
    ].map(e => [e.id, e])).values()].slice(offset, offset + limit) : [];
    const value = { status: bundles.length || raw.length ? 'fresh' : 'not_found', bundles, originals: raw,
      coverage: { candidatesOnly: true, at, nextOffset: relevant.length > offset + limit || raw.length === limit ? offset + limit : null, nextHardOffset: orderedHard.length > hardOffset + 8 ? hardOffset + 8 : null, hardTotal: orderedHard.length, vectorSearch: 'not_connected', hardConstraintsSeparate: true } };
    const bytes = Buffer.byteLength(canonical(value)), tokens = Math.ceil(Array.from(canonical(value)).length / 1.4);
    if (pack.receipt.budget.readBytes + bytes > pack.contract.budget.maxReadBytes || pack.receipt.budget.estimatedTokens + tokens > pack.contract.budget.maxTokens)
      return { status: 'partial', reason: '完整条件与来源超出当前预算，没有拆散条件或静默截断。请缩小查询或分段读原文。', candidates: selected.map(a => ({ id: a.id, preview: Array.from(a.text).slice(0, 100).join(''), previewOnly: true, length: Array.from(a.text).length, hard: a.strength === 'hard' })), originals: raw.map(e => ({ id: e.id, length: Array.from(e.text).length })) };
    pack.assertions = [...new Map([...pack.assertions, ...bundles.flatMap(b => b.assertions)].map(a => [a.id, a])).values()];
    const ids = [...raw.map(e => e.id), ...bundles.flatMap(b => b.sources.map(e => e.id))];
    pack.receipt.providedEvidenceIds = [...new Set([...pack.receipt.providedEvidenceIds, ...ids])];
    pack.receipt.providedSourceIds = [...new Set([...(pack.receipt.providedSourceIds || []), ...raw.map(e => e.sourceId), ...bundles.flatMap(b => b.sources.map(e => e.sourceId))])];
    pack.receipt.providedObjectVersions = [...pack.receipt.providedObjectVersions, ...pack.assertions.map(a => ({ id: a.id, revision: a.revision, kind: 'assertion' as const }))];
    pack.receipt.budget.readBytes += bytes; pack.receipt.budget.estimatedTokens += tokens;
    pack.data.retrievedContext = value;
    this.repo.saveReceipt(pack.contract.scope, pack.receipt);
    return value;
  }
  async expand(pack: ContextPack, needs: Need[], signal: AbortSignal) {
    this.policy.validate(pack.contract.scope);
    for (const need of needs) {
      if (pack.needs.some((n) => n.key === need.key)) continue;
      const result = need.capability
        ? await this.broker.invoke(pack.contract.scope, need.capability, need.args, signal)
        : undefined;
      pack.needs.push({
        id: need.id,
        key: need.key,
        capability: need.capability,
        status: result?.status || 'unknown',
        evidenceIds: [],
        value: result?.data,
        reason: result?.reason || '缺少当前事实',
        fetchedAt: result?.fetchedAt,
      });
      if (result?.data)
        pack.receipt.providedSourceIds = [
          ...new Set([...(pack.receipt.providedSourceIds || []), result.sourceId]),
        ];
    }
    if (pack.needs.some((n) => !['fresh', 'known_absent'].includes(n.status)))
      pack.receipt.coverage = 'conditional';
    pack.receipt.needResults = pack.needs.map((n) => ({ key: n.key, status: n.status }));
    pack.data.needs = pack.needs;
    pack.data.coverage = pack.receipt.coverage;
    this.repo.saveReceipt(pack.contract.scope, pack.receipt);
    return pack;
  }
  /** Record the actual endpoint/mode used by a model call without retaining payloads. */
  recordObjects(pack: ContextPack | undefined, records: { id: string; revision: number }[], kind: 'assertion' | 'work') {
    if (!pack) return;
    for (const record of records) {
      const previous = pack.receipt.providedObjectVersions.find(value => value.id === record.id && value.kind === kind);
      if (previous) previous.revision = record.revision;
      else pack.receipt.providedObjectVersions.push({ id: record.id, revision: record.revision, kind });
    }
  }
  recordModelUsage(pack: ContextPack | undefined, usage: Completion['usage'], phase: string) {
    if (!pack) return;
    const cost = usageCost(usage);
    (pack.receipt.modelUsage ||= []).push({ phase, inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, usdMin: cost?.usdMin ?? null, usdMax: cost?.usdMax ?? null });
    this.repo.saveReceipt(pack.contract.scope, pack.receipt);
  }
  recordProviderRequest(
    pack: ContextPack | undefined,
    metadata: ProviderMetadata | undefined,
    mode: { thinking: 'enabled' | 'disabled'; strict: boolean; tools: boolean },
  ) {
    if (!pack || !metadata) return;
    const previous = pack.receipt.provider;
    const thinking = previous?.requestModes?.thinking;
    const strict = previous?.requestModes?.strict;
    const provider: ProviderReceipt = {
      ...metadata,
      observedEndpoints: [
        ...new Set([...(previous?.observedEndpoints || []), metadata.endpoint]),
      ],
      capabilities: {
        ...metadata.capabilities,
        modalities: [...metadata.capabilities.modalities],
      },
      limits: {
        ...metadata.limits,
        hostContextTokens: pack.contract.budget.maxTokens,
      },
      requestModes: {
        thinking:
          thinking && thinking !== mode.thinking
            ? 'mixed'
            : (thinking || mode.thinking),
        strict: strict !== undefined && strict !== mode.strict ? 'mixed' : (strict ?? mode.strict),
        tools: Boolean(previous?.requestModes?.tools || mode.tools),
      },
    };
    pack.receipt.provider = provider;
    pack.receipt.providerVersion = `${provider.protocol}/${provider.protocolVersion}`;
    this.repo.saveReceipt(pack.contract.scope, pack.receipt);
  }
  recordTool(pack: ContextPack, result: CapabilityResult, capability: string, invocationScopeId = pack.contract.scope.id) {
    this.policy.validate(pack.contract.scope);
    if (result.data) {
      pack.receipt.providedSourceIds = [
        ...new Set([...(pack.receipt.providedSourceIds || []), result.sourceId]),
      ];
      if (capability === 'evidence.search')
        for (const entry of (result.data as any).results || [])
          if (typeof entry.id === 'string' && this.repo.evidence(pack.contract.scope, entry.id))
            pack.receipt.providedEvidenceIds = [...new Set([...pack.receipt.providedEvidenceIds, entry.id])];
    }
    const attempt = this.broker.invocations
      .filter((i) => i.scopeId === invocationScopeId && i.capability === capability)
      .at(-1);
    if (attempt)
      pack.receipt.toolAttempts.push({
        id: attempt.id,
        capability,
        status: result.status,
        version: attempt.version,
      });
    const key =
      capability === 'campus.lookup'
        ? (result.data as any)?.domain || 'campus'
        : capability === 'weather.lookup'
          ? 'weather'
          : capability;
    const existing = pack.needs.find((n) => n.key === key || n.capability === capability);
    if (existing) {
      existing.status = result.status;
      existing.value = result.data;
      existing.reason = result.reason;
      existing.fetchedAt = result.fetchedAt;
      existing.coverage = result.coverage;
    } else
      pack.needs.push({
        id: key,
        key,
        capability,
        status: result.status,
        evidenceIds: [],
        value: result.data,
        reason: result.reason,
        fetchedAt: result.fetchedAt,
        coverage: result.coverage,
      });
    pack.receipt.needResults = pack.needs.map((n) => ({ key: n.key, status: n.status }));
    this.repo.saveReceipt(pack.contract.scope, pack.receipt);
  }
  serialize(pack: ContextPack) {
    this.policy.validate(pack.contract.scope);
    // Public/group drafting receives a release brief and explicitly allowed
    // projection only. Never serialize the authored event, speech acts,
    // history bundles or private work state into this model boundary.
    if (pack.contract.audience !== 'self') {
      return redactCredentials(
        canonical({
          scope: {
            audience: pack.contract.audience,
            purpose: pack.contract.purpose,
            memoryMode: pack.contract.memoryMode,
            retention: pack.contract.retention,
          },
          time: pack.data.time,
          interactionMode: pack.data.interactionMode,
          releaseSpec: pack.data.releaseSpec,
          availabilityProjection: pack.data.availabilityProjection,
          coverage: pack.receipt.coverage,
          limitations: pack.data.limitations,
        }),
      );
    }
    if (pack.receipt.coverage === 'blocked')
      return redactCredentials(
        canonical({
          scope: pack.data.scope,
          time: pack.data.time,
          currentRequest: pack.currentText,
          coverage: 'blocked',
          limitations: pack.data.limitations,
          missing: pack.receipt.needResults,
        }),
      );
    return redactCredentials(canonical(pack.data));
  }
}
