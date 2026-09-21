import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FileText, LoaderCircle, Pause, Pencil, RotateCcw, X } from 'lucide-react';
import type { Action, Bridge, Message, RuntimeOverview, State } from '../shared/types';
import type { Condition, EffectAction, EvidenceEvent, MemoryView } from '../shared/harness';
import { IconButton, Modal, Switch } from './ui';

const api = window.zaichang;
export const failureText = (e: unknown) =>
  String(e instanceof Error ? e.message : e)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^Error: /, '');
const date = (v?: string) =>
  v
    ? new Date(v).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';
const localTime = (v?: string) => {
  if (!v) return '';
  const d = new Date(v);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const names: Record<string, string> = {
  schedule: '安排',
  exams: '考试',
  sports: '运动记录',
  origin: '出发地点',
  precise_origin: '精确起点',
  financial_coverage: '可用资金',
  food_service_status: '供餐时间',
  independent_performance: '独立完成的证据',
  'destination.eligibility': '目的地入口',
  transport: '交通方式',
  device: '可用设备',
  location: '地点',
  'running.today_allowed': '今天是否跑步',
};
export const needName = (key: string) =>
  names[key] ||
  (/device|computer|equipment/.test(key)
    ? '可用设备'
    : /origin|location|route/.test(key)
      ? '地点与路线'
      : /time|deadline/.test(key)
          ? '时间限制'
          : /permission|grant/.test(key)
            ? '使用授权'
            : '相关条件');
const knowledge: Record<string, string> = {
  fresh: '已核对',
  stale: '来源可能已过期',
  partial: '只取得部分',
  unknown: '尚不确定',
  not_queried: '尚未查询',
  not_found: '未找到',
  unsupported: '尚未接入',
  forbidden: '本轮未授权',
  conflict: '来源有冲突',
  failed: '查询未完成',
  known_absent: '已确认没有记录',
  cancelled: '已停止',
};
const sourceName = (e: EvidenceEvent) =>
  e.fileName ||
  {
    'history:self': '对话原文',
    'profile:self': '你在记忆页的修改',
    'work:self': '你的反馈',
    'local-agenda': '本地安排',
  }[e.sourceId] ||
  '资料原文';
export function EvidencePreview({ eventId }: { eventId: string }) {
  const [e, setEvidence] = useState<EvidenceEvent | null>(),
    [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api
      .evidence(eventId)
      .then((v) => {
        if (current) setEvidence(v);
      })
      .catch((e) => {
        if (current) setError(failureText(e));
      });
    return () => {
      current = false;
    };
  }, [eventId]);
  if (error)
    return (
      <p className="harness-inline-error" role="alert">
        {error}
      </p>
    );
  if (e === undefined) return <p className="harness-muted">正在打开原文…</p>;
  if (!e) return <p className="harness-muted">这份原文已删除或不在可查看范围内。</p>;
  return (
    <div className="evidence-preview">
      <div>
        <FileText size={14} />
        <strong>{sourceName(e)}</strong>
        <time>{date(e.receivedAt)}</time>
      </div>
      <p>{e.text || '内容已删除'}</p>
      {e.status === 'redacted' && <small>已删除的段落不再显示</small>}
    </div>
  );
}
export function ReplyEvidence({ message }: { message: Message }) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState('');
  const r = message.contextReceipt,
    s = message.scopeSummary;
  if (!r && !s) return null;
  const scope =
    s?.retention === 'session_only'
      ? '本轮不保存'
      : s?.memoryMode === 'current_sources_only'
        ? '只用本条与附件'
        : s?.memoryMode === 'none'
          ? '未参考记忆'
          : '按需参考资料';
  const interpretationLabel = s?.interpretation
    ? {
        listen: '先听你说',
        listen_and_local: '先听你说，同时记一件本地安排',
        analyze: '分析并按需核对',
        act: '直接登记本地安排',
        mixed: '分别处理这几件事',
      }[s.interpretation.posture]
      : '';
  const surfaceLabel = s?.audience === 'group' ? '群消息草稿' : s?.audience === 'public' ? '公开草稿' : scope;
  return (
    <div className="reply-evidence">
      <button className="text-button evidence-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          {surfaceLabel}
        </span>
        <ChevronRight size={13} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="evidence-detail">
          <p className="harness-muted">
            这里是实际提供的资料与查询状态。草稿还没有发送。
            {r
              ? ` ${r.coverage === 'blocked' ? '条件不足' : r.coverage === 'conditional' ? '有资料待核对' : `${r.providedEvidenceIds.length} 条来源`}`
              : ''}
          </p>
          {s?.interpretation && (
            <div className="interpretation-summary">
              <strong>本轮理解</strong>
              <p>
                {interpretationLabel} · {s.interpretation.fragmentCount} 个请求片段
              </p>
              {!!s.interpretation.unresolvedReferences.length && (
                <p className="harness-inline-warning">
                  有一处指代待确认：{s.interpretation.unresolvedReferences.join('、')}
                </p>
              )}
            </div>
          )}
          {s?.release && (
            <div className="release-summary">
              <strong>{s.release.mode === 'send' ? '发送意图已识别，但当前只生成草稿' : '只生成草稿'}</strong>
              <p>
                收件人：{s.release.recipient} · 目的：{s.release.purpose}
              </p>
              <p>语气：{s.release.tone}。发送服务未接入，需由你复制或在原服务中发送。</p>
              {!!s.release.allowedFacts.length && <p>允许写入：{s.release.allowedFacts.join('、')}</p>}
            </div>
          )}
          {r?.needResults.length ? (
            <ul className="need-list">
              {r.needResults.map((n, i) => (
                <li key={n.key + i}>
                  <span>{needName(n.key)}</span>
                  <span>{knowledge[n.status] || '待核对'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {s?.retention !== 'session_only' &&
            r?.providedEvidenceIds.map((id, i) => (
              <div key={id}>
                <button
                  className="text-button evidence-source-button"
                  onClick={() => setSelected(selected === id ? '' : id)}
                >
                  <FileText size={13} />
                  查看来源 {i + 1}
                  <ChevronRight size={12} />
                </button>
                {selected === id && <EvidencePreview eventId={id} />}
              </div>
            ))}
          {(!r?.providedEvidenceIds.length || s?.retention === 'session_only') && (
            <p className="harness-muted">
              {s?.retention === 'session_only'
                ? '仅在本轮使用，关闭对话后不留原文。'
                : '这轮没有提供可长期保留的原文来源。'}
            </p>
          )}
          {r && r.watermarks.extractionGaps.length > 0 && (
            <p className="harness-muted">部分原文尚未整理为理解；允许使用的原文仍可按需参考。</p>
          )}
        </div>
      )}
    </div>
  );
}
export type TurnControls = NonNullable<Parameters<Bridge['send']>[0]['controls']>;
export function ScopeSettings({
  value,
  onChange,
  onClose,
}: {
  value: TurnControls;
  onChange: (v: TurnControls) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="本轮怎么用资料" onClose={onClose} className="scope-panel">
      <div className="panel-body">
        <p className="panel-intro">只作用于下一条消息。你也可以直接在对话里说明。</p>
        <label className="field-label">
          可以参考什么
          <select
            aria-label="本轮参考范围"
            value={value.memoryMode || 'relevant'}
            onChange={(e) => onChange({ ...value, memoryMode: e.target.value as TurnControls['memoryMode'] })}
          >
            <option value="relevant">按需参考相关资料</option>
            <option value="current_sources_only">只看本条消息与附件</option>
            <option value="none">不参考个人记忆与历史</option>
          </select>
        </label>
        <label className="field-label">
          这条消息怎样保留
          <select
            aria-label="本轮保留方式"
            value={value.retention || 'purpose_scoped'}
            onChange={(e) => onChange({ ...value, retention: e.target.value as TurnControls['retention'] })}
          >
            <option value="purpose_scoped">保留对话，允许整理相关理解</option>
            <option value="history_no_inference">保留对话，不形成长期理解</option>
            <option value="session_only">本轮不保存</option>
          </select>
        </label>
        <label className="field-label">
          回复准备给谁看
          <select
            aria-label="本轮回复受众"
            value={value.audience || 'self'}
            onChange={(e) => onChange({ ...value, audience: e.target.value as TurnControls['audience'] })}
          >
            <option value="self">只给我看</option>
            <option value="group">准备给群里看的草稿</option>
            <option value="public">准备公开的草稿</option>
          </select>
        </label>
        {value.retention === 'session_only' && (
          <p className="scope-explanation">
            本轮输入和附件不保存到历史，也不形成安排或长期理解。连接模型时仍需发送本轮允许的内容。
          </p>
        )}
        {value.audience && value.audience !== 'self' && (
          <p className="scope-explanation">只使用你允许公开的内容；不会自动发送。</p>
        )}
        <button className="primary-button" onClick={onClose}>
          用于下一条消息
        </button>
      </div>
    </Modal>
  );
}
function describeCondition(c: Condition): string {
  if (c.op === 'all' && !c.terms.length) return '通常适用';
  if (c.op === 'unknown') return '条件待确认';
  if (c.op === 'all' || c.op === 'any')
    return c.terms.map(describeCondition).join(c.op === 'all' ? '，并且' : '，或');
  if (c.op === 'not') return '不满足：' + describeCondition(c.term);
  if (c.op === 'compare') {
    const v = c.value;
    return `${needName(c.predicate)} ${({ eq: '为', ne: '不为', lt: '少于', lte: '不超过', gt: '超过', gte: '不少于' } as Record<string, string>)[c.comparator] || c.comparator} ${'value' in v ? String(v.value) : '待确认'}${'unit' in v ? ' ' + v.unit : ''}`;
  }
  return '有附加条件';
}
export function UnderstandingPanel({
  state,
  onState,
  busy,
}: {
  state: State;
  onState: (s: State) => void;
  busy: boolean;
}) {
  const editForm = useRef<HTMLFormElement>(null);
  const [data, setData] = useState<RuntimeOverview>(),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [pending, setPending] = useState('');
  const [text, setText] = useState(''),
    [edit, setEdit] = useState<MemoryView>(),
    [operation, setOperation] = useState<'CORRECT' | 'SUPERSEDE' | 'ADD_EXCEPTION'>('CORRECT'),
    [from, setFrom] = useState(''),
    [until, setUntil] = useState(''),
    [filter, setFilter] = useState('all'),
    [source, setSource] = useState('');
  useEffect(() => {
    let mounted = true;
    api
      .runtimeOverview()
      .then((v) => {
        if (mounted) setData(v);
      })
      .catch((e) => {
        if (mounted) setError(failureText(e));
      });
    return () => {
      mounted = false;
    };
  }, [state]);
  async function act(name: string, fn: () => Promise<void>) {
    if (pending) return;
    setPending(name);
    setError('');
    setStatus('');
    try {
      await fn();
      setData(await api.runtimeOverview());
    } catch (e) {
      setError(failureText(e));
    } finally {
      setPending('');
    }
  }
  function editMemory(m: MemoryView) {
    setEdit(m);
    setText(m.text);
    setOperation('CORRECT');
    setFrom(localTime(m.validFrom));
    setUntil(localTime(m.validTo));
    setError('');
    requestAnimationFrame(() => editForm.current?.querySelector('textarea')?.focus());
  }
  const priority: Record<string, number> = { active: 0, candidate: 1, disputed: 1, inactive: 2, expired: 3 };
  const memories = [...(data?.memories || [])].sort(
      (a, b) => (priority[a.status] ?? 4) - (priority[b.status] ?? 4),
    ),
    visible = memories.filter(
      (m) =>
        filter === 'all' ||
        (filter === 'active' && m.status === 'active') ||
        (filter === 'pending' && ['candidate', 'disputed'].includes(m.status)) ||
        (filter === 'inactive' && ['inactive', 'expired'].includes(m.status)),
    );
  return (
    <section className="understanding-panel">
      <div className="settings-lede">
        <p className="panel-intro">会影响之后对话的内容，都在这里。你可以随时改正、停用或删除。</p>
      </div>
      <Switch
        checked={state.settings.memoryEnabled}
        label="记住我明确说出的偏好"
        detail="关闭后，不再参考记忆与历史，也不形成新的个人理解"
        disabled={!!pending || (busy && !state.settings.memoryEnabled)}
        onChange={(v) =>
          void act('toggle', async () => {
            onState(await api.saveSettings({ memoryEnabled: v }));
          })
        }
      />
      <div className="understanding-heading">
        <div>
          <strong>已保存的理解</strong>
          <small>{memories.length ? `${memories.length} 条` : '还没有记录'}</small>
        </div>
        <select aria-label="筛选理解状态" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部状态</option>
          <option value="active">正在使用</option>
          <option value="pending">待确认</option>
          <option value="inactive">已停用或过期</option>
        </select>
      </div>
      <div className="memory-list">
        {visible.map((m) => (
          <div className={`memory-item understanding-item ${m.status}`} key={m.id}>
            <div className="understanding-content">
              <div className="understanding-meta">
                <span>
                  {(
                    {
                      active: '正在使用',
                      candidate: '待确认',
                      disputed: '有待核对',
                      inactive: '已停用',
                      expired: '已过期',
                    } as Record<string, string>
                  )[m.status] || '不再使用'}
                </span>
                <small>
                  {m.verification === 'verified'
                    ? '有原文依据'
                    : m.verification === 'unverified'
                      ? '旧记录 · 原文未核实'
                      : '尚未核验'}
                </small>
              </div>
              <p>{m.text}</p>
              <div className="understanding-limits">
                {m.status === 'candidate' || m.status === 'disputed'
                  ? '适用范围待确认'
                  : m.status === 'inactive'
                    ? '原条件已保留，当前不使用'
                    : describeCondition(JSON.parse(m.conditions))}
                {m.validFrom ? ` · ${date(m.validFrom)} 起` : ''}
                {m.validTo ? ` · 至 ${date(m.validTo)}` : ''}
              </div>
              <div className="understanding-buttons">
                <button className="memory-source" onClick={() => setSource(source === m.id ? '' : m.id)}>
                  查看原话
                  <ChevronRight size={12} />
                </button>
                <button
                  className="text-button"
                  aria-label={`修改记忆：${m.text}`}
                  onClick={() => editMemory(m)}
                >
                  <Pencil size={13} />
                  改正
                </button>
                {m.status !== 'inactive' && (
                  <button
                    className="text-button"
                    disabled={!!pending}
                    onClick={() =>
                      void act('deactivate', async () => {
                        onState(await api.memory({ action: 'deactivate', id: m.id }));
                        setStatus('已停用，保留原话供你查看。');
                      })
                    }
                  >
                    <Pause size={12} />
                    停用
                  </button>
                )}
                <IconButton
                  label={`删除记忆：${m.text}`}
                  disabled={!!pending}
                  onClick={() =>
                    void act('delete', async () => {
                      onState(await api.memory({ action: 'delete', id: m.id }));
                      setStatus('已清理这条理解与相关派生内容。旧建议需重新核对。');
                    })
                  }
                >
                  <X size={14} />
                </IconButton>
              </div>
              {source === m.id &&
                (m.evidenceIds.length ? (
                  m.evidenceIds.map((id) => <EvidencePreview key={id} eventId={id} />)
                ) : (
                  <p className="memory-quote">原话无法定位，这条记录尚不作为已核实理解。</p>
                ))}
            </div>
          </div>
        ))}
      </div>
      {!visible.length && (
        <p className="memory-empty">
          {memories.length ? '这个状态下没有记录。' : '可以先聊起来，需要时再逐渐了解。'}
        </p>
      )}
      <form
        ref={editForm}
        className="memory-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act('save', async () => {
            onState(
              await api.memory({
                action: 'save',
                id: edit?.id,
                expectedRevision: edit?.revision,
                text: text.trim(),
                operation: edit ? operation : undefined,
                conditions: edit ? JSON.parse(edit.conditions) : undefined,
                validFrom: from ? new Date(from).toISOString() : undefined,
                validTo: until ? new Date(until).toISOString() : undefined,
              }),
            );
            setText('');
            setEdit(undefined);
            setFrom('');
            setUntil('');
            setStatus('已保存，下一轮将按更新后的理解处理。');
          });
        }}
      >
        <div className="form-heading">
          <strong>{edit ? '修改理解' : '添加一条理解'}</strong>
          <small>{edit ? '这次修改会从下一轮开始生效' : '只保存你明确说出的内容'}</small>
        </div>
        <label className="field-label">
          {edit ? '修改这条理解' : '告诉在场一件小事'}
          <textarea
            aria-label="偏好内容"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4000}
            rows={3}
            placeholder="例如：我通常喜欢连续学习，但今天只想休息"
          />
        </label>
        {edit && (
          <label className="field-label">
            这次是什么变化
            <select
              aria-label="理解修改方式"
              value={operation}
              onChange={(e) => setOperation(e.target.value as typeof operation)}
            >
              <option value="CORRECT">之前说错了，改正原理解</option>
              <option value="SUPERSEDE">现实有变化，从指定时间开始</option>
              <option value="ADD_EXCEPTION">原理解保留，补充这次例外</option>
            </select>
          </label>
        )}
        <details className="understanding-time" open={!!edit || undefined}>
          <summary>
            适用时间 <span>可选；当日例外需要结束时间</span>
          </summary>
          <div className="understanding-dates">
            <label className="field-label">
              开始时间
              <input
                aria-label="理解开始时间"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                required={operation === 'SUPERSEDE' && !!edit}
              />
            </label>
            <label className="field-label">
              结束时间
              <input
                aria-label="理解结束时间"
                type="datetime-local"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                min={from || undefined}
                required={operation === 'ADD_EXCEPTION' && !!edit}
              />
            </label>
          </div>
        </details>
        <div className="field-buttons">
          <button className="primary-button" disabled={!!pending || !text.trim()}>
            {pending === 'save' && <LoaderCircle size={14} className="spin" />}
            {edit ? '保存修改' : '记住这件事'}
          </button>
          {edit && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setEdit(undefined);
                setText('');
                setFrom('');
                setUntil('');
                setError('');
              }}
            >
              取消修改
            </button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="harness-inline-error">
          {error}
          <button className="text-button" onClick={() => void api.runtimeOverview().then(setData)}>
            刷新记录
          </button>
        </p>
      )}
      {status && (
        <p role="status" className="harness-inline-status">
          {status}
        </p>
      )}
      {!!data?.processing.length && (
        <details className="processing-overview">
          <summary>
            还有原文待整理 <span>{data.processing.length} 条</span>
          </summary>
          <p className="harness-muted">按段保留处理状态。重试只使用有权保留和整理的原文。</p>
          {data.processing.map((p) => (
            <div className="processing-row" key={p.eventId}>
              <div>
                <span>{p.fileName || date(p.receivedAt)}</span>
                <small>
                  {p.pending ? `${p.pending} 段待处理` : '有内容待确认'}
                  {p.failed ? ` · ${p.failed} 段需重试或补充` : ''}
                </small>
              </div>
              <button
                className="text-button"
                disabled={!!pending || busy || state.settings.mode !== 'deepseek'}
                onClick={() =>
                  void act('retry', async () => {
                    setData(await api.retryProcessing(p.eventId));
                    setStatus('本次整理已检查；尚不明确的内容仍保留待确认。');
                  })
                }
              >
                <RotateCcw size={13} />
                重试整理
              </button>
            </div>
          ))}
          {state.settings.mode !== 'deepseek' && (
            <p className="harness-muted">连接 DeepSeek 后可整理，本地示例不会猜测个人事实。</p>
          )}
        </details>
      )}
    </section>
  );
}
export function FeedbackControl({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [response, setResponse] = useState<'accepted' | 'declined'>('declined'),
    [status, setStatus] = useState(''),
    [pending, setPending] = useState(false);
  return (
    <div className="feedback-control">
      <button className="text-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        反馈这条建议
      </button>
      {open && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            try {
              await api.feedback({
                recommendationId: messageId,
                response,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              });
              setStatus('已记下反馈；实际结果仍待观察。');
              setOpen(false);
            } catch (error) {
              setStatus(failureText(error));
            } finally {
              setPending(false);
            }
          }}
        >
          <label className="field-label">
            这次是否合适
            <select value={response} onChange={(e) => setResponse(e.target.value as typeof response)}>
              <option value="declined">不太适合我</option>
              <option value="accepted">对我有帮助</option>
            </select>
          </label>
          <label className="field-label">
            原因 <small>可选</small>
            <input
              aria-label="建议反馈原因"
              value={reason}
              maxLength={1200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：今天更想留点空白"
            />
          </label>
          <button className="subtle-button" disabled={pending}>
            保存反馈
          </button>
        </form>
      )}
      {status && (
        <span className="harness-muted" role="status">
          {status}
        </span>
      )}
    </div>
  );
}
export function WorkAndReceipts({
  onResume,
  onChanged,
}: {
  onResume: (sessionId: string) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<RuntimeOverview>(),
    [error, setError] = useState(''),
    [pending, setPending] = useState('');
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  useEffect(() => {
    api
      .runtimeOverview()
      .then(setData)
      .catch((e) => setError(failureText(e)));
  }, []);
  async function action(id: string, fn: () => Promise<RuntimeOverview>) {
    setPending(id);
    setError('');
    try {
      setData(await fn());
      onChanged();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setPending('');
    }
  }
  const goals = data?.work.filter((w) => w.kind === 'goal') || [],
    episodes =
      data?.work.filter((w) => w.kind === 'episode' && w.data.sessionId && w.data.nextSmallQuestion) || [],
    unknown =
      data?.actions.filter((a) =>
        [
          'outcome_unknown',
          'unresolved',
          'cancel_requested',
          'cannot_cancel',
          'cancellation_unknown',
        ].includes(a.action.status),
      ) || [],
    localSaved =
      data?.actions.filter(({ action: a, receipts }) =>
        a.executionTier === 'direct_local' &&
        a.status === 'succeeded' &&
        receipts.at(-1)?.status === 'confirmed_success' &&
        receipts.at(-1)?.localStatus === 'local_saved',
      ) || [],
    failed = data?.actions.filter(({ action: a }) => a.status === 'failed_confirmed') || [];
  const preparations = data?.work.filter((w) => w.kind === 'task' && w.data.adoptionItemId) || [];
  const hasSecondary = !!(
    unknown.length ||
    localSaved.length ||
    failed.length ||
    goals.length ||
    data?.worlds.length ||
    preparations.length ||
    episodes.length
  );
  if (data && !hasSecondary && !error) return null;
  return (
    <div className="work-receipts">
      {!!localSaved.length && (
        <section>
          <h3>本机回执</h3>
          {localSaved.map(({ action: a, receipts }) => {
            const item = localActionItem(a);
            const observedAt = receipts.at(-1)?.observedAt;
            return (
              <div className="work-row action-receipt-row" key={a.id}>
                <div className="work-row-heading">
                  <strong>{String(a.arguments.title || '本机安排')}</strong>
                  <span>已确认登记</span>
                </div>
                <p>
                  本机安排已写入，可撤销；不会因此声称外部提醒或送达。
                  {observedAt ? ` 回执时间：${date(observedAt)}。` : ''}
                </p>
                <div className="field-buttons">
                  <button
                    className="text-button"
                    disabled={!!pending}
                    onClick={() =>
                      void action(a.id, async () => {
                        await api.action({ action: 'delete', item });
                        return api.runtimeOverview();
                      })
                    }
                  >
                    {pending === a.id ? '正在撤销…' : '撤销本机登记'}
                  </button>
                </div>
                <small>{a.simulated ? '模拟能力 · ' : ''}可在原聊天卡片或这里撤销</small>
              </div>
            );
          })}
        </section>
      )}
      {!!failed.length && (
        <section>
          <h3>登记未完成</h3>
          {failed.map(({ action: a, receipts }) => (
            <div className="work-row action-receipt-row" key={a.id}>
              <div className="work-row-heading">
                <strong>{String(a.arguments.title || '待处理动作')}</strong>
                <span>未确认</span>
              </div>
              <p>
                本次登记没有完成，不能当作已保存。
                {receipts.at(-1)?.reason ? ` 原因：${receipts.at(-1)?.reason}` : ''}
              </p>
              <small>{a.simulated ? '模拟能力' : '可回到原对话重新决定'}</small>
            </div>
          ))}
        </section>
      )}
      {!!unknown.length && (
        <section>
          <h3>有结果需要核查</h3>
          {unknown.map(({ action: a, receipts }) => (
            <div className="work-row" key={a.id}>
              <strong>{String(a.arguments.title || '待核查动作')}</strong>
              <p>
                {a.status === 'cannot_cancel'
                  ? '提供方无法撤回，已发生的结果可能仍存在。'
                  : a.status === 'unresolved'
                    ? '目前无法自动核查。请到原服务确认结果，确认前不要再次提交。'
                    : '结果尚未确定，请先核查，不要重复执行。'}
              </p>
              {['outcome_unknown', 'cancel_requested'].includes(a.status) ? (
                <button
                  className="subtle-button"
                  disabled={!!pending}
                  onClick={() => void action(a.id, () => api.reconcileAction(a.id))}
                >
                  {pending === a.id ? '正在核查…' : '核查结果'}
                </button>
              ) : (
                <span className="receipt-manual-check">需到原服务确认</span>
              )}
              <small>
                {receipts.at(-1)?.observedAt
                  ? `最近核查 ${date(receipts.at(-1)?.observedAt)}`
                  : '尚无确认回执'}
                {a.simulated ? ' · 模拟能力' : ''}
              </small>
            </div>
          ))}
        </section>
      )}
      {!!goals.length && (
        <section>
          <h3>你决定要推进的事</h3>
          {goals.map((g) => (
            <div className="work-row" key={g.id}>
              <div className="work-row-heading">
                <strong>{g.title}</strong>
                <span>
                  {(
                    {
                      proposed: '待你决定',
                      active: '进行中',
                      paused: '已暂停',
                      cancelled: '已取消',
                    } as Record<string, string>
                  )[g.status] || '需要重新核对'}
                </span>
              </div>
              {typeof g.data.reason === 'string' && <p>{g.data.reason}</p>}
              {g.status !== 'cancelled' && (
                <div className="field-buttons">
                  <button
                    className="subtle-button"
                    disabled={!!pending}
                    onClick={() =>
                      void action(g.id, () =>
                        api.goal({
                          id: g.id,
                          expectedRevision: g.revision,
                          status: g.status === 'active' ? 'paused' : 'active',
                        }),
                      )
                    }
                  >
                    {g.status === 'active' ? '暂停' : g.status === 'proposed' ? '采用这个目标' : '恢复目标'}
                  </button>
                  <button
                    className="text-button"
                    disabled={!!pending}
                    onClick={() =>
                      void action(g.id, () =>
                        api.goal({ id: g.id, expectedRevision: g.revision, status: 'cancelled' }),
                      )
                    }
                  >
                    取消目标
                  </button>
                </div>
              )}
              {g.status === 'paused' && <small>恢复后需重新核对安排；旧提醒不会自动启动。</small>}
            </div>
          ))}
        </section>
      )}
      {!!data?.worlds.length && (
        <section className="world-review">
          <h3>把设想变成准备</h3>
          <p className="harness-muted">逐项选择后，只建立准备事项。现实事实、承诺和外部动作不会随之改变。</p>
          {data.worlds.map((w) => (
            <details key={w.worldId}>
              <summary>{w.status === 'stale' ? '现实条件已变，需要重新比较' : '查看这份设想的变化'}</summary>
              {w.items.map((item) => (
                <label className="world-item" key={item.id}>
                  <input
                    type="checkbox"
                    aria-label="选择这项设想作为准备事项"
                    checked={selectedItems.includes(item.id)}
                    disabled={w.status === 'stale' || !!pending}
                    onChange={(e) =>
                      setSelectedItems((ids) =>
                        e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span>
                    <strong>
                      {typeof item.proposed === 'string' ? item.proposed : JSON.stringify(item.proposed)}
                    </strong>
                    <small>设想 → 待准备事项</small>
                  </span>
                </label>
              ))}
              <button
                className="subtle-button"
                disabled={
                  w.status === 'stale' || !!pending || !w.items.some((i) => selectedItems.includes(i.id))
                }
                onClick={() =>
                  void action(w.worldId, async () => {
                    const result = await api.adoptWorld({
                      id: w.worldId,
                      itemIds: w.items.filter((i) => selectedItems.includes(i.id)).map((i) => i.id),
                      expectedBaseRevision: w.baseRevision,
                      expectedPrivacyEpoch: data.privacyEpoch,
                    });
                    setSelectedItems([]);
                    return result;
                  })
                }
              >
                建立选中的准备事项
              </button>
            </details>
          ))}
        </section>
      )}
      {!!preparations.length && (
        <section>
          <h3>准备事项</h3>
          {preparations.map((w) => (
            <div className="work-row" key={w.id}>
              <strong>{w.title}</strong>
              <small>来自你选中的设想 · 尚未执行</small>
            </div>
          ))}
        </section>
      )}
      {!!episodes.length && (
        <section>
          <h3>可以接着聊</h3>
          {episodes.map((e) => {
            const sessionIds = Array.isArray(e.data.sessionIds)
              ? e.data.sessionIds.filter((value): value is string => typeof value === 'string')
              : [];
            const resumeSession =
              (typeof e.data.lastSessionId === 'string' && e.data.lastSessionId) ||
              sessionIds.at(-1) ||
              String(e.data.sessionId);
            return (
            <button key={e.id} className="resume-work" onClick={() => onResume(resumeSession)}>
              <span>
                <strong>{e.title}</strong>
                <small>{String(e.data.nextSmallQuestion)}</small>
              </span>
              <ChevronRight size={15} />
            </button>
            );
          })}
        </section>
      )}
      <details className="delivery-details">
        <summary>提醒与资料状态</summary>
        <p>
          提醒只在应用运行时检查。
          {data?.notifications.submitted ? '本机支持提交系统通知。' : '本机尚不能提交系统通知。'}
          系统提交不代表已送达或已读。
        </p>
        <p>聊天数据库暂未整体加密；密钥由操作系统保护。导出文件也需由你妥善保管。</p>
      </details>
      {error && (
        <p role="alert" className="harness-inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

function localActionItem(action: EffectAction): Action {
  const args = action.arguments;
  return {
    id: action.id,
    title: typeof args.title === 'string' && args.title.trim() ? args.title : '本机安排',
    detail: typeof args.detail === 'string' ? args.detail : '',
    startsAt: typeof args.startsAt === 'string' ? args.startsAt : undefined,
    durationMinutes: typeof args.durationMinutes === 'number' ? args.durationMinutes : undefined,
    saved: true,
    revision: action.revision,
    approvalDigest: action.digest,
    coverage: 'verified',
  };
}

/** User-facing memory view. Internal lifecycle/verification labels stay behind
 * the source disclosure; the first scan answers only what can change a reply. */
export function MemoryPanel({
  state,
  onState,
  busy,
}: {
  state: State;
  onState: (s: State) => void;
  busy: boolean;
}) {
  const editForm = useRef<HTMLFormElement>(null);
  const [data, setData] = useState<RuntimeOverview>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<MemoryView>();
  const [operation, setOperation] = useState<'CORRECT' | 'SUPERSEDE' | 'ADD_EXCEPTION'>('CORRECT');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');

  useEffect(() => {
    let mounted = true;
    api
      .runtimeOverview()
      .then((value) => {
        if (mounted) setData(value);
      })
      .catch((value) => {
        if (mounted) setError(failureText(value));
      });
    return () => {
      mounted = false;
    };
  }, [state]);

  async function act(name: string, fn: () => Promise<void>) {
    if (pending) return;
    setPending(name);
    setError('');
    setNotice('');
    try {
      await fn();
      setData(await api.runtimeOverview());
    } catch (value) {
      setError(failureText(value));
    } finally {
      setPending('');
    }
  }

  function editMemory(memory: MemoryView) {
    setEdit(memory);
    setText(memory.text);
    setOperation('CORRECT');
    setFrom(localTime(memory.validFrom));
    setUntil(localTime(memory.validTo));
    setEditorOpen(true);
    setError('');
    requestAnimationFrame(() => editForm.current?.querySelector('textarea')?.focus());
  }

  function clearEditor() {
    setEdit(undefined);
    setText('');
    setFrom('');
    setUntil('');
    setEditorOpen(false);
  }

  const memories = data?.memories || [];
  const current = memories.filter((memory) => memory.status === 'active');
  const needsDecision = memories.filter((memory) => ['candidate', 'disputed'].includes(memory.status));
  const archived = memories.filter((memory) => !['active', 'candidate', 'disputed'].includes(memory.status));

  function renderMemory(memory: MemoryView, group: 'current' | 'decision' | 'archived') {
    const temporal = [
      memory.validFrom ? `从 ${date(memory.validFrom)}` : '',
      memory.validTo ? `到 ${date(memory.validTo)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const condition = (() => {
      try {
        const parsed = JSON.parse(memory.conditions) as Condition;
        return parsed.op === 'all' && !parsed.terms.length ? '' : describeCondition(parsed);
      } catch {
        return '';
      }
    })();
    return (
      <article className={`memory-item memory-item-${group}`} key={memory.id}>
        <div className="memory-item-main">
          {group === 'decision' && <div className="memory-item-kicker">需要你决定</div>}
          <p className="memory-item-text">{memory.text}</p>
          {(condition || temporal) && (
            <p className="memory-item-context">
              {condition || '在指定时间内适用'}
              {temporal ? ` · ${temporal}` : ''}
            </p>
          )}
          <div className="memory-item-actions">
            <button
              className="memory-source"
              onClick={() => setSource(source === memory.id ? '' : memory.id)}
            >
              为什么这样理解
              <ChevronRight size={12} />
            </button>
            {group === 'decision' && (
              <button
                className="text-button"
                disabled={!!pending}
                onClick={() =>
                  void act('keep', async () => {
                    onState(
                      await api.memory({
                        action: 'save',
                        id: memory.id,
                        expectedRevision: memory.revision,
                        text: memory.text,
                        operation: 'CORRECT',
                        conditions: JSON.parse(memory.conditions),
                        validFrom: memory.validFrom,
                        validTo: memory.validTo,
                      }),
                    );
                    setNotice('已保留；之后只在相关问题中参考。');
                  })
                }
              >
                保留并使用
              </button>
            )}
            {group !== 'archived' && (
              <button className="text-button" onClick={() => editMemory(memory)}>
                <Pencil size={13} />
                改正
              </button>
            )}
            {group === 'current' && (
              <button
                className="text-button"
                disabled={!!pending}
                onClick={() =>
                  void act('deactivate', async () => {
                    onState(await api.memory({ action: 'deactivate', id: memory.id }));
                    setNotice('已停用；原话仍可在已停用内容中查看。');
                  })
                }
              >
                暂时停用
              </button>
            )}
            {group === 'decision' && (
              <button
                className="text-button"
                disabled={!!pending}
                onClick={() =>
                  void act('deactivate', async () => {
                    onState(await api.memory({ action: 'deactivate', id: memory.id }));
                    setNotice('已先停用，不会作为确定理解使用。');
                  })
                }
              >
                先不使用
              </button>
            )}
            <IconButton
              label={`删除：${memory.text}`}
              disabled={!!pending}
              onClick={() =>
                void act('delete', async () => {
                  onState(await api.memory({ action: 'delete', id: memory.id }));
                  setNotice('已删除这条理解及相关的本机派生内容。');
                })
              }
            >
              <X size={14} />
            </IconButton>
          </div>
          {source === memory.id && (
            <div className="memory-source-reveal">
              {memory.evidenceIds.length ? (
                memory.evidenceIds.map((id) => <EvidencePreview key={id} eventId={id} />)
              ) : (
                <p className="memory-quote">暂时没有可定位的原话；这条内容不会被当作已核实依据。</p>
              )}
              <p className="memory-source-meta">
                {memory.verification === 'verified' ? '来源已核验' : '来源仍待核对'} · 记录于{' '}
                {date(memory.createdAt)}
              </p>
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <section className="memory-panel-v2">
      <p className="panel-intro">这里只放会影响之后对话的内容。你可以随时改变它。</p>
      <Switch
        checked={state.settings.memoryEnabled}
        label="让在场参考这些理解"
        detail="关闭后，不再读取或保存长期理解"
        disabled={!!pending || (busy && !state.settings.memoryEnabled)}
        onChange={(value) =>
          void act('toggle', async () => {
            onState(await api.saveSettings({ memoryEnabled: value }));
          })
        }
      />

      {current.length > 0 && (
        <section className="memory-group memory-group-current">
          <div className="memory-group-heading">
            <h3>现在会影响回答</h3>
            <small>{current.length} 条</small>
          </div>
          <div className="memory-list">{current.map((memory) => renderMemory(memory, 'current'))}</div>
        </section>
      )}

      {needsDecision.length > 0 && (
        <section className="memory-group memory-group-decision">
          <div className="memory-group-heading">
            <h3>需要你决定</h3>
            <small>暂不作为确定理解</small>
          </div>
          <div className="memory-list">{needsDecision.map((memory) => renderMemory(memory, 'decision'))}</div>
        </section>
      )}

      {archived.length > 0 && (
        <details className="memory-group memory-group-archived">
          <summary className="memory-group-heading">
            <h3>已停用的内容</h3>
            <small>{archived.length} 条</small>
          </summary>
          <div className="memory-list">{archived.map((memory) => renderMemory(memory, 'archived'))}</div>
        </details>
      )}

      {!memories.length && (
        <p className="memory-empty">还没有需要管理的理解。可以先聊起来，需要时再逐渐了解。</p>
      )}

      <details
        className="memory-editor"
        open={editorOpen}
        onClick={(event) => {
          if ((event.target as HTMLElement).tagName === 'SUMMARY') {
            event.preventDefault();
            setEditorOpen((open) => !open);
          }
        }}
      >
        <summary>
          <span>{edit ? '修改理解' : '添加一条理解'}</span>
          <small>{edit ? '保存后从下一轮开始生效' : '只保存你明确说出的内容'}</small>
        </summary>
        <form
          ref={editForm}
          onSubmit={(event) => {
            event.preventDefault();
            void act('save', async () => {
              onState(
                await api.memory({
                  action: 'save',
                  id: edit?.id,
                  expectedRevision: edit?.revision,
                  text: text.trim(),
                  operation: edit ? operation : undefined,
                  conditions: edit ? JSON.parse(edit.conditions) : undefined,
                  validFrom: from ? new Date(from).toISOString() : undefined,
                  validTo: until ? new Date(until).toISOString() : undefined,
                }),
              );
              clearEditor();
              setNotice('已保存；下一轮会按更新后的理解处理。');
            });
          }}
        >
          <label className="field-label">
            {edit ? '改成什么' : '告诉在场一件小事'}
            <textarea
              aria-label="偏好内容"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={4000}
              rows={3}
              placeholder="例如：我通常喜欢连续学习，但今天只想休息"
            />
          </label>
          {edit && (
            <label className="field-label">
              变化方式
              <select
                aria-label="理解修改方式"
                value={operation}
                onChange={(event) => setOperation(event.target.value as typeof operation)}
              >
                <option value="CORRECT">之前说错了，改正原理解</option>
                <option value="SUPERSEDE">现实有变化，从指定时间开始</option>
                <option value="ADD_EXCEPTION">原理解保留，补充这次例外</option>
              </select>
            </label>
          )}
          <details className="understanding-time" open={!!edit || undefined}>
            <summary>
              适用时间 <span>可选</span>
            </summary>
            <div className="understanding-dates">
              <label className="field-label">
                开始时间
                <input
                  aria-label="理解开始时间"
                  type="datetime-local"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  required={operation === 'SUPERSEDE' && !!edit}
                />
              </label>
              <label className="field-label">
                结束时间
                <input
                  aria-label="理解结束时间"
                  type="datetime-local"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                  min={from || undefined}
                  required={operation === 'ADD_EXCEPTION' && !!edit}
                />
              </label>
            </div>
          </details>
          <div className="field-buttons">
            <button className="primary-button" disabled={!!pending || !text.trim()}>
              {pending === 'save' && <LoaderCircle size={14} className="spin" />}
              {edit ? '保存修改' : '记住这件事'}
            </button>
            {edit && (
              <button className="text-button" type="button" onClick={clearEditor}>
                取消
              </button>
            )}
          </div>
        </form>
      </details>

      {error && (
        <p role="alert" className="harness-inline-error">
          {error}
          <button className="text-button" onClick={() => void api.runtimeOverview().then(setData)}>
            刷新
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="harness-inline-status">
          {notice}
        </p>
      )}
      {!!data?.processing.length && (
        <details className="processing-overview">
          <summary>
            还有内容待整理 <span>{data.processing.length} 条</span>
          </summary>
          <p className="harness-muted">处理状态只在需要时显示；未整理的原文不会被默认为长期理解。</p>
          {data.processing.map((item) => (
            <div className="processing-row" key={item.eventId}>
              <div>
                <span>{item.fileName || date(item.receivedAt)}</span>
                <small>{item.pending ? `${item.pending} 段待处理` : '有内容待确认'}</small>
              </div>
              <button
                className="text-button"
                disabled={!!pending || busy || state.settings.mode !== 'deepseek'}
                onClick={() =>
                  void act('retry', async () => {
                    setData(await api.retryProcessing(item.eventId));
                    setNotice('已重新检查；仍不明确的内容会保留待确认。');
                  })
                }
              >
                <RotateCcw size={13} />
                重试
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

/** A deliberately quiet memory surface: one question per view, one expanded
 * item at a time. Lifecycle terminology belongs in the detail action, not in
 * the first scan. */
export function MemoryPanelSimple({
  state,
  onState,
  busy,
}: {
  state: State;
  onState: (s: State) => void;
  busy: boolean;
}) {
  const editForm = useRef<HTMLFormElement>(null);
  const [data, setData] = useState<RuntimeOverview>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<MemoryView>();
  const [operation, setOperation] = useState<'CORRECT' | 'SUPERSEDE' | 'ADD_EXCEPTION'>('CORRECT');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');

  useEffect(() => {
    let mounted = true;
    api
      .runtimeOverview()
      .then((value) => mounted && setData(value))
      .catch((value) => mounted && setError(failureText(value)));
    return () => {
      mounted = false;
    };
  }, [state]);

  async function act(name: string, fn: () => Promise<void>) {
    if (pending) return;
    setPending(name);
    setError('');
    setNotice('');
    try {
      await fn();
      setData(await api.runtimeOverview());
    } catch (value) {
      setError(failureText(value));
    } finally {
      setPending('');
    }
  }

  function openEditor(memory?: MemoryView) {
    setEdit(memory);
    setText(memory?.text || '');
    setOperation('CORRECT');
    setFrom(localTime(memory?.validFrom));
    setUntil(localTime(memory?.validTo));
    setEditorOpen(true);
    setExpandedId('');
    requestAnimationFrame(() => editForm.current?.querySelector('textarea')?.focus());
  }
  function closeEditor() {
    setEdit(undefined);
    setText('');
    setFrom('');
    setUntil('');
    setEditorOpen(false);
  }

  const memories = data?.memories || [];
  const current = memories.filter((memory) => memory.status === 'active');
  const decision = memories.filter((memory) => ['candidate', 'disputed'].includes(memory.status));
  const archived = memories.filter((memory) => !['active', 'candidate', 'disputed'].includes(memory.status));

  function contextLine(memory: MemoryView) {
    let condition = '';
    try {
      const parsed = JSON.parse(memory.conditions) as Condition;
      condition = parsed.op === 'all' && !parsed.terms.length ? '' : describeCondition(parsed);
    } catch {
      /* keep the first scan quiet when old data has no condition */
    }
    const times = [
      memory.validFrom ? `从 ${date(memory.validFrom)}` : '',
      memory.validTo ? `到 ${date(memory.validTo)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return [condition, times].filter(Boolean).join(' · ');
  }

  function row(memory: MemoryView, kind: 'current' | 'decision' | 'archived') {
    const expanded = expandedId === memory.id;
    const sourceOpen = sourceId === memory.id;
    const line = contextLine(memory);
    return (
      <article className={`memory-row memory-row-${kind}`} key={memory.id}>
        <button
          type="button"
          className="memory-row-summary"
          aria-expanded={expanded}
          onClick={() => {
            setExpandedId(expanded ? '' : memory.id);
            setSourceId('');
          }}
        >
          <span className="memory-row-copy">
            <strong>{memory.text}</strong>
            {kind === 'archived' && <small>已停用</small>}
          </span>
          <ChevronRight size={15} className={expanded ? 'rotated' : ''} />
        </button>
        {expanded && (
          <div className="memory-row-detail">
            {line && <p className="memory-row-context">{line}</p>}
            <button
              className="memory-detail-source"
              type="button"
              onClick={() => setSourceId(sourceOpen ? '' : memory.id)}
            >
              {sourceOpen ? '收起来源' : '查看来源'}
              <ChevronRight size={13} className={sourceOpen ? 'rotated' : ''} />
            </button>
            {sourceOpen && (
              <div className="memory-source-reveal">
                {memory.evidenceIds.length ? (
                  memory.evidenceIds.map((id) => <EvidencePreview key={id} eventId={id} />)
                ) : (
                  <p className="memory-quote">暂时没有可定位的原话，这条内容不会被当作已核实依据。</p>
                )}
                <p className="memory-source-meta">
                  {memory.verification === 'verified' ? '来源已核验' : '来源仍待核对'} · 记录于{' '}
                  {date(memory.createdAt)}
                </p>
              </div>
            )}
            <div className="memory-detail-actions">
              {kind === 'decision' && (
                <button
                  className="memory-detail-action primary"
                  disabled={!!pending}
                  onClick={() =>
                    void act('keep', async () => {
                      onState(
                        await api.memory({
                          action: 'save',
                          id: memory.id,
                          expectedRevision: memory.revision,
                          text: memory.text,
                          operation: 'CORRECT',
                          conditions: JSON.parse(memory.conditions),
                          validFrom: memory.validFrom,
                          validTo: memory.validTo,
                        }),
                      );
                      setNotice('已保留，之后只在相关问题中参考。');
                      setExpandedId('');
                    })
                  }
                >
                  保留并使用
                </button>
              )}
              {kind !== 'archived' && (
                <button className="memory-detail-action" onClick={() => openEditor(memory)}>
                  <Pencil size={13} />
                  改正这条内容
                </button>
              )}
              {kind === 'current' && (
                <button
                  className="memory-detail-action"
                  disabled={!!pending}
                  onClick={() =>
                    void act('deactivate', async () => {
                      onState(await api.memory({ action: 'deactivate', id: memory.id }));
                      setNotice('已停用；它不会再影响之后的回答。');
                      setExpandedId('');
                    })
                  }
                >
                  暂时停用
                </button>
              )}
              {kind === 'decision' && (
                <button
                  className="memory-detail-action"
                  disabled={!!pending}
                  onClick={() =>
                    void act('deactivate', async () => {
                      onState(await api.memory({ action: 'deactivate', id: memory.id }));
                      setNotice('已先停用，不会作为确定理解使用。');
                      setExpandedId('');
                    })
                  }
                >
                  先不使用
                </button>
              )}
              <button
                className="memory-detail-action danger"
                disabled={!!pending}
                onClick={() =>
                  void act('delete', async () => {
                    onState(await api.memory({ action: 'delete', id: memory.id }));
                    setNotice('已删除这条理解及相关的本机派生内容。');
                    setExpandedId('');
                  })
                }
              >
                删除
              </button>
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <section className="memory-panel-simple">
      <p className="panel-intro">只保留会帮到你的几件事。需要时可以改，也可以删掉。</p>
      <Switch
        checked={state.settings.memoryEnabled}
        label="参考已保存的内容"
        detail="关闭后，不再用这些内容回答，也不会新增长期理解"
        disabled={!!pending || (busy && !state.settings.memoryEnabled)}
        onChange={(value) =>
          void act('toggle', async () => {
            onState(await api.saveSettings({ memoryEnabled: value }));
          })
        }
      />
      {!!current.length && (
        <section className="memory-group-simple">
          <div className="memory-group-heading">
            <h3>会影响回答</h3>
            <small>{current.length} 条</small>
          </div>
          {current.map((memory) => row(memory, 'current'))}
        </section>
      )}
      {!!(decision.length || archived.length || data?.processing.length) && (
        <details className="memory-more-simple">
          <summary>
            <span>其他内容</span>
            <small>{decision.length + archived.length + (data?.processing.length || 0)} 条</small>
          </summary>
          <div className="memory-more-content">
            {!!decision.length && (
              <section className="memory-subgroup memory-review-simple">
                <h3>等你确认</h3>
                <p className="memory-subgroup-intro">确认后才会影响回答。</p>
                <div>{decision.map((memory) => row(memory, 'decision'))}</div>
              </section>
            )}
            {!!archived.length && (
              <section className="memory-subgroup memory-archive-simple">
                <h3>已停用</h3>
                <div>{archived.map((memory) => row(memory, 'archived'))}</div>
              </section>
            )}
            {!!data?.processing.length && (
              <section className="memory-subgroup processing-overview">
                <h3>还没整理完</h3>
                <p className="harness-muted">不明确的原话不会自动变成长期理解。</p>
                {data.processing.map((item) => (
                  <div className="processing-row" key={item.eventId}>
                    <div>
                      <span>{item.fileName || date(item.receivedAt)}</span>
                      <small>{item.pending ? `${item.pending} 段待处理` : '有内容待确认'}</small>
                    </div>
                    <button
                      className="text-button"
                      disabled={!!pending || busy || state.settings.mode !== 'deepseek'}
                      onClick={() =>
                        void act('retry', async () => {
                          setData(await api.retryProcessing(item.eventId));
                          setNotice('已重新检查；仍不明确的内容会保留待确认。');
                        })
                      }
                    >
                      <RotateCcw size={13} />
                      重试
                    </button>
                  </div>
                ))}
              </section>
            )}
          </div>
        </details>
      )}
      {!memories.length && (
        <p className="memory-empty">还没有需要管理的内容。可以先聊起来，需要时再逐渐了解。</p>
      )}
      <div className={`memory-editor-simple ${editorOpen ? 'open' : ''}`}>
        {!editorOpen ? (
          <button type="button" className="memory-add-trigger" onClick={() => openEditor()}>
            <span>告诉在场一件事</span>
            <small>只保存你明确说出的内容</small>
            <ChevronRight size={15} />
          </button>
        ) : (
          <form
            ref={editForm}
            onSubmit={(event) => {
              event.preventDefault();
              void act('save', async () => {
                onState(
                  await api.memory({
                    action: 'save',
                    id: edit?.id,
                    expectedRevision: edit?.revision,
                    text: text.trim(),
                    operation: edit ? operation : undefined,
                    conditions: edit ? JSON.parse(edit.conditions) : undefined,
                    validFrom: from ? new Date(from).toISOString() : undefined,
                    validTo: until ? new Date(until).toISOString() : undefined,
                  }),
                );
                closeEditor();
                setNotice('已保存；下一轮会按更新后的理解处理。');
              });
            }}
          >
            <div className="memory-editor-heading">
              <strong>{edit ? '改正这条内容' : '添加一条理解'}</strong>
              <button type="button" className="text-button" onClick={closeEditor}>
                取消
              </button>
            </div>
            <label className="field-label">
              {edit ? '改成什么' : '告诉在场一件小事'}
              <textarea
                aria-label="偏好内容"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={4000}
                rows={3}
                placeholder="例如：我通常喜欢连续学习，但今天只想休息"
              />
            </label>
            {edit && (
              <label className="field-label">
                变化方式
                <select
                  aria-label="理解修改方式"
                  value={operation}
                  onChange={(event) => setOperation(event.target.value as typeof operation)}
                >
                  <option value="CORRECT">之前说错了，改正原理解</option>
                  <option value="SUPERSEDE">现实有变化，从指定时间开始</option>
                  <option value="ADD_EXCEPTION">原理解保留，补充这次例外</option>
                </select>
              </label>
            )}
            <details className="understanding-time" open={!!edit || undefined}>
              <summary>
                适用时间 <span>可选</span>
              </summary>
              <div className="understanding-dates">
                <label className="field-label">
                  开始时间
                  <input
                    aria-label="理解开始时间"
                    type="datetime-local"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    required={operation === 'SUPERSEDE' && !!edit}
                  />
                </label>
                <label className="field-label">
                  结束时间
                  <input
                    aria-label="理解结束时间"
                    type="datetime-local"
                    value={until}
                    onChange={(event) => setUntil(event.target.value)}
                    min={from || undefined}
                    required={operation === 'ADD_EXCEPTION' && !!edit}
                  />
                </label>
              </div>
            </details>
            <button className="primary-button" disabled={!!pending || !text.trim()}>
              {pending === 'save' && <LoaderCircle size={14} className="spin" />}
              {edit ? '保存修改' : '记住这件事'}
            </button>
          </form>
        )}
      </div>
      {error && (
        <p role="alert" className="harness-inline-error">
          {error}
          <button className="text-button" onClick={() => void api.runtimeOverview().then(setData)}>
            刷新
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="harness-inline-status">
          {notice}
        </p>
      )}
    </section>
  );
}
