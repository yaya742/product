import { randomUUID } from 'node:crypto';
import { always, type MemoryChange, type TypedValue } from '../../src/shared/harness';
import { dateInZone, dayBounds, resolveLocalTime } from '../../src/main/runtime/semantics';
import {
  DeepSeekClient,
  ProviderError,
  type Completion,
  type ToolSpec,
  type WireMessage,
} from '../../src/main/provider';

/** An explicit offline model script, not a natural-language accuracy oracle. It never reads case.expected or case IDs. */
export function scriptedExtraction(
  input: {
    event: { id: string; text: string };
    clock: { now: string; timeZone: string };
    relatedAssertions?: any[];
  },
  entities: Record<string, string> = {},
): { status: string; changes: MemoryChange[] } {
  const text = input.event.text,
    now = input.clock.now,
    zone = input.clock.timeZone,
    today = dateInZone(now, zone),
    changes: MemoryChange[] = [];
  const add = (predicate: string, value: TypedValue, extra: Partial<MemoryChange> = {}) => {
    changes.push({
      operation: 'ADD',
      eventId: input.event.id,
      sourceQuote: text,
      predicate,
      value,
      text,
      kind: 'explicit_fact',
      strength: 'soft',
      conditions: always,
      subject: 'source_subject',
      world: 'source_world',
      idempotencyKey: randomUUID(),
      ...extra,
    });
  };
  const bool = (value: boolean): TypedValue => ({ type: 'boolean', value }),
    word = (value: string): TypedValue => ({ type: 'text', value });
  const day = dayBounds(today, zone);
  if (/假设|假如|假想|虚构|替室友|代问|他说|她说/.test(text))
    return { status: 'quote_or_hypothesis', changes: [] };
  if (/平时.*(?:考虑|喜欢).*跑步|通常喜欢晚上跑步/.test(text))
    add('running.usual_preference', bool(true), { kind: 'explicit_preference' });
  if (/雨天不跑/.test(text))
    add('running.rain_allowed', bool(false), {
      kind: 'explicit_preference',
      strength: 'hard',
      conditions: { op: 'compare', predicate: 'weather.condition', comparator: 'eq', value: word('rain') },
    });
  if (/今天.*(?:不想跑|不跑)/.test(text))
    add('running.today_allowed', bool(false), {
      kind: 'current_state',
      strength: 'hard',
      validFrom: day.from,
      validTo: day.to,
    });
  if (/今天.*没骑车/.test(text))
    add('transport.current', word('walk'), { kind: 'current_state', validFrom: day.from, validTo: day.to });
  else if (/通常.*骑车/.test(text)) add('transport.usual', word('bike'), { kind: 'explicit_preference' });
  if (/我现在住旧住处|我以前住旧住处/.test(text))
    add('residence.current', { type: 'entity', value: entities['旧住处'] || 'old-home' });
  const move = text.match(/(\d{1,2})月(\d{1,2})日开始住([^，。]+)/);
  if (move) {
    const date = today.slice(0, 4) + '-' + move[1].padStart(2, '0') + '-' + move[2].padStart(2, '0'),
      old = input.relatedAssertions?.find((a) => a.predicate === 'residence.current');
    add(
      'residence.current',
      { type: 'entity', value: entities[move[3]] || move[3] },
      {
        operation: 'SUPERSEDE',
        targetId: old?.id,
        expectedRevision: old?.revision,
        validFrom: dayBounds(date, zone).from,
      },
    );
  }
  if (/本周我住临时住处/.test(text))
    add('residence.temporary', word('临时住处'), {
      validFrom: day.from,
      validTo: new Date(Date.parse(day.from) + 7 * 86400000).toISOString(),
    });
  const sports = [...text.matchAll(/(\d+)(公里|次)/g)];
  if (/体育要求|不是\d+公里.*是\d+次/.test(text) && sports.length) {
    const m = sports.at(-1)!,
      old = input.relatedAssertions?.find((a) => a.predicate === 'sports.user_reported_requirement');
    add(
      'sports.user_reported_requirement',
      {
        type: 'quantity',
        value: Number(m[1]),
        unit: m[2] === '次' ? 'count' : 'km',
        dimension: m[2] === '次' ? 'count' : 'distance',
      },
      {
        operation: /说错|不是/.test(text) ? 'CORRECT' : 'ADD',
        targetId: /说错|不是/.test(text) ? old?.id : undefined,
        expectedRevision: /说错|不是/.test(text) ? old?.revision : undefined,
      },
    );
  }
  if (/普通周.*不提前预约/.test(text))
    add('library.reserve', bool(false), {
      kind: 'explicit_preference',
      conditions: {
        op: 'compare',
        predicate: 'calendar.period',
        comparator: 'eq',
        value: word('ordinary-period'),
      },
    });
  if (/考试周.*提前预约/.test(text))
    add('library.reserve', bool(true), {
      kind: 'explicit_preference',
      conditions: {
        op: 'compare',
        predicate: 'calendar.period',
        comparator: 'eq',
        value: word('exam-period'),
      },
    });
  if (/学校更容易专注/.test(text))
    add('place.focus_advantage', word('campus'), { kind: 'explicit_preference' });
  if (/在家更有自主感/.test(text))
    add('place.autonomy_advantage', word('home'), { kind: 'explicit_preference' });
  if (/因为房间里有远程会议/.test(text)) add('experience.explicit_reason', word('remote-meetings'));
  if (/不接受早起/.test(text))
    add('wake.early', bool(false), { kind: 'explicit_preference', strength: 'hard' });
  if (/平时.*先只要提示/.test(text))
    add('learning.interaction', word('hint_first'), { kind: 'explicit_preference' });
  if (/今天.*不需要有产出/.test(text))
    add('rest.preserve_unstructured', bool(true), {
      kind: 'current_state',
      strength: 'hard',
      validFrom: day.from,
      validTo: day.to,
    });
  if (/今天精神很好/.test(text))
    add('current.energy', word('good'), { kind: 'current_state', validFrom: day.from, validTo: day.to });
  if (/昨天状态很累/.test(text)) {
    const yesterday = new Date(Date.parse(day.from) - 86400000).toISOString();
    add('fatigue', bool(true), { kind: 'current_state', validFrom: yesterday, validTo: day.from });
  }
  if (/我喜欢(?:先看)?直观例子/.test(text))
    add('explanation.intuition_first', bool(true), { kind: 'explicit_preference' });
  const deadline = text.match(/今天(\d{1,2})点前必须交纸质材料/);
  if (deadline) {
    const resolved = resolveLocalTime(today + 'T' + deadline[1].padStart(2, '0') + ':00:00', zone);
    add(
      'deadline.paper_submission',
      { type: 'instant', value: resolved.instants[0] },
      { strength: 'hard', validFrom: day.from, validTo: day.to },
    );
  }
  if (/我已经跑完了/.test(text)) add('activity.run_self_reported_done', bool(true));
  if (/我这次偏好安静/.test(text))
    add('preference.quiet', bool(true), { kind: 'current_state', validFrom: day.from, validTo: day.to });
  if (/我平时喜欢安静/.test(text)) {
    add('preference.quiet', bool(true), { kind: 'explicit_preference' });
    if (/绝不接受未经确认/.test(text))
      add('public_activity.unconfirmed_allowed', bool(false), { strength: 'hard' });
  }
  if (/CANARY/.test(text) && /喜欢|昵称/.test(text))
    add('preference.synthetic', word(text), { kind: 'explicit_preference' });
  return { status: changes.length ? 'candidate_emitted' : 'no_personal_fact', changes };
}

export class ScriptedSemanticClient extends DeepSeekClient {
  readonly requests: WireMessage[][] = [];
  injected: { name: string; args: unknown }[] = [];
  fail = false;
  constructor(readonly entities: Record<string, string> = {}) {
    super('synthetic-not-a-real-key', 'scripted-contract');
  }
  override async complete(
    messages: WireMessage[],
    _tools: ToolSpec[],
    signal: AbortSignal,
    onText?: (text: string) => void,
  ): Promise<Completion> {
    signal.throwIfAborted();
    this.requests.push(structuredClone(messages));
    if (this.fail) throw new ProviderError('模拟模型认证不可用。');
    // Explicit offline protocol fixture. This is not a production parser and
    // does not certify semantic understanding of any of these expressions.
    const submit = (name: string, value: unknown): Completion => ({ content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(value) } }] });
    if (_tools.length === 1 && _tools[0].function.name === 'propose_turn_controls') {
      const text = messages.find(m => m.role === 'user')?.content || '';
      const currentOnly = /只(?:用|根据|按|看).*附件|不要用.*(?:历史|以前)|不带以前/.test(text);
      return submit('propose_turn_controls', { retention: /不保存|不要保存|不落盘/.test(text) ? 'session_only' : /不长期记|不要记住/.test(text) ? 'history_no_inference' : 'unchanged', sourceAllowlist: currentOnly ? ['current'] : null, sourceExclusions: [], sourceBasis: currentOnly ? text : null, subject: /替室友/.test(text) ? 'other' : 'self', world: /假设|假如/.test(text) ? 'hypothetical' : 'real', audience: 'self', actions: /先别保存|不提交/.test(text) ? 'draft_only' : 'unchanged', actionsApplyToWholeTurn: /先别保存|不提交/.test(text), specificActionLimits: [], release: null, basis: [text], uncertain: false, uncertainControls: [] });
    }
    if (_tools.length === 1 && _tools[0].function.name === 'report_completion_gaps') return submit('report_completion_gaps', { missing: [], contradictions: [], requests: [] });
    if (_tools.length === 1 && _tools[0].function.name === 'verify_local_delegation') {
      const request = JSON.parse(messages[1].content!);
      if (request.action?.scope === 'local_goal_only' && request.action.operation === 'cancel') return submit('verify_local_delegation', { decision: 'execute_local', basis: [{ id: request.current.id, quote: request.current.text }], missing: [], reason: 'Explicit offline cancellation fixture; no semantic accuracy claim.' });
      return submit('verify_local_delegation', { decision: 'draft_only', basis: [], missing: [], reason: 'Offline fixture never automatically authorizes an effect.' });
    }
    if (_tools.length === 1 && _tools[0].function.name === 'verify_read_purpose') return submit('verify_read_purpose', { allowed: false, sourceQuote: '', reason: 'Offline fixture does not grant sensitive read purpose.' });
    const system = messages[0]?.content || '';
    if (system.includes('[harness:extract')) {
      const parsed = JSON.parse(messages[1].content!);
      return { content: JSON.stringify(scriptedExtraction(parsed, this.entities)), tool_calls: [] };
    }
    if (system.includes('[harness:verify')) {
      const parsed = JSON.parse(messages[1].content!);
      return {
        content: JSON.stringify({
          supported: parsed.source.text.includes(parsed.candidate.sourceQuote),
          preservesSubject: true,
          preservesWorld: true,
          preservesTime: true,
          preservesConditions: true,
          retention: 'allowed',
          temporalType: parsed.candidate.validTo ? 'temporary' : parsed.candidate.validFrom ? 'future' : 'stable',
          reason: 'Scripted conformance response; no real semantic accuracy claim',
        }),
        tool_calls: [],
      };
    }
    const envelopeText = messages.filter((m) => m.role === 'user').at(-1)?.content || '';
    const authored = envelopeText.startsWith('以下是宿主按本轮范围提供的资料') ? envelopeText.slice(envelopeText.indexOf('\n\n') + 2) : envelopeText,
      hasTool = messages.slice(messages.findLastIndex(m => m.role === 'user') + 1).some((m) => m.role === 'tool');
    let call = this.injected.shift();
    if (!call && !hasTool) {
      if (/原文|原话/.test(authored)) call = { name: 'search_context', args: { query: authored.slice(0, 400) } };
      else if (/(?:方案准备|准备.*申请)|按搬寝室方案准备/.test(authored))
        call = {
          name: 'update_work_state',
          args: {
            operation: 'propose_task',
            kind: 'prepare_application',
            title: '准备申请资料',
            sourceQuote: authored,
          },
        };
      else if (/两条路线.*准备/.test(authored))
        call = {
          name: 'update_work_state',
          args: {
            operation: 'propose_task',
            kind: 'prepare_portfolio',
            title: '准备共用作品材料',
            sourceQuote: authored,
          },
        };
      else if (/草拟.*安排.*先别保存/.test(authored))
        call = {
          name: 'prepare_action',
          args: { title: '今晚的本地安排', detail: '受控模型提出的草稿，等待用户明确确认。' },
        };
      else if (/安排.*休息|休息.*别优化掉/.test(authored))
        call = {
          name: 'update_work_state',
          args: {
            operation: 'propose_plan',
            candidate: {
              id: 'rest-plan-' + randomUUID(),
              title: '保留自主休息时间',
              activity: 'schedule',
              needs: [],
              dependencies: [],
              resourceCapabilities: [],
              preservesUnstructuredTime: true,
              rationale: '原文明确要求保留休息',
            },
          },
        };
    }
    if (call)
      return {
        content: '',
        tool_calls: [
          {
            id: randomUUID(),
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      };
    const content = '受控模型已返回。本轮仅按可用证据进行比较，未执行外部操作。';
    onText?.(content);
    return { content, tool_calls: [] };
  }
}
