import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store';
import type { Harness } from '../harness';
import type { RuntimeOverview } from '../../shared/types';
import { HarnessError, objectId, personalLabel } from '../../shared/harness';
import { hasCredentials } from './redaction';

/** Trusted native controls. These are never registered as model or extension tools. */
export class NativeControls {
  constructor(
    readonly store: Store,
    readonly harness: Pick<Harness, 'running' | 'recoverPending'>,
  ) {}
  overview(): RuntimeOverview {
    const { runtime: r, kernel: repo } = this.store,
      scope = r.policy.hostScope(),
      f = repo.filter(scope);
    const processing = repo.db
      .prepare(
        `SELECT r.id,r.received_at,json_extract(r.payload,'$.fileName') AS file_name,COUNT(s.id) AS total,SUM(s.status='pending') AS pending,SUM(s.status IN ('failed','needs_context')) AS failed FROM h_evidence r JOIN h_spans s ON s.event_id=r.id WHERE ${f.sql} AND r.status='active' AND r.infer=1 GROUP BY r.id HAVING pending>0 OR failed>0 ORDER BY r.seq DESC LIMIT 50`,
      )
      .all(...f.params)
      .map((row) => ({
        eventId: String(row.id),
        receivedAt: String(row.received_at),
        fileName: row.file_name ? String(row.file_name) : undefined,
        total: Number(row.total),
        pending: Number(row.pending),
        failed: Number(row.failed),
      }));
    return {
      worlds: r.work.worlds(scope).map((w) => r.work.adoptionDiff(scope, w.id)),
      memories: r.memory.views(),
      work: repo.work(scope).filter((w) => ['goal', 'episode', 'plan', 'task', 'commitment'].includes(w.kind)),
      actions: r.actions
        .list(scope)
        .map((action) => ({ action, receipts: r.actions.receipts(scope, action.id) })),
      processing,
      watermarks: repo.watermarks(),
      privacyEpoch: repo.epoch,
      policyRevision: repo.policyRevision,
      revoked: r.policy.revoked(),
      notifications: r.reminders.port?.capabilities || {
        submitted: false,
        delivered: false,
        seen: false,
        stableId: false,
        closedApp: false,
      },
      storage: { atRestEncrypted: false, keyProtection: 'os_safe_storage' },
    };
  }
  evidence(value: unknown) {
    return this.store.kernel.evidence(this.store.runtime.policy.hostScope(), objectId.parse(value)) || null;
  }
  adoptWorld(raw: unknown) {
    const input = z
        .object({
          id: objectId,
          itemIds: z.array(objectId).min(1).max(32),
          expectedBaseRevision: z.number().int().nonnegative(),
          expectedPrivacyEpoch: z.number().int().positive(),
        })
        .strict()
        .parse(raw),
      r = this.store.runtime,
      scope = r.policy.hostScope(),
      diff = r.work.adoptionDiff(scope, input.id);
    if (
      input.expectedPrivacyEpoch !== this.store.kernel.epoch ||
      input.expectedBaseRevision !== diff.baseRevision
    )
      throw new HarnessError('revision_conflict', '采用范围已经变化，请重新查看设想。');
    r.work.adoptPreparation(scope, input.id, input.itemIds);
    return this.overview();
  }
  goal(raw: unknown) {
    const input = z
        .object({
          id: objectId,
          expectedRevision: z.number().int().positive(),
          status: z.enum(['active', 'paused', 'cancelled']),
        })
        .strict()
        .parse(raw),
      r = this.store.runtime,
      scope = r.policy.hostScope();
    const old = this.store.kernel.work(scope, 'goal').find((w) => w.id === input.id);
    if (!old || old.revision !== input.expectedRevision)
      throw new HarnessError('revision_conflict', '目标已有变化，请刷新后再决定。');
    if (old.status === 'cancelled')
      throw new HarnessError('goal_cancelled', '此目标已取消。需要重新提出目标，再决定是否采用。');
    if (input.status === 'cancelled') r.work.cancelGoal(scope, old.id);
    else
      this.store.kernel.write(() => {
        r.work.update(scope, old.id, old.revision, { status: input.status });
        if (input.status === 'paused') {
          this.store.kernel.invalidate(old.id, 'goal_paused');
          this.store.kernel.db
            .prepare("UPDATE h_jobs SET status='paused',fence=fence+1 WHERE goal_id=? AND status='queued'")
            .run(old.id);
          this.store.kernel.db.prepare("UPDATE h_watches SET status='inactive' WHERE goal_id=?").run(old.id);
        }
      });
    return this.overview();
  }
  feedback(raw: unknown): { saved: boolean; causalSuccess: 'not_established' } {
    const input = z
        .object({
          recommendationId: objectId,
          response: z.enum(['accepted', 'declined', 'not_observed']),
          reason: z.string().trim().min(1).max(1200).optional(),
        })
        .strict()
        .parse(raw),
      r = this.store.runtime,
      scope = r.policy.hostScope();
    if (input.reason && hasCredentials(input.reason))
      throw new HarnessError('restricted_retention', '请不要在反馈中填写密钥或密码。');
    const action = r.actions.get(scope, input.recommendationId),
      message = this.store.db
        .prepare("SELECT id FROM messages WHERE id=? AND role='assistant'")
        .get(input.recommendationId);
    if (!action && !message)
      throw new HarnessError('recommendation_missing', '这条建议已不存在，反馈未保存。');
    const id = randomUUID(),
      text =
        input.reason ||
        { accepted: '用户表示有帮助', declined: '用户表示不适合', not_observed: '尚未观察结果' }[
          input.response
        ];
    r.observations.ingest(scope, {
      id,
      sourceId: 'work:self',
      kind: 'feedback',
      version: 1,
      locator: {
        kind: 'text',
        eventId: id + ':v1',
        contentVersion: 1,
        startCodePoint: 0,
        endCodePoint: Array.from(text).length,
      },
      text,
      label: { ...personalLabel, infer: false },
      quality: 'unverified',
      data: {
        recommendationId: input.recommendationId,
        exposure: 'shown',
        response: input.response,
        ...(input.reason ? { explicitReason: input.reason } : {}),
        missingness: 'not_observed',
        contextRevision: action?.revision || 1,
      },
    });
    r.work.create(
      scope,
      'experience',
      text,
      {
        recommendationId: input.recommendationId,
        response: input.response,
        reason: input.reason || '',
        outcome: 'not_observed',
        causalSuccess: 'not_established',
      },
      { status: 'reported', evidenceIds: [id + ':v1'] },
    );
    return { saved: true, causalSuccess: 'not_established' };
  }
  async retry(value: unknown) {
    if (this.harness.running) throw new HarnessError('run_active', '先停止当前回复，再重试整理。');
    if (this.store.settings().mode !== 'deepseek' || !this.store.settings().memoryEnabled)
      throw new HarnessError('model_unavailable', '连接 DeepSeek 并开启记忆后才能重试整理。');
    const id = objectId.parse(value),
      r = this.store.runtime,
      scope = r.policy.hostScope(),
      event = this.store.kernel.evidence(scope, id);
    if (
      !event?.label.infer ||
      event.subjectId !== this.store.kernel.identity.principalId ||
      event.worldId !== 'real'
    )
      throw new HarnessError('inference_forbidden', '这份资料不能用于个人理解。');
    const spans = this.store.kernel
      .spans(scope, id)
      .filter((s) => ['failed', 'needs_context'].includes(s.status));
    if (spans.length)
      this.store.kernel.markSpans(
        scope,
        id,
        'pending',
        spans.map((s) => s.id),
      );
    await this.harness.recoverPending(id);
    return this.overview();
  }
  async reconcile(value: unknown) {
    await this.store.runtime.actions.reconcile(this.store.runtime.policy.hostScope(), objectId.parse(value));
    return this.overview();
  }
  permission(raw: unknown) {
    const input = z
      .object({ scope: z.string().min(1).max(100), enabled: z.boolean() })
      .strict()
      .parse(raw);
    this.store.runtime.policy[input.enabled ? 'grant' : 'revoke'](input.scope);
    return this.overview();
  }
}
