import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HarnessError, type ScopeHandle, type WorkRecord } from '../../shared/harness';
import type { KernelRepository } from '../storage/repository';
import type { WorkService } from './work';
import type { ActionRuntime } from '../actions/runtime';

const citation = z.object({ eventId: z.string().max(160), quote: z.string().min(1).max(4000) }).strict();
const supportedText = z.object({ text: z.string().max(1200), source: citation }).strict();
export const collaborationInput = z.object({
  operation: z.enum(['frame', 'request', 'progress', 'repair', 'withdraw']),
  id: z.string().max(160).optional(), expectedRevision: z.number().int().positive().optional(),
  source: citation.optional(),
  title: z.string().min(1).max(160).optional(),
  expectedResult: z.string().max(1600).optional(),
  kind: z.enum(['answer', 'action', 'artifact']).optional().describe('说明、比较是answer；拟稿等可交付内容是artifact；真实改变外部/本地业务状态才是action。'),
  frame: z.object({
    question: z.string().max(1200),
    confirmedFacts: z.array(supportedText).max(12),
    decisions: z.array(supportedText).max(12),
    tentativeUnderstanding: z.array(z.string().max(1200)).max(12),
    participation: z.array(z.string().max(600)).max(8),
    rejectedOptions: z.array(z.object({ title: z.string().max(300), reason: z.string().max(800), validWhen: z.string().max(600), source: citation }).strict()).max(12),
    nextStep: z.string().max(1000).nullable(),
  }).strict().optional(),
  status: z.enum(['in_progress', 'waiting_user', 'waiting_external', 'unfulfilled']).optional(),
  reason: z.string().max(1000).optional(),
  actionId: z.string().max(160).optional(),
  affectedIds: z.array(z.string().max(160)).max(24).optional(),
}).strict();
export type RequestState = 'pending' | 'in_progress' | 'waiting_user' | 'waiting_external' | 'answered' | 'succeeded' | 'unfulfilled' | 'withdrawn';

/** Open collaboration content uses the existing scoped WorkService and writer. */
export class CollaborationService {
  constructor(private repo: KernelRepository, private work: WorkService, private actions: ActionRuntime) {}

  private cite(scope: ScopeHandle, source: z.infer<typeof citation>) {
    const evidence = this.repo.evidence(scope, source.eventId);
    if (!evidence || evidence.speaker !== 'user' || !evidence.text.includes(source.quote))
      throw new HarnessError('unsupported_evidence', '这项记录没有对应的用户原话。');
    return evidence;
  }

  restore(scope: ScopeHandle, sessionId: string, query = '', offset = 0, limit = 8) {
    const { items, total, nextOffset } = this.repo.collaborationPage(scope, sessionId, query, offset, limit);
    const optionIds = new Set(items.flatMap(record => Array.isArray(record.data.optionIds) ? record.data.optionIds : []));
    return { status: total ? 'fresh' : 'not_found', items, relatedOptions: [...optionIds].flatMap(id => this.repo.work(scope, undefined, String(id))), nextOffset,
      coverage: { complete: nextOffset === null, totalMatches: total, returned: items.length, meaning: 'This page covers matching scoped working records; use nextOffset for remaining matches. It is not a complete conversation archive.' } };
  }

  requests(scope: ScopeHandle, sessionId: string, openOnly = false) {
    return this.repo.requestItems(scope, sessionId, openOnly);
  }

  update(scope: ScopeHandle, sessionId: string, input: z.infer<typeof collaborationInput>) {
    const args = collaborationInput.parse(input);
    if (!args.source) throw new HarnessError('source_required', '需要指向原话，不能把建议自动变成你的任务。');
    const evidence = this.cite(scope, args.source);
    const old = args.id ? this.repo.work(scope, undefined, args.id)[0] : undefined;
    if (args.id && (!old || !['collaboration_frame', 'request_item'].includes(String(old.data.type)))) throw new HarnessError('work_missing', '没有找到本次相关事项。');
    if (old && args.expectedRevision !== old.revision) throw new HarnessError('version_conflict', '事项已改变，需要先读取当前版本。');
    if (args.operation === 'frame') {
      if (!args.frame) throw new HarnessError('frame_required', '共同理解内容未提供。');
      const sources = [evidence.id];
      for (const item of [...args.frame.confirmedFacts, ...args.frame.decisions, ...args.frame.rejectedOptions]) sources.push(this.cite(scope, item.source).id);
      const data = { type: 'collaboration_frame', sessionId, sessionIds: [...new Set([...(Array.isArray(old?.data.sessionIds) ? old.data.sessionIds : []), sessionId])], ...args.frame, source: { ...args.source, receivedAt: evidence.receivedAt, contentVersion: evidence.contentVersion } };
      return old ? this.work.update(scope, old.id, old.revision, { data, title: args.title || old.title, evidenceIds: [...new Set(sources)] })
        : this.work.create(scope, 'episode', args.title || args.frame.question.slice(0, 160), data, { status: 'active', evidenceIds: [...new Set(sources)] });
    }
    if (args.operation === 'request') {
      if (!args.title || !args.kind || !args.expectedResult) throw new HarnessError('request_incomplete', '请求还缺少具体要得到的结果。');
      if (args.status && !args.reason) throw new HarnessError('request_state_missing', '未完成项需要说明具体原因。');
      const id = 'request:' + createHash('sha256').update(`${evidence.id}\0${args.source.quote}\0${args.expectedResult}`).digest('hex');
      const existing = this.requests(scope, sessionId).find(record => record.id === id);
      if (existing) return existing;
      return this.work.create(scope, 'task', args.title, {
        type: 'request_item', sessionId, sessionIds: [sessionId], requestKind: args.kind, source: { ...args.source, receivedAt: evidence.receivedAt, contentVersion: evidence.contentVersion },
        expectedResult: args.expectedResult, state: args.status || 'pending', ...(args.reason ? { reason: args.reason } : {}), resultRefs: [],
      }, { id, status: args.status || 'pending', evidenceIds: [evidence.id] });
    }
    if (!old) throw new HarnessError('work_missing', '请先读取要更新的事项。');
    if (args.operation === 'repair') {
      if (!args.reason) throw new HarnessError('repair_reason_missing', '还没有指明被纠正的解释。');
      this.repo.write(() => {
        this.repo.invalidate(old.id, 'user_correction');
        for (const id of args.affectedIds || []) {
          if (!this.repo.work(scope, undefined, id).length && !this.actions.get(scope, id))
            throw new HarnessError('repair_scope', '被影响对象不在当前范围内。');
          this.repo.invalidate(id, 'user_correction');
        }
      });
      return this.work.update(scope, old.id, old.revision, { status: 'needs_review', data: { ...old.data, sessionId, tentativeUnderstanding: [], nextStep: null, decisionsNeedRevalidation: true, repair: { source: args.source, reason: args.reason, at: this.repo.clock.now() }, state: 'in_progress' }, evidenceIds: [...new Set([...old.evidenceIds, evidence.id])] });
    }
    if (args.operation === 'withdraw') {
      this.repo.invalidate(old.id, 'request_withdrawn');
      return this.work.update(scope, old.id, old.revision, { status: 'withdrawn', data: { ...old.data, state: 'withdrawn', reason: args.reason || args.source.quote } });
    }
    if (old.data.type !== 'request_item') throw new HarnessError('request_required', '该对象不是明确请求。');
    if (args.actionId) {
      const action = this.actions.get(scope, args.actionId);
      const receipts = this.actions.receipts(scope, args.actionId);
      if (!action || action.status !== 'succeeded' || !receipts.some(receipt => receipt.status === 'confirmed_success'))
        throw new HarnessError('receipt_required', '没有已核实的完成回执。');
      // Receipt existence is necessary; exact request/parameter correspondence
      // is still checked against the final answer before closing the request.
      return this.work.update(scope, old.id, old.revision, { data: { ...old.data, state: 'in_progress', proposedResultRefs: [args.actionId] } });
    }
    if (!args.status || !args.reason) throw new HarnessError('request_state_missing', '未完成项需要具体状态和原因。');
    return this.work.update(scope, old.id, old.revision, { status: args.status, data: { ...old.data, state: args.status, reason: args.reason } });
  }

  /** Called only by the host's final review, never an acting-model tool. */
  finalize(scope: ScopeHandle, record: WorkRecord, state: 'answered' | 'succeeded', responseId: string, actionIds: string[] = [], resolution: { kind?: 'answer' | 'action' | 'artifact'; basisQuote?: string; artifactIds?: string[]; artifacts?: import('../../shared/types').ReleaseArtifact[] } = {}) {
    let kind = String(record.data.requestKind), data = record.data;
    if (resolution.kind && resolution.kind !== kind) {
      const source = record.data.source as { eventId: string; quote: string };
      if (!resolution.basisQuote || !source.quote.includes(resolution.basisQuote)) throw new HarnessError('classification_evidence', '请求类别的修正没有原话依据。');
      this.cite(scope, { eventId: source.eventId, quote: resolution.basisQuote });
      data = { ...data, requestKind: resolution.kind, classificationCorrection: { from: kind, to: resolution.kind, quote: resolution.basisQuote } };
      kind = resolution.kind;
    }
    if (kind === 'action' && state === 'answered') return this.work.update(scope, record.id, record.revision, { status: 'unfulfilled', data: { ...data, state: 'unfulfilled', reason: '本次已说明情况，尚未核实操作完成。', resultRefs: [responseId] } });
    if (kind === 'action' && (state !== 'succeeded' || !actionIds.length || actionIds.some(id => !this.actions.receipts(scope, id).some(receipt => receipt.status === 'confirmed_success'))))
      throw new HarnessError('receipt_required', '动作请求没有核实的回执，不能标为办成。');
    const artifacts = (resolution.artifactIds || []).map(id => resolution.artifacts?.find(artifact => artifact.id === id && artifact.privacyEpoch === this.repo.epoch && record.evidenceIds.includes(artifact.sourceMessageId)));
    if (kind === 'artifact' && (!artifacts.length || artifacts.some(artifact => !artifact))) throw new HarnessError('artifact_required', '成稿请求没有实际可交付的稿件。');
    const finalState = kind === 'action' ? state : 'answered';
    return this.work.update(scope, record.id, record.revision, { status: finalState, data: { ...data, state: finalState, resultRefs: [responseId, ...actionIds, ...artifacts.filter(Boolean).map(artifact => `artifact:${artifact!.id}@${artifact!.revision}`)] } });
  }
}
