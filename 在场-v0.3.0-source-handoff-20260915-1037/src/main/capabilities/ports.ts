import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  always,
  conditionSchema,
  HarnessError,
  instant,
  labelSchema,
  locatorSchema,
  objectId,
  personalLabel,
  type Condition,
  type EvidenceEvent,
  type ScopeHandle,
} from '../../shared/harness';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel } from '../runtime/policy';
import type { WorkService } from '../runtime/work';
import type { DomainService } from '../storage/domains';
import type { ReminderRuntime } from '../actions/reminders';
import { evaluateCondition } from '../runtime/semantics';

export const observationSchema = z
  .object({
    id: objectId,
    sourceId: objectId,
    kind: z.enum(['media', 'notice', 'learning', 'wellness', 'feedback']),
    version: z.number().int().positive(),
    locator: locatorSchema,
    text: z.string().max(30000),
    label: labelSchema,
    quality: z.enum(['verified', 'unverified', 'low', 'missing']),
    data: z.record(z.string(), z.json()),
  })
  .strict();
export const learningSchema = z
  .object({
    taskRef: objectId,
    skillRefs: z.array(objectId).max(32),
    assistance: z.enum(['independent', 'hint', 'answer_seen', 'ai_assisted']),
    exposedRefs: z.array(objectId).max(100),
    independentSteps: z.array(z.string().max(500)).max(100),
    comparability: z.enum(['comparable', 'not_comparable', 'unknown']),
    occurredAt: instant,
  })
  .strict();
export const feedbackSchema = z
  .object({
    recommendationId: objectId,
    exposure: z.enum(['shown', 'not_shown', 'unknown']),
    response: z.enum(['accepted', 'declined', 'not_observed']),
    explicitReason: z.string().max(1200).optional(),
    outcomeRef: objectId.optional(),
    missingness: z.enum(['known', 'not_observed', 'unavailable']),
    contextRevision: z.number().int().positive(),
  })
  .strict();
export const wellnessSchema = z
  .object({
    measureType: z.string().max(80),
    value: z.number().optional(),
    unit: z.string().max(40).optional(),
    sourceDevice: objectId,
    observationWindow: z.tuple([instant, instant]),
    quality: z.enum(['measured', 'estimated', 'missing']),
    requestedAccommodation: z.string().max(600).optional(),
  })
  .strict();
export class ObservationPort {
  private transient = new Map<string, { event: EvidenceEvent; expiresAt: number }>();
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
    readonly work: WorkService,
    readonly domains: DomainService,
  ) {
    policy.onBarrier(() => this.transient.clear());
  }
  ingest(handle: ScopeHandle, raw: unknown, review: { verifiedSource: boolean } = { verifiedSource: false }) {
    const s = this.policy.validate(handle),
      input = observationSchema.parse(raw);
    if (!s.sources.includes(input.sourceId))
      throw new HarnessError('source_forbidden', '这份观察不在当前允许的来源中。');
    if (input.quality === 'verified' && !review.verifiedSource)
      throw new HarnessError('source_not_verified', '外部正文不能自行声明官方验证。');
    if (input.kind === 'learning') learningSchema.parse(input.data);
    if (input.kind === 'feedback') feedbackSchema.parse(input.data);
    if (input.kind === 'wellness') wellnessSchema.parse(input.data);
    const old = this.read(handle, input.id);
    if (old && input.version !== old.version + 1)
      throw new HarnessError('observation_version', '观察版本不连续，需要重新读取。');
    const event: EvidenceEvent = {
      id: input.id + ':v' + input.version,
      ownerId: s.principalId,
      workspaceId: s.workspaceId,
      subjectId: s.subjectId,
      worldId: s.worldId,
      sourceId: input.sourceId,
      contentVersion: input.version,
      sequence: 0,
      text: input.text,
      speaker: 'external',
      kind: 'external_observation',
      authority: review.verifiedSource ? 'source_record' : 'quotation',
      roots: old?.roots || [input.id],
      label: { ...input.label, infer: false },
      receivedAt: this.repo.clock.now(),
      status: 'active',
      locator: input.locator,
    };
    if (input.label.retention === 'session_only' || input.label.sensitivity === 'restricted') {
      if (input.kind === 'wellness') this.policy.require(handle, 'health:use');
      this.transient.set(input.id, { event, expiresAt: Date.parse(this.repo.clock.now()) + 1800000 });
      return {
        id: input.id,
        version: input.version,
        status: 'ephemeral_only',
        storageProtection: 'at_rest_unavailable',
      };
    }
    this.repo.write(() => {
      const saved = this.repo.ingest(handle, event),
        payload = {
          ...input,
          evidenceId: saved.id,
          roots: event.roots,
          status: input.quality === 'verified' ? 'verified' : 'pending',
        };
      if (old) {
        this.repo.invalidate(old.evidenceId, 'observation_corrected');
        this.repo.db
          .prepare('INSERT OR REPLACE INTO h_source_restrictions VALUES(?,?,?,?)')
          .run(old.evidenceId, '*', 'CORRECT', saved.id);
      }
      this.repo.db
        .prepare(
          `INSERT INTO h_observations VALUES(${Array(17).fill('?').join(',')}) ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,evidence_id=excluded.evidence_id,payload=excluded.payload`,
        )
        .run(
          input.id,
          s.principalId,
          s.workspaceId,
          s.subjectId,
          s.worldId,
          input.sourceId,
          input.label.purpose,
          input.label.audience,
          input.label.sensitivity,
          input.label.retention,
          0,
          input.label.expiresAt || null,
          input.kind,
          input.version,
          payload.status,
          saved.id,
          JSON.stringify(payload),
        );
      this.repo.db
        .prepare('INSERT INTO h_observation_versions VALUES(?,?,?)')
        .run(input.id, input.version, JSON.stringify(payload));
      this.repo.indexEvidence(handle, saved.id);
      this.repo.outbox('observation_changed', input.id);
    });
    return this.read(handle, input.id);
  }
  read(handle: ScopeHandle, id: string): any | undefined {
    const s = this.policy.validate(handle),
      ephemeral = this.transient.get(id);
    if (
      ephemeral &&
      ephemeral.expiresAt > Date.parse(this.repo.clock.now()) &&
      ephemeral.event.subjectId === s.subjectId &&
      ephemeral.event.worldId === s.worldId &&
      s.sources.includes(ephemeral.event.sourceId) &&
      s.grants.includes('health:use')
    )
      return {
        ...ephemeral.event,
        id,
        version: ephemeral.event.contentVersion,
        evidenceId: ephemeral.event.id,
      };
    const f = this.repo.filter(handle);
    const row = this.repo.db
      .prepare(`SELECT r.payload FROM h_observations r WHERE ${f.sql} AND r.id=? AND r.status!='deleted'`)
      .get(...f.params, id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  list(handle: ScopeHandle, kind: string) {
    const f = this.repo.filter(handle);
    return this.repo.db
      .prepare(
        `SELECT r.payload FROM h_observations r WHERE ${f.sql} AND r.kind=? AND r.status!='deleted' LIMIT 100`,
      )
      .all(...f.params, kind)
      .map((r) => JSON.parse(String(r.payload)));
  }
  learningProjection(handle: ScopeHandle, taskRef: string) {
    const observations = this.list(handle, 'learning').filter((o) => o.data.taskRef === taskRef);
    const independent = observations.filter(
      (o) =>
        o.data.assistance === 'independent' &&
        o.data.comparability === 'comparable' &&
        o.data.independentSteps.length,
    );
    return {
      taskRef,
      observations: observations.map((o) => ({
        assistance: o.data.assistance,
        independentSteps: o.data.independentSteps,
        exposedRefs: o.data.exposedRefs,
        evidenceId: o.evidenceId,
      })),
      independentPerformance: independent.length ? 'observed' : 'unknown',
      mastery: 'not_established',
    };
  }
  feedbackProjection(handle: ScopeHandle, id: string) {
    const observation = this.read(handle, id);
    if (!observation || observation.kind !== 'feedback')
      throw new HarnessError('feedback_missing', '缺少反馈依据。');
    return {
      recommendationId: observation.data.recommendationId,
      response: observation.data.response,
      explicitReason: observation.data.explicitReason,
      outcome: observation.data.outcomeRef ? 'reported_outcome' : observation.data.missingness,
      causalSuccess: 'not_established',
    };
  }
  reviewNotice(
    handle: ScopeHandle,
    id: string,
    change: {
      domain: string;
      recordId: string;
      institutionId: string;
      termId: string;
      value: Record<string, any>;
    },
    review: { verified: boolean },
  ) {
    const notice = this.read(handle, id);
    if (!notice || notice.kind !== 'notice' || notice.quality !== 'verified' || !review.verified)
      throw new HarnessError('notice_not_verified', '通知尚未核实，不能改写业务事实。');
    return this.domains.apply(handle, {
      sourceId: notice.sourceId,
      domain: change.domain,
      institutionId: change.institutionId,
      termId: change.termId,
      scopeKeys: [change.recordId],
      completeness: 'partial',
      upserts: [
        {
          recordId: change.recordId,
          value: { ...change.value, scopeKey: change.recordId },
          evidenceId: notice.evidenceId,
        },
      ],
      tombstones: [],
      fetchedAt: this.repo.clock.now(),
      errors: [],
    });
  }
  correctTranscript(handle: ScopeHandle, id: string, version: number, text: string) {
    const old = this.read(handle, id);
    if (!old || old.kind !== 'media' || old.locator.kind !== 'audio')
      throw new HarnessError('media_missing', '没有可更正的音频定位。');
    return this.ingest(handle, {
      id,
      sourceId: old.sourceId,
      kind: 'media',
      version,
      locator: { ...old.locator, version, transcriptVersion: version },
      text,
      label: old.label,
      quality: 'unverified',
      data: { ...old.data, correctionConfirmedByUser: true },
    });
  }
}

const syncOperationSchema = z
  .object({
    deviceId: objectId,
    operationId: objectId,
    objectId: objectId,
    baseRevision: z.number().int().positive(),
    policyEpoch: z.number().int().positive(),
    causalReferences: z.array(objectId).max(100),
    createdAt: instant,
    delta: z
      .object({
        operation: z.enum(['edit_work', 'propose_external_action']),
        status: z.string().max(50).optional(),
        title: z.string().max(400).optional(),
        data: z.record(z.string(), z.json()).optional(),
      })
      .strict(),
  })
  .strict();
export interface DeviceHandle {
  readonly id: string;
}
export class SyncPort {
  private devices = new WeakMap<DeviceHandle, { id: string; online: boolean }>();
  readonly rejected: { deviceId: string; operationId: string; code: string }[] = [];
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
    readonly work: WorkService,
  ) {}
  registerTrustedDevice(id: string, online = true): DeviceHandle {
    const handle = Object.freeze({ id: randomUUID() });
    this.devices.set(handle, { id, online });
    return handle;
  }
  submit(handle: ScopeHandle, device: DeviceHandle, raw: unknown) {
    const s = this.policy.validate(handle),
      actor = this.devices.get(device),
      operation = syncOperationSchema.parse(raw);
    if (!actor || actor.id !== operation.deviceId)
      throw new HarnessError('untrusted_device', '设备身份未通过宿主验证。');
    const prior = this.repo.db
      .prepare('SELECT result FROM h_sync_operations WHERE device_id=? AND operation_id=?')
      .get(actor.id, operation.operationId);
    if (prior) return JSON.parse(String(prior.result));
    let result: any;
    try {
      if (operation.policyEpoch !== this.repo.epoch)
        throw new HarnessError('stale_epoch', '设备提案早于最新隐私屏障。');
      if (this.repo.hasFence(operation.objectId))
        throw new HarnessError('deleted_object', '被删除的对象不能通过同步恢复。');
      if (operation.delta.operation === 'propose_external_action')
        throw new HarnessError(
          actor.online ? 'approval_required' : 'offline_unsafe',
          '同步只保留提案，不能直接执行外部动作。',
        );
      const old = this.repo.work(handle).find((o) => o.id === operation.objectId);
      if (!old) throw new HarnessError('object_missing', '同步对象不存在。');
      if (old.status === 'cancelled')
        throw new HarnessError('cancelled_object', '已取消目标不能由旧设备重新激活。');
      const updated = this.work.update(handle, old.id, operation.baseRevision, {
        ...(operation.delta.title ? { title: operation.delta.title } : {}),
        ...(operation.delta.status ? { status: operation.delta.status } : {}),
        ...(operation.delta.data ? { data: { ...old.data, ...operation.delta.data } } : {}),
      });
      result = {
        accepted: true,
        objectId: updated.id,
        revision: updated.revision,
        privacyEpoch: this.repo.epoch,
      };
    } catch (error) {
      const code = error instanceof HarnessError ? error.code : 'invalid_proposal';
      this.rejected.push({ deviceId: actor.id, operationId: operation.operationId, code });
      result = { accepted: false, code, privacyEpoch: this.repo.epoch };
    }
    this.repo.write(() =>
      this.repo.db
        .prepare('INSERT INTO h_sync_operations VALUES(?,?,?,?,?,?,?)')
        .run(
          actor.id,
          operation.operationId,
          operation.objectId,
          operation.baseRevision,
          operation.policyEpoch,
          result.accepted ? 'accepted' : 'rejected',
          JSON.stringify(result),
        ),
    );
    return result;
  }
}

export const rulePackSchema = z
  .object({
    id: objectId,
    institutionId: objectId,
    termId: objectId,
    cohortScope: z.array(z.string().max(80)).min(1).max(100),
    validFrom: instant,
    validTo: instant,
    sourceId: objectId,
    sourceRevision: z.string().max(100),
    rules: z
      .array(z.object({ id: objectId, predicate: objectId, value: z.record(z.string(), z.json()) }).strict())
      .max(500),
  })
  .strict();
export class RulePackPort {
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
    readonly domains: DomainService,
  ) {}
  register(handle: ScopeHandle, raw: unknown, review: { approved: boolean }) {
    if (!review.approved) throw new HarnessError('rule_review_required', '学校规则需要核实来源与版本。');
    const pack = rulePackSchema.parse(raw),
      s = this.policy.validate(handle);
    if (!s.sources.includes(pack.sourceId)) throw new HarnessError('source_forbidden', '未授权规则来源。');
    const eid = pack.id + ':' + pack.sourceRevision;
    this.repo.ingest(handle, {
      id: eid,
      ownerId: s.principalId,
      workspaceId: s.workspaceId,
      subjectId: s.subjectId,
      worldId: s.worldId,
      sourceId: pack.sourceId,
      contentVersion: 1,
      text: JSON.stringify(pack),
      speaker: 'external',
      kind: 'external_observation',
      authority: 'source_record',
      roots: [eid],
      label: { ...personalLabel, infer: false, expiresAt: pack.validTo },
      receivedAt: this.repo.clock.now(),
      status: 'active',
    });
    return this.domains.apply(handle, {
      sourceId: pack.sourceId,
      domain: 'institution_rules',
      institutionId: pack.institutionId,
      termId: pack.termId,
      scopeKeys: [pack.id],
      completeness: 'complete',
      sourceRevision: pack.sourceRevision,
      upserts: pack.rules.map((r) => ({
        recordId: r.id,
        value: {
          ...r.value,
          predicate: r.predicate,
          scopeKey: pack.id,
          cohortScope: pack.cohortScope,
          validFrom: pack.validFrom,
          validTo: pack.validTo,
        },
        evidenceId: eid,
      })),
      tombstones: [],
      fetchedAt: this.repo.clock.now(),
      errors: [],
    });
  }
  applicable(handle: ScopeHandle, institutionId: string, termId: string, cohort?: string) {
    const records = this.domains.read(handle, 'institution_rules', { institutionId, termId });
    if (!cohort) return { status: 'applicability_unknown', records: [] };
    return {
      status: 'fresh',
      records: records.filter(
        (r) =>
          (r.value.cohortScope as string[]).includes(cohort) &&
          Date.parse(String(r.value.validFrom)) <= Date.parse(this.repo.clock.now()) &&
          Date.parse(String(r.value.validTo)) > Date.parse(this.repo.clock.now()),
      ),
    };
  }
}

const watchSchema = z
  .object({
    id: objectId,
    goalId: objectId,
    eventCategory: z.string().max(80),
    actionableUntil: instant,
    condition: conditionSchema,
    channel: z.literal('local_notification'),
    title: z.string().max(160),
  })
  .strict();
export class WatchPort {
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
    readonly reminders: ReminderRuntime,
  ) {}
  create(handle: ScopeHandle, raw: unknown) {
    const s = this.policy.validate(handle),
      watch = watchSchema.parse(raw),
      goal = this.repo.work(handle, 'goal').find((g) => g.id === watch.goalId);
    if (!goal || goal.status !== 'active')
      throw new HarnessError('inactive_goal', '主动检查必须关联仍有效的目标。');
    this.repo.write(() => {
      this.repo.db
        .prepare('INSERT INTO h_watches VALUES(?,?,?,?,?,?,?,?)')
        .run(
          watch.id,
          s.principalId,
          s.workspaceId,
          watch.goalId,
          'active',
          s.privacyEpoch,
          null,
          JSON.stringify(watch),
        );
      this.repo.addDependency(handle, {
        consumerId: watch.id,
        producerId: watch.goalId,
        producerRevision: goal.revision,
        sensitivity: 'hard',
        invalidation: 'block',
      });
    });
    return watch;
  }
  signal(
    handle: ScopeHandle,
    input: { category: string; noveltyKey: string; facts: Record<string, any>; evidenceId: string },
  ) {
    const s = this.policy.validate(handle);
    if (!this.repo.evidence(handle, input.evidenceId))
      throw new HarnessError('evidence_missing', '主动提醒缺少新依据。');
    const candidates = [];
    for (const row of this.repo.db
      .prepare(
        "SELECT w.* FROM h_watches w JOIN h_work g ON g.id=w.goal_id WHERE w.owner=? AND w.workspace=? AND w.status='active' AND g.status='active' AND w.epoch=?",
      )
      .all(s.principalId, s.workspaceId, s.privacyEpoch)) {
      const watch = watchSchema.parse(JSON.parse(String(row.payload)));
      if (
        watch.eventCategory !== input.category ||
        Date.parse(watch.actionableUntil) <= Date.parse(this.repo.clock.now()) ||
        row.novelty_key === input.noveltyKey ||
        evaluateCondition(watch.condition, input.facts) !== 'true'
      )
        continue;
      const action = {
        id: watch.id + ':' + input.noveltyKey,
        title: watch.title,
        detail: '新信息与目标仍相关，留有行动窗口。',
        startsAt: this.repo.clock.now(),
      };
      this.reminders.schedule(action, watch.goalId, watch.actionableUntil);
      this.repo.write(() => {
        this.repo.db.prepare('UPDATE h_watches SET novelty_key=? WHERE id=?').run(input.noveltyKey, watch.id);
        this.repo.addDependency(handle, {
          consumerId: action.id,
          producerId: input.evidenceId,
          producerRevision: 1,
          sensitivity: 'privacy',
          invalidation: 'block',
        });
      });
      candidates.push(action.id);
    }
    return candidates;
  }
}
export class StorageProtectionPort {
  readonly capabilities = {
    atRest: false,
    fieldLevel: false,
    searchableFields: 'plaintext',
    backupMode: 'local_with_privacy_barrier',
    keyRecovery: 'platform_credentials_only',
    secureDeleteLimits: 'Cannot erase copies outside the app or physical disk remnants',
  };
  requireAtRest() {
    throw new HarnessError('unsupported_protection', '整库加密尚未接入，受限资料只用于本轮。');
  }
}

export class EntityPort {
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
  ) {}
  register(
    handle: ScopeHandle,
    entities: { id: string; aliases: string[]; institutionId: string; role?: string; sourceId: string }[],
  ) {
    const s = this.policy.require(handle, 'work:write');
    this.repo.write(() => {
      for (const entity of entities) {
        if (!s.sources.includes(entity.sourceId))
          throw new HarnessError('source_forbidden', '实体来源不可用。');
        for (const alias of entity.aliases) {
          objectId.parse(alias);
          this.repo.db
            .prepare('INSERT OR IGNORE INTO h_aliases VALUES(?,?,?,?,?,?,?)')
            .run(
              entity.id,
              alias,
              s.principalId,
              s.workspaceId,
              entity.institutionId,
              entity.role || '',
              entity.sourceId,
            );
        }
      }
    });
  }
  resolve(handle: ScopeHandle, text: string, institutionId: string) {
    const s = this.policy.validate(handle);
    const rows = this.repo.db
      .prepare(
        `SELECT entity_id AS entityId,alias AS label,role FROM h_aliases WHERE owner=? AND workspace=? AND institution=? AND source IN (${s.sources.map(() => '?').join(',') || 'NULL'}) AND instr(?,alias)>0`,
      )
      .all(s.principalId, s.workspaceId, institutionId, ...s.sources, text);
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) grouped.set(String(row.label), [...(grouped.get(String(row.label)) || []), row]);
    return [...grouped.values()].flatMap((group) => {
      if (group.length === 1) return group.map((r) => ({ ...r, status: 'resolved' }));
      const qualified = group.filter(
        (r) => String(r.role) && text.includes(String(r.role).replace(/朋友|搭档|同学/g, '')),
      );
      return (qualified.length === 1 ? qualified : group).map((r) => ({
        ...r,
        status: qualified.length === 1 ? 'resolved' : 'ambiguous',
      }));
    });
  }
}
