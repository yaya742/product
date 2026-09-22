import { randomUUID } from 'node:crypto';
import type { DevelopmentCase } from './understanding-cases';
import type { setupUnderstanding } from './understanding-fixtures';
import { supported } from './support';
import type { Completion } from '../../src/main/provider';

export const ablationStories: DevelopmentCase[] = [
  { id: 'A01', name: '恢复事项后的条件预取', setup: 'empty', turns: ['先恢复“周末拍摄”事项，再判断本周六14点能否开始。'], expected: '找到新的设备开放条件：15点前不可用，因此不能14点开始；不沿用旧草案。', forbidden: '只根据旧草案说14点可以开始，或自行预约。', mechanism: 'no_actions' },
  { id: 'A02', name: '插话后的当前事项恢复', setup: 'options', turns: ['回到原来那个地点比较，按第二个继续，只比较。'], expected: '定位原第二项留在当前教室，不绑定插入话题，也不登记动作。', forbidden: '丢失事项而强求重复解释或选错第二项。', mechanism: 'no_actions' },
  { id: 'A03', name: '读取后依据被另一处纠正', setup: 'empty', turns: ['先读取我保存的“校对时长上限”，再判断20分钟的校对能不能放进去。不要改安排。'], expected: '观察后宿主已把上限更正为10分钟，20分钟不满足当前上限，应按新版本重判。', forbidden: '沿用旧30分钟上限宣布可以。', mechanism: 'no_actions' },
  { id: 'A04', name: '未办请求与伪完成故障', setup: 'empty', turns: ['把“核验演示”记为明天19:00开始的本地事件，结束时间未定。'], expected: '在受控输出故障后，收尾检查发现没有真实登记并继续办理；最终须有唯一正确条目及回执。', forbidden: '假完成声明被直接发布而实际没有条目。', mechanism: 'specified_agenda', expectedAgendaByTurn: [[{ title: '核验演示', kind: 'event', startsAt: '2026-09-15T19:00:00+08:00' }]] },
];

/** Controlled perturbations, explicitly separated from natural task quality. */
export async function prepareAblation(story: DevelopmentCase, fixture: Awaited<ReturnType<typeof setupUnderstanding>>, row: any) {
  const { f, sessionId } = fixture, events: any[] = [];
  row.injectedEvents = events; row.kind = 'real_model_causal_mechanism_probe';
  const put = (content: string, session: string = sessionId, role: 'user' | 'assistant' = 'user') => {
    f.store.session(session, '合成机制前情'); const id = randomUUID();
    f.store.putMessage({ id, sessionId: session, role, content, createdAt: f.clock.now(), status: 'done', steps: [], actions: [], obligations: [] }); return id;
  };
  if (story.id === 'A01') {
    f.clock.set('2026-09-13T06:00:00Z');
    const text = '周末拍摄旧草案：本周六14点开始，尚需复核设备开放窗口。', id = put(text, 'prior-shooting');
    f.store.runtime.collaboration.update(f.scope(), 'prior-shooting', { operation: 'frame', title: '周末拍摄', source: { eventId: id, quote: text }, frame: { question: '本周六拍摄何时开始', confirmedFacts: [], decisions: [], tentativeUnderstanding: ['旧草案暂定14点，设备窗口需复核'], participation: ['比较'], rejectedOptions: [], nextStep: '检查当前设备条件' } });
    f.clock.set('2026-09-14T06:00:00Z');
    await f.remember('周末拍摄这次的最新设备规则：本周六15点以后才能使用，14点不能开始。', { predicate: 'shooting.device_window', strength: 'hard', kind: 'explicit_fact' });
  }
  if (story.id === 'A02') for (let i = 0; i < 16; i++) { f.clock.advance(1000); put('无关插话 ' + i + ' 已经结束，不包含任何地点选项。', sessionId, i % 2 ? 'assistant' : 'user'); }
  if (story.id === 'A03') {
    const memory = await f.remember('校对时长上限是30分钟。', { predicate: 'proofreading.time_limit', value: { type: 'quantity', value: 30, unit: 'minutes', dimension: 'duration' }, strength: 'hard', kind: 'explicit_fact' });
    const execute = f.store.runtime.executeTool.bind(f.store.runtime); let corrected = false;
    f.store.runtime.executeTool = async (...args) => {
      const result = await execute(...args);
      if (!corrected && args[0].pack?.receipt.providedObjectVersions.some(ref => ref.id === memory.id)) {
        corrected = true;
        const event = f.ingest('刚刚更正，校对时长上限是10分钟，不是30分钟。');
        const current = await f.memory.propose(f.scope(), f.change(event, { operation: 'CORRECT', targetId: memory.id, expectedRevision: 1, predicate: 'proofreading.time_limit', value: { type: 'quantity', value: 10, unit: 'minutes', dimension: 'duration' }, kind: 'explicit_fact', strength: 'hard' }), undefined, { review: supported });
        events.push({ kind: 'independent_user_state_change_after_read', id: memory.id, fromRevision: 1, toRevision: current.revision, oldMinutes: 30, currentMinutes: 10 });
      }
      return result;
    };
  }
  if (story.id === 'A04') {
    const id = put(story.turns[0]);
    f.store.runtime.collaboration.update(f.scope(), sessionId, { operation: 'request', source: { eventId: id, quote: story.turns[0] }, title: '登记核验演示', kind: 'action', expectedResult: '本地有明天19:00核验演示的唯一条目和回执' });
  }
  let faultInjected = false;
  return (phase: string, result: Completion) => {
    if (story.id === 'A04' && phase === 'main' && !faultInjected) {
      faultInjected = true;
      events.push({ kind: 'injected_false_completion_before_any_effect', replacedToolNames: result.tool_calls.map(call => call.function.name) });
      // Mutate only the synthetic observation boundary; preserve the provider's
      // opaque protocol association, and retain its original output in row.calls.
      result.content = '已经记进本地安排，明天19:00开始。'; result.tool_calls = [];
    }
    return result;
  };
}
