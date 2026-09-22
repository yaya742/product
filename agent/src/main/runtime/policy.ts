import { randomUUID } from 'node:crypto';
import {
  HarnessError,
  type ContextContract,
  type ScopeData,
  type ScopeHandle,
  type InterpretationProposal,
  type RequestFragment,
} from '../../shared/harness';
import type { KernelRepository } from '../storage/repository';
import { addDate, dateInZone, resolveLocalTime } from './semantics';
import { authoredControls, routeSpeechActs, type SpeechAct } from './discourse';
import { hasCredentials } from './redaction';
import { localCloudRestriction, type TurnControlProposal } from './turn-controls';

export interface InputControls {
  /** The product owner agent keeps responsibility for the complete request. */
  replyToOwner?: boolean;
  controlFallback?: boolean;
  priorReleaseArtifacts?: import('../../shared/types').ReleaseArtifact[];
  transmission?: 'cloud_allowed' | 'local_only';
  priorReleasedDraft?: { id: string; text: string; brief?: { recipient: string; [key: string]: unknown } };
  enhancements?: ContextContract['enhancements'];
  /** Host-only proposal from the bounded pre-storage control parser. */
  semantic?: TurnControlProposal;
  memoryMode?: ContextContract['memoryMode'];
  retention?: ContextContract['retention'];
  audience?: ContextContract['audience'];
  sources?: string[];
  subjectId?: string;
  worldId?: string;
  timeZone?: string;
  attachment?: { id: string; name: string; text: string };
  purpose?: string;
  budget?: Partial<ContextContract['budget']>;
}
export interface IngressDecision {
  controlFallback?: boolean;
  replyToOwner?: boolean;
  controlProposal?: TurnControlProposal;
  priorReleaseArtifacts?: import('../../shared/types').ReleaseArtifact[];
  threadContextAllowed?: boolean;
  priorReleasedDraft?: InputControls['priorReleasedDraft'];
  releaseBrief?: TurnControlProposal['release'];
  projectionSources?: string[];
  requiresReadPurpose?: boolean;
  text: string;
  authoredText: string;
  attachment?: { id: string; name: string; text: string };
  contract: ContextContract;
  restriction: boolean;
  scenario: boolean;
  corrections: string[];
  speechActs: SpeechAct[];
  interpretation: InterpretationProposal;
  requestFragments: RequestFragment[];
  localOnly: boolean;
}
export function splitUserInput(text: string, eventId: string, supplied?: InputControls['attachment']) {
  if (supplied) return { authoredText: text, attachment: supplied };
  const marker = text.match(/\n\n\[用户附上的文字资料：([^\]]+)\]\n/);
  return marker?.index === undefined ? { authoredText: text, attachment: undefined } : {
    authoredText: text.slice(0, marker.index), attachment: { id: eventId + ':file', name: marker[1], text: text.slice(marker.index + marker[0].length) },
  };
}
const baseSources = [
  'current',
  'history:self',
  'profile:self',
  'work:self',
  'local-agenda',
  'campus:local',
  'campus:zju-account',
  'map:local',
];

export class PolicyKernel {
  private scopes = new WeakMap<ScopeHandle, ScopeData>();
  private listeners = new Set<() => void>();
  constructor(readonly repo: KernelRepository) {
    repo.bindPolicy((handle) => this.validate(handle));
  }
  onBarrier(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  signalBarrier() {
    for (const fn of this.listeners) fn();
  }
  revoked() {
    return this.repo.getMeta<string[]>('revoked', []);
  }
  grants() {
    return this.repo.getMeta<string[]>('grants', [
      'local:write',
      'evidence:read',
      'memory:write',
      'work:write',
      'campus:read',
      'map:read',
    ]);
  }
  /** Called only by trusted host UI/configuration, never a tool argument or provider response. */
  grant(scope: string) {
    this.repo.write(() => {
      this.repo.setMeta('grants', [...new Set([...this.grants(), scope])]);
      this.repo.setMeta(
        'revoked',
        this.revoked().filter((s) => s !== scope),
      );
      this.repo.setMeta('policy_revision', this.repo.policyRevision + 1);
    });
    this.repo.persistPolicyState();
    this.signalBarrier();
  }
  revoke(scope: string) {
    if (this.revoked().includes(scope) && !this.grants().includes(scope)) {
      return;
    }
    this.repo.establishFence({ kind: 'revoke', objectIds: [], sourceIds: [], scope });
    this.repo.write(() => {
      this.repo.setMeta('revoked', [...new Set([...this.revoked(), scope])]);
      this.repo.setMeta(
        'grants',
        this.grants().filter((s) => s !== scope),
      );
      this.repo.invalidate('grant:' + scope, 'permission_revoked');
    });
    this.repo.persistPolicyState();
    this.repo.revalidatePrivacyJobs();
    this.signalBarrier();
  }
  hostScope(
    overrides: Partial<
      Omit<ScopeData, keyof typeof this.repo.identity | 'privacyEpoch' | 'policyRevision'>
    > = {},
  ): ScopeHandle {
    const sources = [...baseSources, ...this.repo.getMeta<string[]>('registered_sources', [])];
    const data: ScopeData = {
      ...this.repo.identity,
      subjectId: this.repo.identity.principalId,
      worldId: 'real',
      sources,
      currentEventIds: [],
      purposes: ['personal_assistance'],
      audience: 'self',
      grants: this.grants().filter((g) => !this.revoked().includes(g)),
      privacyEpoch: this.repo.epoch,
      policyRevision: this.repo.policyRevision,
      retention: 'purpose_scoped',
      infer: true,
      expiresAt: new Date(Date.parse(this.repo.clock.now()) + 240000).toISOString(),
      child: false,
      ...overrides,
    };
    return this.mint(data);
  }
  private mint(data: ScopeData): ScopeHandle {
    const handle = Object.freeze({ id: randomUUID() }) as ScopeHandle;
    this.scopes.set(
      handle,
      Object.freeze({
        ...data,
        sources: Object.freeze([...data.sources]),
        currentEventIds: Object.freeze([...data.currentEventIds]),
        purposes: Object.freeze([...data.purposes]),
        grants: Object.freeze([...data.grants]),
      }),
    );
    return handle;
  }
  validate(handle: ScopeHandle): ScopeData {
    const data = this.scopes.get(handle);
    if (!data) throw new HarnessError('forged_scope', '请求没有可信作用域。');
    if (data.privacyEpoch !== this.repo.epoch || data.policyRevision !== this.repo.policyRevision)
      throw new HarnessError('stale_scope', '资料使用范围已改变，旧处理已停止。');
    if (Date.parse(data.expiresAt) <= Date.parse(this.repo.clock.now()))
      throw new HarnessError('scope_expired', '本轮资料授权已到期。');
    return data;
  }
  narrow(
    parent: ScopeHandle,
    changes: Partial<
      Pick<ScopeData, 'sources' | 'currentEventIds' | 'purposes' | 'grants' | 'infer' | 'child' | 'expiresAt'>
    >,
  ): ScopeHandle {
    const current = this.validate(parent);
    for (const key of ['sources', 'currentEventIds', 'purposes', 'grants'] as const)
      if (changes[key]?.some((value) => !current[key].includes(value)))
        throw new HarnessError('scope_escalation', '子任务不能扩大资料使用范围。');
    if (changes.infer && !current.infer) throw new HarnessError('scope_escalation', '不能扩大推断权限。');
    if (changes.expiresAt && Date.parse(changes.expiresAt) > Date.parse(current.expiresAt))
      throw new HarnessError('scope_escalation', '不能延长授权期限。');
    return this.mint({ ...current, ...changes });
  }
  require(handle: ScopeHandle, grant: string) {
    const s = this.validate(handle);
    if (!s.grants.includes(grant) || this.revoked().includes(grant))
      throw new HarnessError('forbidden', '这项能力未获本轮授权。');
    return s;
  }
  can(handle: ScopeHandle, grant: string) {
    try {
      this.require(handle, grant);
      return true;
    } catch {
      return false;
    }
  }
  /** Host-only, after exact local delegation verification. Persists only the
   * business record/receipt; never grants conversation or memory retention. */
  localEffectScope(handle: ScopeHandle): ScopeHandle {
    const current = this.require(handle, 'local:write');
    if (current.child || current.subjectId !== current.principalId || current.worldId !== 'real' || current.audience !== 'self' || !current.sources.includes('local-agenda'))
      throw new HarnessError('effect_scope_forbidden', '当前范围不能执行这项本人本地操作。');
    return this.mint({ ...current, sources: ['local-agenda'], currentEventIds: [],
      grants: current.grants.filter(grant => ['local:write', 'evidence:read'].includes(grant)),
      retention: 'purpose_scoped', infer: false });
  }
  /** Host-only, temporary purpose grant under an existing campus connection. */
  campusPurposeScope(handle: ScopeHandle, grant: string) {
    const current = this.require(handle, 'campus:read');
    const allowed = ['campus:grades:read', 'campus:gpa:read', 'campus:reservations:read', 'campus:card:read', 'campus:transactions:read', 'campus:profile:read'];
    if (!allowed.includes(grant) || this.revoked().includes(grant) || current.subjectId !== current.principalId || current.worldId !== 'real' || current.audience !== 'self')
      throw new HarnessError('forbidden', '这项资料不在当前可授权范围内。');
    return this.mint({ ...current, grants: [...new Set([...current.grants, grant])] });
  }
  registerSource(id: string) {
    this.repo.write(() =>
      this.repo.setMeta('registered_sources', [
        ...new Set([...this.repo.getMeta<string[]>('registered_sources', []), id]),
      ]),
    );
  }
  ingress(
    text: string,
    eventId: string,
    settings: { memoryEnabled: boolean; weatherEnabled: boolean; timeZone?: string },
    controls: InputControls = {},
  ): IngressDecision {
    // Existing renderer embeds text attachments. The typed field takes precedence; the legacy boundary is conservative.
    const { attachment, authoredText } = splitUserInput(text, eventId, controls.attachment);
    const control = controls.semantic;
    if (controls.enhancements && process.env.ZAICHANG_TEST !== '1') throw new HarnessError('test_only', '消融开关只用于隔离评估。');
    const timeZone = controls.timeZone || settings.timeZone || 'Asia/Shanghai';
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new HarnessError('time_zone', '时区设置不正确，请选择有效时区。'); }
    const localOnly = controls.transmission === 'local_only' || localCloudRestriction(authoredText) || (!!attachment && hasCredentials(attachment.text));
    const temporary = localOnly || control?.uncertainControls.some(c => c.dimension === 'retention') || controls.retention === 'session_only' || controls.memoryMode === 'session_only' || control?.retention === 'session_only' || isEphemeral(authoredText);
    const retention = temporary ? 'session_only'
      : controls.retention === 'history_no_inference' || control?.retention === 'history_no_inference' ? 'history_no_inference'
      : controls.retention || 'purpose_scoped';
    const other = control?.subject === 'other' || control?.subject === 'unknown';
    const fictional = control?.subject === 'fictional';
    const scenario = control?.world === 'hypothetical' || control?.world === 'unknown';
    const audience = controls.audience || (controls.replyToOwner ? 'self' : control?.audience) || 'self';
    const sourceOnly = control?.sources === 'current_only' || control?.uncertainControls.some(c => c.dimension === 'sources' || c.dimension === 'audience') || other || fictional || scenario || audience !== 'self';
    const subjectId = controls.subjectId || (other ? 'other:' + eventId : fictional ? 'fictional:' + eventId : this.repo.identity.principalId);
    const worldId = controls.worldId || (scenario ? 'scenario:' + eventId : 'real');
    const memoryMode = temporary ? 'session_only'
      : sourceOnly || controls.memoryMode === 'current_sources_only' ? 'current_sources_only'
      : controls.memoryMode || (!settings.memoryEnabled ? 'none' : 'relevant');
    let sources = memoryMode === 'current_sources_only' || sourceOnly ? ['current'] : [...baseSources];
    if (memoryMode === 'none') sources = sources.filter(source => !['profile:self', 'history:self'].includes(source));
    // Plugin sources are added through registered_sources. The Agent must not
    // reserve a built-in weather source; optional features become visible only
    // after their provider is installed and registered by PluginManager.
    if (!sourceOnly && memoryMode !== 'current_sources_only') sources.push(...this.repo.getMeta<string[]>('registered_sources', []));
    if (control?.sourceAllowlist) sources = sources.filter(source => source === 'current' || control.sourceAllowlist!.includes(source));
    if (control?.sourceExclusions.length) sources = sources.filter(source => source === 'current' || !control.sourceExclusions.includes(source));
    if (controls.sources) sources = sources.filter(source => controls.sources!.includes(source));
    const threadContextAllowed = scenario && !other && !fictional && audience === 'self' && settings.memoryEnabled
      && !['none', 'current_sources_only'].includes(controls.memoryMode || '')
      && (!controls.sources || controls.sources.includes('history:self'))
      && (!control?.sourceAllowlist || control.sourceAllowlist.includes('history:self'))
      && !control?.sourceExclusions.includes('history:self')
      && !control?.uncertainControls.some(item => item.dimension === 'sources' || item.dimension === 'audience');
    if (threadContextAllowed) sources.push('history:self');
    const purpose = controls.purpose || (audience !== 'self' ? 'outbound_draft' : sourceOnly && !threadContextAllowed ? 'analyze_document' : 'personal_assistance');
    const grants = this.grants().filter(grant => !this.revoked().includes(grant));
    // Capabilities are connection/policy facts. A control may restrict sensitive
    // sources or effects; tone, brevity and lexical intent never remove tools.
    const restrictedGrants = grants.filter(grant =>
      (subjectId === this.repo.identity.principalId && worldId === 'real' && audience === 'self' && !sourceOnly)
      || grant === 'evidence:read');
    const scope = this.hostScope({
      sources: [...new Set(sources)], currentEventIds: [eventId, ...(attachment ? [attachment.id] : [])],
      subjectId, worldId, audience, retention, purposes: [purpose], grants: restrictedGrants,
      infer: memoryMode === 'relevant' && retention === 'purpose_scoped' && settings.memoryEnabled && !sourceOnly && control?.subject !== 'mixed' && control?.subject !== 'none' && control?.world !== 'mixed',
    });
    const interpretation: InterpretationProposal = { fragments: [], hasListen: false, hasRetrieval: false, explicitLocalWrite: false, directLocalWrite: false };
    const contract: ContextContract = {
      id: randomUUID(), revision: 1, scope, subjectId, worldId, memoryMode, retention, audience, purpose,
      enhancements: controls.enhancements,
      interactionMode: 'analyze', actionMode: control?.actionsApplyToWholeTurn && (control.actions === 'none' || control.actions === 'draft_only') ? 'respond' : 'propose',
      exploration: false, privacyEpoch: this.repo.epoch, policyRevision: this.repo.policyRevision,
      timeZone, now: this.repo.clock.now(),
      budget: { maxTokens: 24000, maxRows: 200, maxReadBytes: 160000, toolCalls: 20, modelCalls: 20, dependencyDepth: 8, ...controls.budget },
      excludedReasons: [...(sourceOnly ? ['current_sources_only'] : []), ...(other ? ['other_subject'] : []), ...(audience !== 'self' ? ['audience_projection'] : []), ...(temporary ? ['no_retention'] : [])],
      temporalAmbiguities: [], resolvedDates: [], interpretation,
    };
    const projectionSources = subjectId === this.repo.identity.principalId && worldId === 'real' && control?.release?.useAvailability && control.sources !== 'current_only' &&
      controls.memoryMode !== 'current_sources_only' && !control.uncertainControls.some(c => c.dimension === 'sources')
      ? ['campus:local', 'campus:zju-account', 'local-agenda'].filter(source => (!controls.sources || controls.sources.includes(source)) && !control.sourceExclusions.includes(source) && (!control.sourceAllowlist || control.sourceAllowlist.includes(source))) : [];
    return { text, authoredText, attachment, contract, restriction: false, scenario, localOnly, threadContextAllowed, replyToOwner: controls.replyToOwner, controlFallback: controls.controlFallback, controlProposal: control, priorReleaseArtifacts: controls.priorReleaseArtifacts, releaseBrief: control?.release, priorReleasedDraft: controls.priorReleasedDraft, projectionSources, requiresReadPurpose: control?.subject === 'mixed' || control?.world === 'mixed',
      speechActs: [], interpretation, requestFragments: [], corrections: [] };

  }
}
export function isEphemeral(text: string) {
  return /(?:只用于|仅用于|只用在|只用|仅限|仅).*本轮.*(?:不保存|不记录)|(?:这段|这句|本轮|此轮|临时).*不保存|不要保存这段|临时模式|session.only|do not (?:save|store)|don't (?:save|store)/i.test(
    authoredControls(text),
  );
}
