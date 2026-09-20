import { createHash, randomUUID } from 'node:crypto';
import type { Action } from '../../shared/types';
import {
  effectSchema,
  HarnessError,
  type Approval,
  type Dependency,
  type EffectAction,
  type EffectReceipt,
  type ScopeHandle,
} from '../../shared/harness';
import type { KernelRepository } from '../storage/repository';
import type { PolicyKernel } from '../runtime/policy';
import type { CapabilityBroker, CapabilityResult } from '../capabilities/broker';
import { canonical } from '../runtime/semantics';
import type { LocalEffectResult } from './local-calendar';

export class ActionRuntime {
  private inFlight = new Map<string, Promise<EffectReceipt>>();
  beforeDispatch?: () => Promise<void>;
  afterDispatch?: () => void;
  constructor(
    readonly repo: KernelRepository,
    readonly policy: PolicyKernel,
    readonly broker: CapabilityBroker,
    private localWrite: (action: Action, effect?: EffectAction) => void | LocalEffectResult,
    private localUndo?: (effect: EffectAction) => void,
  ) {
    // A terminated process cannot know whether a dispatched external effect succeeded.
    repo.write(() => {
      for (const row of repo.db
        .prepare("SELECT payload FROM h_actions WHERE status IN ('dispatching','reconciling')")
        .all()) {
        const action = JSON.parse(String(row.payload)) as EffectAction;
        action.status = 'outcome_unknown';
        action.reason = 'interrupted_after_dispatch';
        this.put(action);
        repo.db
          .prepare(
            "UPDATE h_attempts SET status='outcome_unknown' WHERE action_id=? AND status='dispatching'",
          )
          .run(action.id);
      }
    });
  }
  digest(
    action: Pick<
      EffectAction,
      'capability' | 'arguments' | 'audience' | 'revision' | 'worldId' | 'validUntil' | 'dependencies'
    >,
  ) {
    return createHash('sha256').update(canonical(action)).digest('hex');
  }
  prepare(
    handle: ScopeHandle,
    input: {
      id?: string;
      capability: string;
      arguments: Record<string, any>;
      audience?: string;
      sourceId?: string;
      goalId?: string;
      dependencies?: Dependency[];
      validUntil?: string;
    },
  ): EffectAction {
    const scope = this.policy.validate(handle),
      cap = this.broker.describe(input.capability);
    if (!cap || cap.effect === 'read') throw new HarnessError('unsupported_action', '这项动作尚未接入。');
    if (scope.retention === 'session_only' || scope.worldId !== 'real')
      throw new HarnessError('draft_only', '本轮仅可比较草稿，不能创建持久动作。');
    const existing = input.id ? this.get(handle, input.id) : undefined;
    if (existing) {
      if (existing.capability !== input.capability || canonical(existing.arguments) !== canonical(this.broker.validateArguments(input.capability, input.arguments)))
        throw new HarnessError('idempotency_conflict', '同一动作标识对应的参数已改变，需要核对原结果或准备明确修改。');
      return existing;
    }
    const action: EffectAction = {
      id: input.id || randomUUID(),
      ownerId: scope.principalId,
      workspaceId: scope.workspaceId,
      subjectId: scope.subjectId,
      worldId: scope.worldId,
      revision: 1,
      capability: input.capability,
      arguments: this.broker.validateArguments(
        input.capability,
        input.arguments,
      ) as EffectAction['arguments'],
      audience: input.audience || 'self',
      status: 'awaiting_approval',
      digest: '',
      idempotencyKey: randomUUID(),
      dependencies: input.dependencies || [],
      validUntil: input.validUntil || new Date(Date.parse(this.repo.clock.now()) + 86400000).toISOString(),
      policyRevision: scope.policyRevision,
      privacyEpoch: scope.privacyEpoch,
      effect: cap.effect,
      // The tier is descriptive until the trusted host explicitly calls
      // directLocal(). External effects never qualify, even when reversible.
      executionTier: cap.effect === 'local_write' && cap.supportsCancel ? 'direct_local' : 'approval_required',
      sourceId: input.sourceId || cap.sourceId,
      goalId: input.goalId,
      simulated: cap.simulated,
    };
    action.digest = this.digest({
      capability: action.capability,
      arguments: action.arguments,
      audience: action.audience,
      revision: action.revision,
      worldId: action.worldId,
      validUntil: action.validUntil,
      dependencies: action.dependencies,
    });
    effectSchema.parse(action);
    // Proposal, dependencies and outbox commit together, before any provider is called.
    this.repo.write(() => {
      this.repo.db
        .prepare('INSERT INTO h_actions VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          action.id,
          action.ownerId,
          action.workspaceId,
          action.subjectId,
          action.worldId,
          action.revision,
          action.status,
          action.goalId || null,
          action.sourceId,
          JSON.stringify(action),
        );
      for (const d of action.dependencies) this.repo.addDependency(handle, { ...d, consumerId: action.id });
      if (action.goalId)
        this.repo.addDependency(handle, {
          consumerId: action.id,
          producerId: action.goalId,
          producerRevision: this.workRevision(action.goalId),
          sensitivity: 'hard',
          invalidation: 'block',
        });
      for (const grant of cap.requiredScopes)
        this.repo.addDependency(handle, {
          consumerId: action.id,
          producerId: 'grant:' + grant,
          producerRevision: scope.policyRevision,
          sensitivity: 'privacy',
          invalidation: 'block',
        });
      this.repo.outbox('action_prepared', action.id);
    });
    this.repo.transitions.push({
      at: this.repo.clock.now(),
      objectId: action.id,
      to: action.status,
      revision: 1,
    });
    return action;
  }
  /**
   * Execute an explicitly host-authorized, parameter-complete, reversible
   * local registration without forcing a second confirmation card. This is
   * intentionally separate from model/tool input; callers must opt in from a
   * trusted UI or host path. External or non-reversible effects remain on the
   * normal digest-bound approval path.
   */
  async directLocal(
    handle: ScopeHandle,
    input: {
      id?: string;
      capability: string;
      arguments: Record<string, any>;
      audience?: string;
      sourceId?: string;
      goalId?: string;
      dependencies?: Dependency[];
      validUntil?: string;
      authorized: true;
    },
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ action: EffectAction; approval: Approval; receipt: EffectReceipt }> {
    if (input.authorized !== true) throw new HarnessError('approval_required', '本地直接登记需要明确确认。');
    const capability = this.broker.describe(input.capability);
    if (!capability || capability.effect !== 'local_write' || !capability.supportsCancel)
      throw new HarnessError('approval_required', '这项动作仍需具体确认后才能执行。');
    const action = this.prepare(handle, input);
    if (action.executionTier !== 'direct_local')
      throw new HarnessError('approval_required', '这项动作仍需具体确认后才能执行。');
    // prepare() has already validated the full argument schema and source;
    // approve() repeats the policy/epoch checks immediately before dispatch.
    const approval = this.approve(handle, action.id, action.digest, action.revision);
    const receipt = await this.execute(handle, action.id, approval.id, signal);
    return { action: this.get(handle, action.id) || action, approval, receipt };
  }
  private workRevision(id: string) {
    return Number(this.repo.db.prepare('SELECT revision FROM h_work WHERE id=?').get(id)?.revision || 0);
  }
  private put(action: EffectAction) {
    this.repo.db
      .prepare('UPDATE h_actions SET revision=?,status=?,payload=? WHERE id=?')
      .run(action.revision, action.status, JSON.stringify(action), action.id);
  }
  get(handle: ScopeHandle, id: string): EffectAction | undefined {
    const s = this.policy.validate(handle),
      row = this.repo.db
        .prepare(
          'SELECT payload FROM h_actions WHERE id=? AND owner=? AND workspace=? AND subject=? AND world=? AND source IN (SELECT value FROM json_each(?))',
        )
        .get(id, s.principalId, s.workspaceId, s.subjectId, s.worldId, JSON.stringify(s.sources));
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  list(handle: ScopeHandle): EffectAction[] {
    const s = this.policy.validate(handle);
    return this.repo.db
      .prepare(
        'SELECT payload FROM h_actions WHERE owner=? AND workspace=? AND subject=? AND world=? AND source IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC',
      )
      .all(s.principalId, s.workspaceId, s.subjectId, s.worldId, JSON.stringify(s.sources))
      .map((r) => JSON.parse(String(r.payload)));
  }
  cancelPendingFromSources(sourceIds: string[]) {
    if (!sourceIds.length) return;
    this.repo.write(() => {
      const rows = this.repo.db.prepare(`SELECT a.id,a.payload FROM h_actions a WHERE a.owner=? AND a.workspace=?
        AND a.status IN ('proposed','awaiting_approval','approved')
        AND EXISTS(SELECT 1 FROM h_dependencies d WHERE d.consumer_id=a.id AND d.producer_id IN (SELECT value FROM json_each(?)))`)
        .all(this.repo.identity.principalId, this.repo.identity.workspaceId, JSON.stringify(sourceIds));
      for (const row of rows) {
        const action = JSON.parse(String(row.payload)) as EffectAction;
        action.status = 'cancelled'; action.reason = 'parent_run_cancelled'; this.put(action);
        this.repo.db.prepare("UPDATE h_jobs SET status='cancelled',fence=fence+1 WHERE object_id=?").run(action.id);
      }
    });
  }
  revise(
    handle: ScopeHandle,
    id: string,
    expectedRevision: number,
    args: Record<string, any>,
    audience?: string,
  ) {
    const action = this.get(handle, id);
    if (!action) throw new HarnessError('action_missing', '动作不存在。');
    if (action.revision !== expectedRevision)
      throw new HarnessError('revision_conflict', '动作内容已更新，请重新查看。');
    if (['dispatching', 'outcome_unknown', 'succeeded', 'reconciling'].includes(action.status))
      throw new HarnessError('effect_already_dispatched', '该动作已派发，请先核查或取消。');
    const next = {
      ...action,
      arguments: args,
      audience: audience || action.audience,
      revision: action.revision + 1,
      status: 'awaiting_approval' as const,
      privacyEpoch: this.repo.epoch,
      policyRevision: this.repo.policyRevision,
    };
    next.digest = this.digest({
      capability: next.capability,
      arguments: next.arguments,
      audience: next.audience,
      revision: next.revision,
      worldId: next.worldId,
      validUntil: next.validUntil,
      dependencies: next.dependencies,
    });
    this.repo.write(() => this.put(next));
    return next;
  }
  approve(handle: ScopeHandle, id: string, digest: string, revision: number): Approval {
    const s = this.policy.validate(handle),
      action = this.get(handle, id);
    if (!action) throw new HarnessError('action_missing', '动作不存在。');
    if (action.digest !== digest || action.revision !== revision)
      throw new HarnessError('approval_mismatch', '动作内容已经变化，需要重新确认。');
    if (['cancelled', 'cancel_requested', 'cannot_cancel', 'cancellation_confirmed'].includes(action.status))
      throw new HarnessError('action_cancelled', '已撤销的动作不能再次批准。');
    const existing = this.repo.db
      .prepare('SELECT payload FROM h_approvals WHERE action_id=? ORDER BY rowid DESC LIMIT 1')
      .get(id);
    if (existing) {
      const approval = JSON.parse(String(existing.payload)) as Approval;
      if (
        approval.actionDigest === digest &&
        approval.actionRevision === revision &&
        approval.privacyEpoch === s.privacyEpoch &&
        approval.policyRevision === s.policyRevision &&
        approval.expiresAt > this.repo.clock.now()
      )
        return approval;
    }
    this.preflight(handle, action);
    const approval: Approval = {
      id: randomUUID(),
      actionId: id,
      actionDigest: digest,
      actionRevision: revision,
      principalId: s.principalId,
      policyRevision: s.policyRevision,
      privacyEpoch: s.privacyEpoch,
      expiresAt: new Date(
        Math.min(Date.parse(action.validUntil), Date.parse(this.repo.clock.now()) + 600000),
      ).toISOString(),
      used: false,
    };
    this.repo.write(() => {
      this.repo.db
        .prepare('INSERT INTO h_approvals VALUES(?,?,?)')
        .run(approval.id, id, JSON.stringify(approval));
      action.status = 'approved';
      action.policyRevision = s.policyRevision;
      action.privacyEpoch = s.privacyEpoch;
      this.put(action);
    });
    return approval;
  }
  private preflight(handle: ScopeHandle, action: EffectAction, approval?: Approval) {
    const s = this.policy.validate(handle),
      cap = this.broker.describe(action.capability);
    if (!cap) throw new HarnessError('unsupported_action', '动作能力已经不可用。');
    if (!s.sources.includes(cap.sourceId))
      throw new HarnessError('source_forbidden', '此动作来源不在当前授权范围内。');
    if (action.worldId !== 'real' || s.subjectId !== s.principalId)
      throw new HarnessError('effect_scope', '不能替其他主体或假设世界执行动作。');
    for (const grant of cap.requiredScopes) this.policy.require(handle, grant);
    this.broker.validateArguments(action.capability, action.arguments);
    if (Date.parse(action.validUntil) <= Date.parse(this.repo.clock.now()))
      throw new HarnessError('action_expired', '动作已经超过确认期限。');
    if (action.goalId) {
      const goal = this.repo.db.prepare("SELECT status,owner,workspace,subject,world FROM h_work WHERE id=? AND kind='goal'").get(action.goalId);
      if (!goal || goal.status !== 'active' || goal.owner !== s.principalId || goal.workspace !== s.workspaceId || goal.subject !== s.subjectId || goal.world !== 'real')
        throw new HarnessError('goal_cancelled', '相关目标已经取消或暂停。');
    }
    for (const dep of action.dependencies) {
      const row = this.repo.db
        .prepare(
          'SELECT revision,status FROM h_work WHERE id=? UNION ALL SELECT revision,status FROM h_assertions WHERE id=?',
        )
        .get(dep.producerId, dep.producerId);
      if (
        row &&
        (Number(row.revision) !== dep.producerRevision ||
          ['cancelled', 'inactive', 'retracted', 'expired', 'stale', 'blocked'].includes(String(row.status)))
      )
        throw new HarnessError('dependency_changed', '动作依据已发生变化，请重新核对。');
      if (this.repo.hasFence(dep.producerId))
        throw new HarnessError('source_deleted', '动作的来源已经删除。');
    }
    if (
      approval &&
      (approval.actionDigest !== action.digest ||
        approval.actionRevision !== action.revision ||
        approval.principalId !== s.principalId ||
        approval.privacyEpoch !== s.privacyEpoch ||
        approval.policyRevision !== s.policyRevision ||
        Date.parse(approval.expiresAt) <= Date.parse(this.repo.clock.now()))
    )
      throw new HarnessError('approval_invalid', '这次确认已失效，请重新查看具体动作。');
  }
  execute(
    handle: ScopeHandle,
    id: string,
    approvalId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EffectReceipt> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const pending = this.dispatch(handle, id, approvalId, signal).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, pending);
    return pending;
  }
  private async dispatch(
    handle: ScopeHandle,
    id: string,
    approvalId: string,
    signal: AbortSignal,
  ): Promise<EffectReceipt> {
    let action = this.get(handle, id);
    if (!action) throw new HarnessError('action_missing', '动作不存在。');
    if (action.status === 'succeeded') {
      const previous = this.receipts(handle, id).at(-1);
      if (previous) return previous;
    }
    if (['outcome_unknown', 'dispatching', 'reconciling', 'unresolved'].includes(action.status))
      throw new HarnessError('inspect_first', '结果尚未确定，请先核查，不能重复执行。', 'reconcile');
    const approvalRow = this.repo.db
        .prepare('SELECT payload FROM h_approvals WHERE id=? AND action_id=?')
        .get(approvalId, id),
      approval: Approval | undefined = approvalRow ? JSON.parse(String(approvalRow.payload)) : undefined;
    if (!approval) throw new HarnessError('approval_required', '缺少该动作的具体确认。');
    await this.beforeDispatch?.();
    signal.throwIfAborted();
    try {
      this.preflight(handle, action, approval);
    } catch (error) {
      this.repo.write(() => {
        const latest = this.repo.db.prepare('SELECT payload FROM h_actions WHERE id=?').get(id);
        if (latest) {
          action = JSON.parse(String(latest.payload));
          action!.status = 'cancelled';
          action!.reason =
            action!.reason === 'permission_revoked'
              ? 'permission_revoked'
              : error instanceof HarnessError
                ? error.code
                : 'preflight_failed';
          this.put(action!);
        }
      });
      throw error;
    }
    if (approval.used) throw new HarnessError('approval_used', '这次确认已使用，请核查已有回执。');
    const attemptId = randomUUID();
    this.repo.write(() => {
      this.preflight(handle, action!, approval);
      approval.used = true;
      this.repo.db
        .prepare('UPDATE h_approvals SET payload=? WHERE id=?')
        .run(JSON.stringify(approval), approval.id);
      action!.status = 'dispatching';
      this.put(action!);
      this.repo.db
        .prepare('INSERT INTO h_attempts VALUES(?,?,?,?,?,?)')
        .run(
          attemptId,
          id,
          action!.idempotencyKey,
          'dispatching',
          this.repo.epoch,
          JSON.stringify({ createdAt: this.repo.clock.now(), capability: action!.capability }),
        );
    });
    this.repo.transitions.push({
      at: this.repo.clock.now(),
      objectId: id,
      from: 'approved',
      to: 'dispatching',
      revision: action.revision,
    });
    if (action.effect === 'local_write') {
      try {
        return this.repo.write(() => {
          this.preflight(handle, action!, approval);
          const local = this.localWrite({
            ...action!.arguments,
            id,
            saved: true,
            done: false,
            revision: action!.revision,
            approvalDigest: action!.digest,
          } as Action, action!);
          const recordId = local?.recordId || id;
          const stored = this.repo.db.prepare('SELECT payload FROM agenda WHERE id=?').get(recordId);
          const current = stored ? JSON.parse(String(stored.payload)) as Action : undefined;
          if (local?.current === null ? !!current : !current)
            throw new HarnessError('local_verification', '本地状态没有通过写后核查，事务已回滚。');
          const expected = local?.current || (local?.current === null ? null : action!.arguments);
          if (expected && Object.entries(expected).some(([key, value]) => !['coverage', 'missingNeeds', 'approvalDigest'].includes(key) && canonical((current as any)?.[key]) !== canonical(value)))
            throw new HarnessError('local_verification', '本地记录与批准内容不一致，事务已回滚。');
          if (local) action!.compensation = { targetId: recordId, expectedRevision: local.current?.revision || 0, previous: local.previous as any, applied: local.applied };
          this.repo.fault?.('after_local_write_before_receipt');
          const receipt: EffectReceipt = {
            id: randomUUID(),
            actionId: id,
            attemptId,
            sourceId: action!.sourceId,
            status: 'confirmed_success',
            localStatus: 'local_saved',
            externalRecordId: recordId,
            observedAt: this.repo.clock.now(),
          };
          this.record(action!, receipt);
          return receipt;
        });
      } catch (error) {
        action.status = 'failed_confirmed';
        action.reason = 'local_transaction_rolled_back';
        this.repo.write(() => this.put(action!));
        throw error;
      }
    }
    try {
      const result = await this.broker.invoke(handle, action.capability, action.arguments, signal, {
        actionAttempt: { id: attemptId, key: action.idempotencyKey },
      });
      this.afterDispatch?.();
      this.repo.fault?.('after_external_dispatch_before_receipt');
      const receipt = this.fromResult(action, attemptId, result);
      this.repo.write(() => this.record(action!, receipt));
      return receipt;
    } catch (error) {
      const receipt: EffectReceipt = {
        id: randomUUID(),
        actionId: id,
        attemptId,
        sourceId: action.sourceId,
        status: 'unknown',
        observedAt: this.repo.clock.now(),
        reason: 'receipt_unavailable',
      };
      this.repo.write(() => this.record(action!, receipt));
      return receipt;
    }
  }
  private fromResult(action: EffectAction, attemptId: string, result: CapabilityResult): EffectReceipt {
    const data = result.data as
      { receiptStatus?: EffectReceipt['status']; externalRecordId?: string } | undefined;
    const status = data?.receiptStatus || 'unknown';
    return {
      id: randomUUID(),
      actionId: action.id,
      attemptId,
      sourceId: result.sourceId,
      status,
      observedAt: this.repo.clock.now(),
      externalRecordId: data?.externalRecordId,
      reason: result.reason,
    };
  }
  private record(action: EffectAction, receipt: EffectReceipt) {
    const latest = this.repo.db.prepare('SELECT status FROM h_actions WHERE id=?').get(action.id);
    action.status =
      receipt.status === 'confirmed_success'
        ? 'succeeded'
        : receipt.status === 'confirmed_failure'
          ? 'failed_confirmed'
          : 'outcome_unknown';
    if (latest?.status === 'cancel_requested') {
      action.status = 'cancel_requested';
      action.reason = 'effect_may_have_occurred_after_revocation';
    }
    this.put(action);
    this.repo.db
      .prepare('INSERT INTO h_receipts VALUES(?,?,?,?)')
      .run(receipt.id, receipt.actionId, receipt.attemptId, JSON.stringify(receipt));
    this.repo.db.prepare('UPDATE h_attempts SET status=? WHERE id=?').run(action.status, receipt.attemptId);
    this.repo.transitions.push({
      at: this.repo.clock.now(),
      objectId: action.id,
      to: action.status,
      revision: action.revision,
    });
    this.repo.outbox('action_receipt', action.id);
  }
  receipts(handle: ScopeHandle, id: string): EffectReceipt[] {
    if (!this.get(handle, id)) return [];
    return this.repo.db
      .prepare('SELECT payload FROM h_receipts WHERE action_id=? ORDER BY rowid')
      .all(id)
      .map((r) => JSON.parse(String(r.payload)));
  }
  async reconcile(handle: ScopeHandle, id: string, signal: AbortSignal = new AbortController().signal) {
    const action = this.get(handle, id);
    if (!action) throw new HarnessError('action_missing', '动作不存在。');
    if (!['outcome_unknown', 'unresolved', 'cancel_requested'].includes(action.status))
      return this.receipts(handle, id).at(-1);
    if (action.effect === 'local_write' && ['local.agenda.save', 'local.agenda.change'].includes(action.capability)) {
      signal.throwIfAborted(); this.policy.validate(handle);
      const known = this.receipts(handle, id).at(-1);
      if (known) return known;
      const attempt = this.repo.db.prepare('SELECT id FROM h_attempts WHERE action_id=? ORDER BY rowid DESC LIMIT 1').get(id);
      if (!attempt) throw new HarnessError('attempt_missing', '没有可核查的派发记录。');
      // These handlers commit the local row and its receipt in one SQLite
      // transaction. No receipt after restart means that transaction did not
      // commit; unlike an external HTTP timeout, a local re-dispatch is not guessed.
      const receipt: EffectReceipt = { id: randomUUID(), actionId: id, attemptId: String(attempt.id), sourceId: action.sourceId,
        status: 'confirmed_failure', observedAt: this.repo.clock.now(), reason: 'local_transaction_not_committed' };
      this.repo.write(() => this.record(action, receipt));
      return receipt;
    }
    const cap = this.broker.describe(action.capability);
    if (!cap?.supportsInspect) {
      action.status = 'unresolved';
      action.reason = 'provider_has_no_inspect_check_manually';
      this.repo.write(() => this.put(action));
      return;
    }
    const row = this.repo.db
      .prepare('SELECT id FROM h_attempts WHERE action_id=? ORDER BY rowid DESC LIMIT 1')
      .get(id);
    if (!row) throw new HarnessError('attempt_missing', '缺少派发记录。');
    action.status = 'reconciling';
    this.repo.write(() => this.put(action));
    try {
      const result = await this.broker.invoke(handle, action.capability, action.arguments, signal, {
        inspectKey: action.idempotencyKey,
      });
      const receipt = this.fromResult(action, String(row.id), result);
      this.repo.write(() => this.record(action, receipt));
      return receipt;
    } catch {
      action.status = 'unresolved';
      action.reason = 'inspection_unavailable';
      this.repo.write(() => this.put(action));
      return;
    }
  }
  async cancel(handle: ScopeHandle, id: string, signal: AbortSignal = new AbortController().signal) {
    const action = this.get(handle, id);
    if (!action) return;
    signal.throwIfAborted();
    if (['cancelled', 'cancellation_confirmed'].includes(action.status)) return action;
    if (['proposed', 'awaiting_approval', 'approved', 'failed_confirmed'].includes(action.status)) {
      action.status = 'cancelled';
      this.repo.write(() => { this.repo.db.prepare("UPDATE h_jobs SET status='cancelled',fence=fence+1 WHERE object_id=?").run(id); this.put(action); });
      return action;
    }
    if (action.effect === 'local_write') {
      this.policy.require(handle, 'local:write');
      this.repo.write(() => {
        if (this.localUndo && action.compensation) this.localUndo(action);
        else {
          this.repo.db.prepare('DELETE FROM agenda WHERE id=?').run(id);
          this.repo.db.prepare("UPDATE h_jobs SET status='cancelled',fence=fence+1 WHERE object_id=?").run(id);
        }
        action.status = 'cancellation_confirmed';
        this.put(action);
      });
      return action;
    }
    action.status = 'cancel_requested';
    this.repo.write(() => { this.repo.db.prepare("UPDATE h_jobs SET status='cancelled',fence=fence+1 WHERE object_id=?").run(id); this.put(action); });
    const cap = this.broker.describe(action.capability);
    if (!cap?.supportsCancel) {
      action.status = 'cannot_cancel';
      action.reason = 'provider_cannot_reverse_effect';
      this.repo.write(() => this.put(action));
      return action;
    }
    try {
      const result = await this.broker.invoke(handle, action.capability, action.arguments, signal, {
        cancelKey: action.idempotencyKey,
      });
      const data = result.data as { receiptStatus?: string } | undefined;
      action.status =
        data?.receiptStatus === 'confirmed_success' ? 'cancellation_confirmed' : 'cancellation_unknown';
    } catch {
      action.status = 'cancellation_unknown';
    }
    this.repo.write(() => this.put(action));
    return action;
  }
}
