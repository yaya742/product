import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Fixture } from './support';
import { ExternalSink } from './sink';
import type { DevelopmentCase } from './understanding-cases';

/** Synthetic state only. Setups never receive expected answers or inspect model output. */
export async function setupUnderstanding(story: DevelopmentCase) {
  const f = new Fixture(), sessionId = randomUUID(), sourceReads: string[] = [];
  const cleanup: (() => Promise<void>)[] = [];
  f.store.saveSettings({ mode: 'deepseek', memoryEnabled: true, weatherEnabled: false });
  f.memory.paused = !story.background;
  f.store.session(sessionId, '隔离开发故事');
  const history = (text: string, role: 'user' | 'assistant' = 'user', session: string = sessionId) => {
    const id = randomUUID();
    f.store.session(session, '隔离开发前情');
    f.store.putMessage({ id, sessionId: session, role, content: text, createdAt: f.clock.now(), status: 'done', steps: [], obligations: [], actions: [] });
    return id;
  };
  const frame = (text: string, question: string, tentative: string[] = []) => {
    const eventId = history(text);
    return f.store.runtime.collaboration.update(f.scope(), sessionId, { operation: 'frame', title: question, source: { eventId, quote: text }, frame: { question, confirmedFacts: [{ text, source: { eventId, quote: text } }], decisions: [], tentativeUnderstanding: tentative, participation: ['比较，保留选择'], rejectedOptions: [], nextStep: '依当前条件继续判断' } });
  };
  let external: ExternalSink | undefined;
  let capability: string | undefined;
  if (['campus', 'partial_campus'].includes(story.setup)) {
    f.store.runtime.domains.importSnapshot({ source: '合成导入的教师单次调课记录', updatedAt: f.clock.now(), schedule: [{ id: 'course-k', title: '课程K', startsAt: '2026-09-15T10:00:00+08:00', endsAt: '2026-09-15T11:30:00+08:00', location: 'B214', status: 'scheduled', source: '教师通知：仅9月15日变更' }], exams: [], places: [], rules: [] }, undefined, 'campus:local', 'test:A', '2026-fall');
  }
  if (story.setup === 'running_preference') await f.remember('通常愿意晚间运动；当天另有安排时可以不跑。');
  if (story.setup === 'hint_preference') await f.remember('平时学习证明时，我偏好先给提示。');
  if (story.setup === 'wrong_reason') {
    frame('比较出门和留在当前住处。', '是否出门', ['可能因为嫌路远而不愿出门']);
    history('路远可能是主要问题，所以先留在住处。', 'assistant');
  }
  if (story.setup === 'future_residence') {
    history('现在仍住旧住处A，已确定9月21日开始搬到新住处B，目前还没搬。');
    await f.remember('现在住旧住处A。', { predicate: 'residence.current', validTo: '2026-09-21T00:00:00+08:00' });
    await f.remember('9月21日开始按已确定计划住新住处B。', { predicate: 'residence.future', validFrom: '2026-09-21T00:00:00+08:00' });
  }
  if (story.setup === 'private_owner') {
    await f.remember('本人私密偏好 CANARY_PRIVATE_OWNER_611：我偏爱独自通勤。');
    history('CANARY_PRIVATE_HISTORY_611，和当前任务无关。', 'user', 'unrelated-private');
  }
  if (story.setup === 'old_original') {
    history('橙色小桥旁的办法没采用，是因为晚上回程入口关闭。', 'user', 'old-original');
    for (let n = 0; n < 45; n++) { f.clock.advance(1000); history('无关旧话题编号 ' + n, 'user', 'old-original'); }
    f.clock.set('2026-09-14T06:00:00Z');
  }
  if (story.setup === 'computer_context') {
    await f.remember('过去电脑通常放在住处。');
    frame('正在决定要不要回住处拿电脑，以便在学校继续项目。', '是否回去拿电脑');
    history('今天电脑已经带在身边了，目前人在学校。');
  }
  if (story.setup === 'new_device') {
    frame('之前校园项目方案因没有计算设备而放下；若设备可用，可重新比较，但没有同意借用。', '校园项目方案的设备条件');
    capability = 'equipment.' + randomUUID().replaceAll('-', '').slice(0, 12);
    f.store.runtime.broker.register({ manifest: { id: capability, version: '1', sourceId: 'synthetic:equipment', trust: 'bundled_reviewed', egressHosts: [], platforms: ['*'], simulated: true, offline: 'unsupported', license: 'synthetic fixture', capabilities: [{ name: capability, displayName: '计算设备借用可用性', description: '查询新接入的校园计算设备借用服务，返回设备、可用时间和适用项目；只读，不办理借用。', version: '1', input: z.object({}).strict(), output: z.json(), effect: 'read', requiredScopes: ['evidence:read'], subjects: ['self'], worlds: ['real'], timeoutMs: 1000, maxBytes: 4000, supportsIdempotency: false, supportsInspect: false, supportsCancel: false }] }, invoke: () => { sourceReads.push(capability!); return { status: 'fresh', sourceId: 'synthetic:equipment', data: { device: '便携计算工作站', available: true, from: '2026-09-14T14:00:00+08:00', to: '2026-09-14T20:00:00+08:00', supportsCampusProject: true, reservationCreated: false }, observedAt: f.clock.now(), fetchedAt: f.clock.now(), simulated: true }; } }, { reviewed: true, source: 'isolated synthetic extension' });
  }
  if (['delegation', 'delegation_cancel'].includes(story.setup)) {
    f.ingest('PRIVATE_PARENT_PROFILE_CANARY');
    f.store.runtime.broker.register({ manifest: { id: 'packets', version: '1', sourceId: 'synthetic:packets', trust: 'bundled_reviewed', egressHosts: [], platforms: ['*'], simulated: true, offline: 'unsupported', license: 'fixture', capabilities: [{ name: 'sample.packet', displayName: '独立资料片段', description: '分别读取left与right的独立资料原数值。', version: '1', input: z.object({ packet: z.enum(['left', 'right']) }).strict(), output: z.json(), effect: 'read', requiredScopes: ['evidence:read'], subjects: ['self'], worlds: ['real'], timeoutMs: 1000, maxBytes: 4000, supportsIdempotency: false, supportsInspect: false, supportsCancel: false }] }, invoke: (_name, args) => { sourceReads.push(args.packet); return { status: 'fresh', sourceId: 'synthetic:packets', data: { packet: args.packet, value: args.packet === 'left' ? 743 : 1189 }, observedAt: f.clock.now(), fetchedAt: f.clock.now(), simulated: true }; } }, { reviewed: true, source: 'isolated synthetic packets' });
  }
  if (story.setup === 'recurrence') f.store.saveAction({ id: 'weekly-series', revision: 1, title: '周会', detail: '按上海时区', kind: 'event', startsAt: '2026-09-14T09:00:00+08:00', timeZone: 'Asia/Shanghai', durationMinutes: 30, recurrence: { frequency: 'weekly', interval: 1, count: 3 } });
  if (story.setup === 'agreed_time') { history('明天14:00线上讨论，结束时间待定。'); history('时间和形式明确了，等你决定是否登记。', 'assistant'); }
  if (story.setup === 'user_changed') f.store.saveAction({ id: 'user-changed', revision: 2, title: '组会', detail: '本人已改期', kind: 'event', startsAt: '2026-09-15T11:00:00+08:00' });
  if (story.setup === 'forget') await f.remember('我的旧昵称 CANARY_FORGET_STORY_625。');
  if (story.setup === 'private_calendar') f.store.saveAction({ id: 'private-busy', revision: 1, title: 'CANARY_CALENDAR_TITLE_627', detail: 'CANARY_PRIVATE_REASON_627', kind: 'event', startsAt: '2026-09-15T09:00:00+08:00', durationMinutes: 60, timeZone: 'Asia/Shanghai' });
  if (story.setup === 'options') {
    const matter = frame('比较三个地点：第一图书馆、第二留在当前教室、第三回住处；第三因回程入口关闭已经排除。', '地点比较');
    const options = ['图书馆', '留在当前教室', '回住处'].map((title, index) => f.store.runtime.work.create(f.scope(), 'plan', title, { episodeId: matter.id, optionOrder: index + 1, rationale: index === 2 ? '回程入口关闭，排除' : '可比较' }, { status: index === 2 ? 'rejected' : 'proposed', evidenceIds: matter.evidenceIds }));
    f.store.runtime.work.update(f.scope(), matter.id, matter.revision, { data: { ...matter.data, optionIds: options.map(option => option.id) } });
    history('三个选项依次是图书馆、留在当前教室、回住处。第三项已因入口关闭排除。', 'assistant');
  }
  if (story.setup === 'evidence_majority') {
    for (const [id, text] of Object.entries({ old1: '旧摘要一（来自原通知X）：课程K在A101。', old2: '旧摘要二（也来自原通知X）：课程K在A101。', newer: '授课教师本人2026-09-14签发的原通知Y：课程K仅9月15日这一节改到B214，其他周仍在A101。' })) history(text, 'user', 'source-' + id);
    history('待核查三份资料：旧摘要一、旧摘要二、教师本人新原通知。');
  }
  if (['watch_goal', 'goal'].includes(story.setup)) {
    const goal = f.store.runtime.work.create(f.scope(), 'goal', '课外竞赛', {}, { status: 'active', id: 'competition-goal' });
    f.store.runtime.reminders.schedule({ id: 'competition-reminder', title: '竞赛准备', detail: '', startsAt: '2026-09-15T00:00:00Z' }, goal.id);
  }
  if (story.setup === 'evening_event') f.store.saveAction({ id: 'evening-event', revision: 1, title: '已答应的晚间活动', detail: '', kind: 'event', startsAt: '2026-09-14T19:00:00+08:00' });
  if (story.setup === 'lost_receipt') {
    external = await new ExternalSink().start(); cleanup.push(() => external!.close()); external.mode = 'commit_then_disconnect';
    const r = f.store.runtime;
    r.broker.register(external.provider(), { reviewed: true, source: 'local HTTP test sink' }); f.policy.grant('external:book');
    const s = f.scope(), action = r.actions.prepare(s, { id: 'booking-check', capability: 'test.external.book', arguments: { title: '隔离申请' } });
    const approval = r.actions.approve(s, action.id, action.digest, action.revision); await r.actions.execute(s, action.id, approval.id);
  }
  f.repo.access.length = 0;
  return { f, sessionId, sourceReads, capability, external, close: async () => { f.close(); for (const close of cleanup) await close(); } };
}
