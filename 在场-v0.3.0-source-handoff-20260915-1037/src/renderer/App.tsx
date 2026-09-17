import { Portal, IconButton, Modal } from './ui';
import { SettingsPanel, type SettingsDraft } from './SettingsPanel';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  ArrowDown,
  Plus,
  X,
  Minus,
  Square,
  History,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  CalendarDays,
  Coffee,
  Dumbbell,
  Check,
  Circle,
  LoaderCircle,
  CircleAlert,
  RotateCcw,
  Copy,
  Trash2,
  Search,
  ArrowUpRight,
  Pencil,
  FileText,
  CheckCheck,
  Bell,
  Paperclip,
  Image as ImageIcon,
  MapPinned,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Action, Draft, Memory, Message, State } from '../shared/types';
import { LIMITS } from '../shared/limits';
import { emptyRoute, type MapCard, type MapRouteResult } from '../shared/map-v2';
import { MapRouteCard, MapSheet } from './map/CampusMap';
import {
  ReplyEvidence,
  ScopeSettings,
  FeedbackControl,
  WorkAndReceipts,
  needName,
  type TurnControls,
} from './HarnessViews';

const api = window.zaichang;
type Panel = 'history' | 'settings' | 'agenda' | null;
const formatDate = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
function errorText(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^Error: /, '');
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const boundaryRevision = useRef('');
  const [turnControls, setTurnControls] = useState<TurnControls>({});
  const turnControlsRef = useRef<TurnControls>({});
  const [scopeOpen, setScopeOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const sessionRef = useRef<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [attachment, setAttachment] = useState<Draft['attachment']>(null);
  const draftRef = useRef<Draft>({ text: '', attachment: null }),
    draftKey = useRef('new'),
    draftRevision = useRef(0),
    navigation = useRef(0);
  const settingsDraft = useRef<SettingsDraft>({});
  const [draftReady, setDraftReady] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const attachmentControl = useRef<HTMLDivElement>(null),
    attachmentTrigger = useRef<HTMLButtonElement>(null);
  const knownMemories = useRef(new Set<string>()),
    activeRun = useRef(false);
  const [memoryNotice, setMemoryNotice] = useState<Memory | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState('');
  const [starting, setStarting] = useState(false);
  const startupCredentialNotice = useRef(false);
  const [navigating, setNavigating] = useState(false),
    navigationPending = useRef(false);
  const [away, setAway] = useState(false);
  const [mapSheet, setMapSheet] = useState<MapRouteResult | null>(null);
  const [previewImage, setPreviewImage] = useState<Message['image']>();
  const scrollRef = useRef<HTMLDivElement>(null),
    inputRef = useRef<HTMLTextAreaElement>(null),
    followRef = useRef(true);
  const busy = starting || messages.some((m) => m.status === 'running');
  const empty = messages.length === 0;
  const openAgendaCount = state?.agenda.filter((a) => !a.done).length || 0;
  function useSuggestion(text: string) {
    if (draftRef.current.text.trim()) {
      inputRef.current?.focus();
      return;
    }
    replaceDraft({ ...draftRef.current, text });
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  function notify(message: string) {
    setToast(message);
  }
  async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      notify(errorText(e));
    }
  }
  function updateState(next: State) {
    const revision = `${next.privacyEpoch}:${next.policyRevision}`;
    if (boundaryRevision.current && revision !== boundaryRevision.current && sessionRef.current) {
      const selected = sessionRef.current;
      void api
        .messages(selected)
        .then((saved) => {
          if (selected !== sessionRef.current) return;
          setMessages((current) => current.map((m) => saved.find((s) => s.id === m.id) || m));
        })
        .catch(() => {});
      setMemoryNotice(null);
    }
    boundaryRevision.current = revision;
    knownMemories.current = new Set(next.memories.map((m) => m.id));
    setState(next);
  }
  function replaceDraft(next: Draft, persist = true) {
    draftRevision.current++;
    draftRef.current = next;
    setInput(next.text);
    setAttachment(next.attachment);
    if (persist && turnControlsRef.current.retention !== 'session_only')
      void attempt(() => api.saveDraft({ id: draftKey.current, draft: next }));
  }
  function updateDraft(part: Partial<Draft>) {
    replaceDraft({ ...draftRef.current, ...part });
  }
  useEffect(() => {
    if (!api) {
      notify('请从桌面程序打开在场。');
      return;
    }
    void attempt(async () => {
      const [next, saved] = await Promise.all([api.state(), api.draft('new')]);
      updateState(next);
      if (
        !startupCredentialNotice.current &&
        next.settings.mode === 'deepseek' &&
        (!next.settings.hasKey || next.settings.keyStatus === 'invalid')
      ) {
        startupCredentialNotice.current = true;
        notify(
          next.settings.keyStatus === 'invalid'
            ? '已保存的 DeepSeek API Key 无法读取，请打开连接设置重新输入并保存。'
            : '还没有配置 DeepSeek API Key，请打开连接设置后再发送。',
        );
      }
      if (!draftRevision.current) replaceDraft(saved, false);
      setDraftReady(true);
    });
    return api.onEvent((event) => {
      if (event.type === 'conversations') {
        setState((current) => (current ? { ...current, conversations: event.conversations } : current));
        return;
      }
      if (event.type === 'state') {
        const added = event.state.memories.find((m) => !knownMemories.current.has(m.id));
        if (added && activeRun.current) setMemoryNotice(added);
        updateState(event.state);
        return;
      }
      if (!sessionRef.current) {
        sessionRef.current = event.message.sessionId;
        setSessionId(event.message.sessionId);
      }
      if (event.message.sessionId !== sessionRef.current) return;
      if (event.message.role === 'assistant') activeRun.current = event.message.status === 'running';
      setMessages((previous) => {
        const index = previous.findIndex((m) => m.id === event.message.id);
        return index < 0
          ? [...previous, event.message]
          : previous.map((m, i) => (i === index ? event.message : m));
      });
    });
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 2800);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    if (!attachmentMenu) return;
    const close = (e: PointerEvent) => {
      if (!attachmentControl.current?.contains(e.target as Node)) setAttachmentMenu(false);
    };
    document.addEventListener('pointerdown', close);
    attachmentControl.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', close);
  }, [attachmentMenu]);
  useEffect(() => {
    if (followRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }
  }, [input]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (mapSheet) return;
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && (!panel || panel === 'history')) {
        e.preventDefault();
        setPanel((p) => (p === 'history' ? null : 'history'));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !panel) {
        e.preventDefault();
        if (!busy) void newChat();
      }
      if (e.key === 'Escape' && attachmentMenu) {
        setAttachmentMenu(false);
        attachmentTrigger.current?.focus();
        return;
      }
      if (e.key === 'Escape' && busy && !panel) void api.stop();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, panel, attachmentMenu, mapSheet]);
  async function newChat() {
    if (busy || navigationPending.current) return;
    navigationPending.current = true;
    setNavigating(true);
    const token = ++navigation.current;
    setToast('');
    setMemoryNotice(null);
    setAttachmentMenu(false);
    await attempt(async () => {
      const saved = await api.draft('new');
      if (token !== navigation.current) return;
      draftKey.current = 'new';
      replaceDraft(saved, false);
      sessionRef.current = undefined;
      setSessionId(undefined);
      setMessages([]);
      setPanel(null);
      followRef.current = true;
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    navigationPending.current = false;
    setNavigating(false);
  }
  async function openConversation(id: string) {
    if (busy) {
      notify('先停止当前回复，再打开另一段对话。');
      return;
    }
    const token = ++navigation.current;
    setToast('');
    setMemoryNotice(null);
    setAttachmentMenu(false);
    await attempt(async () => {
      const [next, saved] = await Promise.all([api.messages(id), api.draft(id)]);
      if (token !== navigation.current) return;
      draftKey.current = id;
      replaceDraft(saved, false);
      sessionRef.current = id;
      setSessionId(id);
      setMessages(next);
      setPanel(null);
      followRef.current = true;
    });
  }
  async function send(
    value = draftRef.current.text,
    consumeDraft = true,
    retryImage?: Message['image'],
  ) {
    const text = value.trim();
    if (!text || busy || navigationPending.current || !draftReady) return;
    const revision = draftRevision.current,
      previousKey = draftKey.current;
    const file = consumeDraft ? draftRef.current.attachment : null,
      image = file?.kind === 'image' ? file : retryImage;
    const content =
      text +
      (file?.kind === 'text' ? `\n\n[用户附上的文字资料：${file.name}]\n${file.text}` : '');
    setStarting(true);
    setToast('');
    setMemoryNotice(null);
    setAttachmentMenu(false);
    followRef.current = true;
    try {
      const controls = consumeDraft ? turnControlsRef.current : undefined;
      const result = await api.send({ sessionId, content, controls, ...(image ? { image } : {}) });
      sessionRef.current = result.sessionId;
      setSessionId(result.sessionId);
      draftKey.current = result.sessionId;
      if (consumeDraft && revision === draftRevision.current) replaceDraft({ text: '', attachment: null });
      else replaceDraft(draftRef.current);
      if (previousKey === 'new')
        void attempt(() => api.saveDraft({ id: 'new', draft: { text: '', attachment: null } }));
      if (consumeDraft) {
        turnControlsRef.current = {};
        setTurnControls({});
      }
    } catch (e) {
      notify(errorText(e));
    } finally {
      setStarting(false);
      inputRef.current?.focus();
    }
  }
  async function saveAction(item: Action, action: 'save' | 'delete' | 'done' = 'save') {
    await attempt(async () => {
      updateState(await api.action({ item, action }));
      if (action !== 'save') notify(action === 'done' ? '这件事，完成了。' : '已移除这项安排。');
    });
  }
  const composer = (
    <div className="composer-area">
      <form
        className={`composer ${busy ? 'is-busy' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {attachment && (
          <div className="attachment">
            {attachment.kind === 'image' ? (
              <img className="attachment-preview" src={attachment.dataUrl} alt="" />
            ) : (
              <FileText size={15} />
            )}
            <span>{attachment.name}</span>
            <small>{attachment.kind === 'image' ? '图片 · 随本条发送' : '随本条发送'}</small>
            <IconButton label="移除附件" onClick={() => updateDraft({ attachment: null })}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        <textarea
          ref={inputRef}
          aria-label="和在场说说"
          placeholder={busy ? '可以先写下新的想法…' : '把想做的事，交给在场…'}
          value={input}
          rows={1}
          maxLength={LIMITS.draftText}
          disabled={!draftReady || navigating}
          onChange={(e) => updateDraft({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy) void send();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-left">
            <div className="attachment-control" ref={attachmentControl}>
              <button
                ref={attachmentTrigger}
                className="icon-button"
                type="button"
                aria-label="添加资料"
                title="添加资料"
                aria-haspopup="menu"
                aria-expanded={attachmentMenu}
                onClick={() => setAttachmentMenu(!attachmentMenu)}
                disabled={!draftReady}
              >
                <Plus size={21} />
              </button>
              {attachmentMenu && (
                <div
                  className="attachment-menu"
                  role="menu"
                  aria-label="添加资料"
                  onKeyDown={(e) => {
                    const items = [
                      ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
                    ];
                    const i = items.indexOf(document.activeElement as HTMLButtonElement);
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
                    }
                    if (e.key === 'Tab') setAttachmentMenu(false);
                  }}
                >
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setAttachmentMenu(false);
                      void attempt(async () => {
                        const image = await api.attachImage();
                        if (image) updateDraft({ attachment: image });
                        inputRef.current?.focus();
                      });
                    }}
                  >
                    <ImageIcon size={18} />
                    <span>
                      添加图片<small>JPG、PNG 或 WebP</small>
                    </span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setAttachmentMenu(false);
                      void attempt(async () => {
                        const file = await api.attachText();
                        if (file) updateDraft({ attachment: file });
                        inputRef.current?.focus();
                      });
                    }}
                  >
                    <Paperclip size={18} />
                    <span>
                      添加文件<small>文本与 Markdown</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`composer-context-button ${Object.keys(turnControls).length ? 'selected' : ''}`}
              onClick={() => setScopeOpen(true)}
              aria-label="设置本轮资料范围"
            >
              <span>{state?.settings.mode === 'deepseek' ? 'DeepSeek' : '本地示例'}</span>
              <span className="composer-context-separator" aria-hidden="true">
                ·
              </span>
              <span>
                {turnControls.retention === 'session_only'
                  ? '本轮不保存'
                  : turnControls.memoryMode === 'current_sources_only'
                    ? '只看本条与附件'
                    : turnControls.audience && turnControls.audience !== 'self'
                      ? '公开草稿范围'
                      : '本轮范围'}
              </span>
              <ChevronDown size={12} />
            </button>
          </div>
          <div className="composer-right">
            {busy ? (
              <button
                className="send-button stop"
                type="button"
                title="停止回复 · Esc"
                aria-label="停止回复"
                onClick={() => void attempt(() => api.stop())}
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-button"
                type="submit"
                aria-label="发送"
                title="发送 · Enter"
                disabled={!input.trim() || !draftReady}
              >
                <ArrowUp size={22} />
              </button>
            )}
          </div>
        </div>
      </form>
      <div className="composer-foot">
        <span className="keyboard-hint">Shift + Enter 换行</span>
      </div>
    </div>
  );

  const renderedMessages = useMemo(
    () =>
      messages.map((m, index) => (
        <MessageView
          key={m.id}
          message={m}
          agenda={state?.agenda || []}
          onSave={(item) => void saveAction(item)}
          onRevoke={(item) => saveAction(item, 'delete')}
          onViewAgenda={() => setPanel('agenda')}
          onOpenMap={(route) => setMapSheet(route)}
          onPreviewImage={setPreviewImage}
          onCopy={() =>
            void attempt(async () => {
              await api.copyText(m.content);
              notify('已复制。');
            })
          }
          onRetry={() => {
            const user = messages
              .slice(0, index)
              .reverse()
              .find((v) => v.role === 'user');
            if (user) void send(user.content, false, user.image);
          }}
          busy={busy}
          boundary={`${state?.privacyEpoch}:${state?.policyRevision}`}
        />
      )),
    [messages, state?.agenda, state?.privacyEpoch, state?.policyRevision, busy],
  );

  const memoryHint = memoryNotice && (
    <div className="memory-notice" role="status">
      <span>
        {(memoryNotice as Memory & { status?: string }).status === 'candidate' ? '待确认：' : '记住了：'}
        {memoryNotice.text}
      </span>
      <button
        onClick={() =>
          void attempt(async () => {
            updateState(await api.memory({ action: 'delete', id: memoryNotice.id }));
            setMemoryNotice(null);
          })
        }
      >
        撤销
      </button>
      <IconButton label="收起记忆提示" onClick={() => setMemoryNotice(null)}>
        <X size={13} />
      </IconButton>
    </div>
  );

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="traffic-lights" aria-label="窗口控制">
          <button
            aria-label="关闭在场"
            title="关闭在场"
            className="traffic close"
            onClick={() => api.window('close')}
          >
            <X size={8} />
          </button>
          <button
            aria-label="最小化"
            title="最小化"
            className="traffic minimize"
            onClick={() => api.window('minimize')}
          >
            <Minus size={8} />
          </button>
          <button
            aria-label="最大化或还原"
            title="最大化或还原"
            className="traffic maximize"
            onClick={() => api.window('maximize')}
          >
            <Square size={7} />
          </button>
        </div>
        <button className="brand" onClick={() => !busy && newChat()} aria-label="在场，回到开始">
          <Portal size={24} />
          <span>在场</span>
        </button>
        <div className="drag-space" />
        <nav className="top-actions" aria-label="常用操作">
          <IconButton label="新的对话" onClick={newChat} disabled={busy}>
            <Pencil size={18} />
          </IconButton>
          <IconButton label="历史对话" onClick={() => setPanel('history')}>
            <History size={19} />
          </IconButton>
          <IconButton
            label={openAgendaCount ? `我的安排，${openAgendaCount} 项待完成` : '我的安排'}
            onClick={() => setPanel('agenda')}
          >
            <CalendarDays size={18} />
            {!!openAgendaCount && <i className="notification-dot" aria-hidden="true" />}
          </IconButton>
          <IconButton label="打开校园地图" onClick={() => setMapSheet(emptyRoute())}>
            <MapPinned size={19} />
          </IconButton>
          <IconButton label="连接与偏好" onClick={() => setPanel('settings')}>
            <SlidersHorizontal size={18} />
          </IconButton>
        </nav>
      </header>
      <main className={`workspace ${empty ? 'welcome' : 'conversation'}`}>
        {empty ? (
          <div className="welcome-inner">
            <div className="welcome-symbol">
              <Portal size={49} />
              <span />
            </div>
            <h1>今天，从哪件事开始？</h1>
            <p className="welcome-copy">想理清安排，或者随便聊聊，都可以。</p>
            {state &&
              state.settings.mode === 'deepseek' &&
              (!state.settings.hasKey || state.settings.keyStatus === 'invalid') && (
                <div className="startup-connection-notice" role="alert">
                  <span>
                    {state.settings.keyStatus === 'invalid'
                      ? '已保存的 DeepSeek API Key 无法读取，当前不会发送请求。'
                      : '尚未配置 DeepSeek API Key，当前不会发送请求。'}
                  </span>
                  <button className="text-button" onClick={() => setPanel('settings')}>
                    打开连接设置
                  </button>
                </div>
              )}
            {composer}
            <div className="suggestions" aria-label="试着聊聊">
              <button onClick={() => useSuggestion('帮我安排一下今天')}>
                <CalendarDays size={15} />
                安排一下今天
                <ArrowUpRight className="suggestion-arrow" size={13} />
              </button>
              <button onClick={() => useSuggestion('从主图书馆到紫金港食堂（东区）怎么走？')}>
                <MapPinned size={15} aria-hidden="true" />
                去东区食堂怎么走
                <ArrowUpRight className="suggestion-arrow" size={13} />
              </button>
              <button onClick={() => useSuggestion('最近有点累，想缓一缓')}>
                <Coffee size={15} />
                最近有点累
                <ArrowUpRight className="suggestion-arrow" size={13} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              className="message-scroll"
              ref={scrollRef}
              onScroll={() => {
                const el = scrollRef.current!;
                followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                setAway(!followRef.current);
              }}
            >
              <div className="messages">{renderedMessages}</div>
            </div>
            <div className="bottom-composer">
              {away && (
                <button
                  className="scroll-bottom"
                  aria-label="回到最新消息"
                  onClick={() => {
                    followRef.current = true;
                    scrollRef.current?.scrollTo({
                      top: scrollRef.current.scrollHeight,
                      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                        ? 'instant'
                        : 'smooth',
                    });
                  }}
                >
                  <ArrowDown size={17} />
                </button>
              )}
              {memoryHint}
              {composer}
            </div>
          </>
        )}
      </main>
      <footer className="app-footer">
        <span className="app-footer-status">
          {state?.settings.mode === 'deepseek' ? (
            <>
              <span
                className={`status-dot ${state.settings.hasKey ? 'configured' : ''}`}
                aria-hidden="true"
              />
              DeepSeek {state.settings.hasKey ? '已连接' : '未连接'}
            </>
          ) : (
            <>本地示例</>
          )}
        </span>
      </footer>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {busy ? '正在处理你的请求。' : messages.at(-1)?.status === 'done' ? '回复已准备好。' : ''}
      </div>
      {panel === 'history' && state && (
        <HistoryPanel
          state={state}
          busy={busy}
          onClose={() => setPanel(null)}
          onOpen={openConversation}
          onDelete={async (id) => {
            await attempt(async () => {
              updateState(await api.deleteConversation(id));
              if (id === sessionId) newChat();
            });
          }}
        />
      )}
      {panel === 'agenda' && state && (
        <Modal title="我的安排" onClose={() => setPanel(null)}>
          <div className="panel-body agenda-panel">
            <p className="panel-intro">已经确认的本地安排在这里；还没确认的建议仍留在对话中。</p>
            {state.agenda.length ? (
              <div className="agenda-list">
                {state.agenda.map((a) => (
                  <div className={`agenda-item ${a.done ? 'done' : ''}`} key={a.id}>
                    <IconButton
                      label={a.done ? '已标记完成（仅本机）' : `标记完成（仅本机）：${a.title}`}
                      onClick={() => !a.done && void saveAction(a, 'done')}
                      disabled={a.done}
                    >
                      {a.done ? <CheckCheck size={19} /> : <Circle size={19} />}
                    </IconButton>
                    <div>
                      <strong>{a.title}</strong>
                      <p>
                        {a.startsAt ? formatDate(a.startsAt) : '时间待定'}
                        {a.demo ? ' · 来自示例建议' : ''}
                        {a.coverage === 'conditional' ? ' · 条件待核对' : ''}
                      </p>
                    </div>
                    <IconButton label={`移除：${a.title}`} onClick={() => void saveAction(a, 'delete')}>
                      <X size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel-empty agenda-empty">
                <CalendarDays size={29} />
                <h3>还没有安排，也没关系。</h3>
                <p>想到一件想做的事，回来告诉我就好。</p>
              </div>
            )}
            <div className="quiet-note">
              <Bell size={15} />
              <p>
                {state.settings.remindersEnabled
                  ? '提醒已开启；仅在在场运行时提醒。'
                  : '默认安静陪伴。需要时，可在偏好中开启提醒。'}
              </p>
            </div>
            <WorkAndReceipts
              onResume={openConversation}
              onChanged={() => void attempt(async () => updateState(await api.state()))}
            />
          </div>
        </Modal>
      )}
      {panel === 'settings' && state && (
        <SettingsPanel
          state={state}
          busy={busy}
          onClose={() => setPanel(null)}
          onState={updateState}
          draft={settingsDraft}
          notify={notify}
          onClear={() => newChat()}
        />
      )}
      {previewImage && (
        <Modal
          title="图片预览"
          className="image-preview-panel"
          onClose={() => setPreviewImage(undefined)}
        >
          <div className="image-preview-body">
            <img
              className="image-preview-content"
              src={previewImage.dataUrl}
              alt={`图片预览：${previewImage.name}`}
            />
          </div>
        </Modal>
      )}
      {mapSheet && <MapSheet initialRoute={mapSheet} onClose={() => setMapSheet(null)} />}
      {scopeOpen && (
        <ScopeSettings
          value={turnControls}
          onClose={() => setScopeOpen(false)}
          onChange={(value) => {
            turnControlsRef.current = value;
            setTurnControls(value);
            if (value.retention === 'session_only')
              void attempt(() =>
                api.saveDraft({
                  id: draftKey.current,
                  draft: { text: '', attachment: null },
                  retention: 'session_only',
                }),
              );
            else void attempt(() => api.saveDraft({ id: draftKey.current, draft: draftRef.current }));
          }}
        />
      )}
    </div>
  );
}

function MessageView({
  message: m,
  agenda,
  onSave,
  onRevoke,
  onCopy,
  onRetry,
  onViewAgenda,
  onOpenMap,
  onPreviewImage,
  busy,
  boundary,
}: {
  message: Message;
  agenda: Action[];
  onSave: (item: Action) => void;
  onRevoke: (item: Action) => Promise<void>;
  onCopy: () => void;
  onRetry: () => void;
  onViewAgenda: () => void;
  onOpenMap: (route: MapRouteResult) => void;
  onPreviewImage: (image: NonNullable<Message['image']>) => void;
  busy: boolean;
  boundary: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (m.role === 'user')
    return (
      <article className="user-message">
        <div className="user-message-stack">
          {m.image && (
            <button
              type="button"
              className="sent-image-preview"
              aria-label={`预览图片：${m.image.name}`}
              onClick={() => onPreviewImage(m.image!)}
            >
              <img src={m.image.dataUrl} alt={`已上传的图片：${m.image.name}`} />
            </button>
          )}
          <div className="user-message-text">{m.content}</div>
        </div>
      </article>
    );
  const running = m.steps.filter((s) => s.status === 'running'),
    current = running.at(-1),
    hasBlocked =
      m.steps.some((s) => s.status === 'blocked') || m.obligations.some((o) => o.status === 'blocked');
  return (
    <article className="assistant-message">
      <div className="assistant-name">
        <Portal size={23} />
        <span>在场</span>
        {m.demo && <small>示例</small>}
      </div>
      {!!m.steps.length && (
        <div className={`process ${m.status === 'running' ? 'live' : ''}`}>
          <button
            className="process-summary"
            aria-expanded={expanded}
            aria-controls={`process-${m.id}`}
            onClick={() => setExpanded(!expanded)}
          >
            {m.status === 'running' ? (
              <LoaderCircle size={14} className="spin" />
            ) : m.status === 'error' ? (
              <CircleAlert size={14} />
            ) : (
              <Check size={14} />
            )}
            <span>
              {current?.title ||
                (m.status === 'cancelled'
                  ? '已停止处理'
                  : m.status === 'error'
                    ? '有一步需要重新试试'
                    : hasBlocked
                      ? '部分资料或步骤未完成'
                      : '已整理好')}
            </span>
            <ChevronRight size={13} className={expanded ? 'rotated' : ''} />
          </button>
          <div
            id={`process-${m.id}`}
            className={`process-reveal ${expanded ? 'open' : ''}`}
            aria-hidden={!expanded}
          >
            <div className="process-clip">
              <div className="process-detail">
                {m.obligations.length > 0 && (
                  <div className="obligations">
                    <span className="minor-label">本次包含</span>
                    {m.obligations.map((o) => (
                      <div key={o.id} className={o.status}>
                        <span aria-hidden="true">
                          {o.status === 'done' ? '✓' : o.status === 'blocked' ? '–' : '·'}
                        </span>
                        <span className="sr-only">
                          {o.status === 'done'
                            ? '已完成：'
                            : o.status === 'blocked'
                              ? '未完成：'
                              : '处理中：'}
                        </span>
                        {o.title}
                      </div>
                    ))}
                  </div>
                )}
                {m.steps
                  .filter((s) => !m.obligations.some((o) => o.title === s.title))
                  .map((s) => (
                    <div className={`step ${s.status}`} key={s.id}>
                      {s.status === 'running' ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : s.status === 'done' ? (
                        <Check size={13} />
                      ) : (
                        <CircleAlert size={13} />
                      )}
                      <div>
                        <span>
                          {s.scope && <em>{s.scope} / </em>}
                          {s.title}
                        </span>
                        {s.detail && <p>{s.detail}</p>}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {!!m.content && (
        <div className="markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: () => <span className="muted">[图片内容]</span>,
              a: ({ children, href }) => (
                <a
                  className="source-reference"
                  href={href}
                  title={href}
                  onClick={(e) => {
                    e.preventDefault();
                    if (href?.startsWith('https://')) void api.openLink(href).catch(() => {});
                  }}
                >
                  {children}
                </a>
              ),
            }}
          >
            {m.content}
          </ReactMarkdown>
        </div>
      )}
      <ReplyEvidence message={m} />
      {m.mapCards?.map((card, cardIndex) => (
        <MapRouteCard key={cardIndex} card={card} onOpen={() => onOpenMap(card.route)} />
      ))}
      {m.actions.map((a) => (
        <ActionCard
          key={a.id}
          action={agenda.find((v) => v.id === a.id) || a}
          saved={a.saved === true || agenda.some((v) => v.id === a.id)}
          onSave={onSave}
          onRevoke={onRevoke}
          onView={onViewAgenda}
          disabled={busy}
          boundary={boundary}
          onRecheck={onRetry}
        />
      ))}
      {m.status !== 'running' && (
        <div className="message-actions">
          <IconButton label="复制回复" onClick={onCopy}>
            <Copy size={14} />
          </IconButton>
          {m.status === 'done' && !m.demo && m.retention !== 'session_only' && (
            <FeedbackControl messageId={m.id} />
          )}
          {(m.status === 'error' || m.status === 'cancelled') && (
            <button className="text-button" onClick={onRetry} disabled={busy}>
              <RotateCcw size={13} />
              重新试试
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function ActionCard({
  action,
  saved,
  onSave,
  onRevoke,
  onView,
  disabled,
  boundary,
  onRecheck,
}: {
  action: Action;
  saved: boolean;
  onSave: (item: Action) => void;
  onRevoke: (item: Action) => Promise<void>;
  onView: () => void;
  disabled: boolean;
  boundary: string;
  onRecheck: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(action.title),
    [detail, setDetail] = useState(action.detail),
    [time, setTime] = useState(action.startsAt ? localDatetime(action.startsAt) : '');
  const [effect, setEffect] = useState<Awaited<ReturnType<typeof api.actionState>>>(),
    [revoking, setRevoking] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .actionState(action.id)
      .then((v) => {
        if (live) setEffect(v);
      })
      .catch(() => setEffect({ action: null, receipts: [] }));
    return () => {
      live = false;
    };
  }, [action.id, boundary, saved]);
  async function revoke() {
    if (revoking) return;
    setRevoking(true);
    try {
      await onRevoke(action);
      setEffect(await api.actionState(action.id));
    } finally {
      setRevoking(false);
    }
  }
  const latestReceipt = effect?.receipts.at(-1);
  const localSaved =
    effect?.action?.status === 'succeeded' &&
    latestReceipt?.status === 'confirmed_success' &&
    latestReceipt.localStatus === 'local_saved';
  const failure = effect?.action?.status === 'failed_confirmed';
  const unresolved = !!effect?.action &&
    ['outcome_unknown', 'unresolved', 'reconciling', 'cancel_requested', 'cancellation_unknown'].includes(
      effect.action.status,
    );
  const cancelled = !!effect?.action &&
    ['cancelled', 'cancellation_confirmed', 'cannot_cancel'].includes(effect.action.status);
  if (saved && effect === undefined)
    return (
      <div className="saved-action saved-action-pending" aria-live="polite">
        <LoaderCircle size={18} className="spin" />
        <div>
          <strong>{action.title}</strong>
          <small>正在核对本机回执…</small>
        </div>
      </div>
    );
  if (saved && localSaved)
    return (
      <div className="saved-action saved-action-receipt">
        <Check size={19} aria-hidden="true" />
        <div>
          <strong>{action.title}</strong>
          <small>
            {action.done ? '本机已登记 · 已标记完成' : '本机已登记'}
            {action.startsAt ? ` · ${formatDate(action.startsAt)}` : ''}
            {latestReceipt?.observedAt ? ` · 回执 ${formatDate(latestReceipt.observedAt)}` : ''}
            {action.coverage === 'conditional' ? ' · 条件待核对' : ''}
          </small>
        </div>
        <button
          className="text-button"
          onClick={() => void revoke()}
          disabled={disabled || revoking}
          aria-label={`撤销本机登记：${action.title}`}
        >
          {revoking ? '正在撤销…' : '撤销登记'}
        </button>
        <button className="text-button" onClick={onView}>
          查看安排
          <ChevronRight size={14} />
        </button>
      </div>
    );
  if (saved && (failure || unresolved || !effect?.action))
    return (
      <div className="stale-action action-receipt-warning">
        <CircleAlert size={17} aria-hidden="true" />
        <div>
          <strong>{action.title}</strong>
          <p>
            {failure
              ? '本机登记没有完成，未将它当作已保存。'
              : unresolved
                ? '回执尚不确定，请先核查，不要重复登记。'
                : '已显示在安排中，但本机回执暂时无法取得。'}
          </p>
          <button className="text-button" onClick={onView} disabled={disabled}>
            查看回执
          </button>
        </div>
      </div>
    );
  if (cancelled)
    return (
      <div className="stale-action action-receipt-warning">
        <CircleAlert size={17} aria-hidden="true" />
        <div>
          <strong>{action.title}</strong>
          <p>{effect?.action?.status === 'cancellation_confirmed' ? '本机登记已撤销。' : '这项登记已停止，状态需要核对。'}</p>
          <button className="text-button" onClick={onView} disabled={disabled}>
            查看安排
          </button>
        </div>
      </div>
    );
  if (
    effect?.action &&
    [
      'cancelled',
      'cancel_requested',
      'outcome_unknown',
      'unresolved',
      'cannot_cancel',
      'cancellation_unknown',
      'cancellation_confirmed',
    ].includes(effect.action.status)
  )
    return (
      <div className="stale-action">
        <CircleAlert size={17} />
        <div>
          <strong>{action.title}</strong>
          <p>
            {[
              'outcome_unknown',
              'unresolved',
              'cancel_requested',
              'cannot_cancel',
              'cancellation_unknown',
            ].includes(effect.action.status)
              ? '结果待核查，请在安排中查看回执。'
              : '这项建议的依据已经变化，确认前需要重新核对。'}
          </p>
          <button
            className="text-button"
            onClick={
              [
                'outcome_unknown',
                'unresolved',
                'cancel_requested',
                'cannot_cancel',
                'cancellation_unknown',
              ].includes(effect.action.status)
                ? onView
                : onRecheck
            }
            disabled={disabled}
          >
            {[
              'outcome_unknown',
              'unresolved',
              'cancel_requested',
              'cannot_cancel',
              'cancellation_unknown',
            ].includes(effect.action.status)
              ? '查看回执'
              : '重新核对'}
          </button>
        </div>
      </div>
    );
  return (
    <div className="action-card">
      <div className="action-eyebrow">
        <span className="status-dot suggestion" aria-hidden="true" />
        {action.demo ? '建议 · 示例' : '接下来可以'}
      </div>
      {editing ? (
        <div className="action-edit">
          <label>
            想做的事
            <input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            补充
            <textarea value={detail} maxLength={1500} onChange={(e) => setDetail(e.target.value)} />
          </label>
          <label>
            留个时间 <small>可选</small>
            <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
      ) : (
        <>
          <h3>{title}</h3>
          <p>{detail}</p>
          {time && (
            <div className="action-time">
              <CalendarDays size={13} />
              {formatDate(new Date(time).toISOString())}
            </div>
          )}
        </>
      )}
      <div className="action-buttons">
        <button
          className={`primary-button ${saved ? 'saved' : ''}`}
          disabled={disabled || saved || !title.trim()}
          onClick={() => {
            onSave({ ...action, title, detail, startsAt: time ? new Date(time).toISOString() : undefined });
            setEditing(false);
          }}
        >
          {saved ? (
            <>
              <Check size={15} />
              已加入安排
            </>
          ) : (
            <>
              {action.coverage === 'conditional' ? '保存为待核对安排' : '加入我的安排'}
              <ArrowUpRight size={15} />
            </>
          )}
        </button>
        {!saved && (
          <button className="text-button" disabled={disabled} onClick={() => setEditing(!editing)}>
            {editing ? '收起修改' : '调整一下'}
          </button>
        )}
      </div>
      <small className="action-caption">
        保存在本机{action.startsAt || time ? ' · 提醒需在偏好中开启' : ''}
      </small>
      {action.coverage === 'conditional' && (
        <p className="action-conditions">
          尚需核对：{[...new Set((action.missingNeeds || []).map(needName))].join('、') || '相关条件'}
          。保存只记录在本机。
        </p>
      )}
    </div>
  );
}
function localDatetime(value: string) {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function HistoryPanel({
  state,
  busy,
  onClose,
  onOpen,
  onDelete,
}: {
  state: State;
  busy: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [deleting, setDeleting] = useState('');
  const list = state.conversations.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title="历史对话" onClose={onClose}>
      <div className="panel-body">
        <div className="search-box">
          <Search size={16} />
          <input
            aria-label="搜索对话标题"
            placeholder="搜索对话标题"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <kbd>⌘ / Ctrl K</kbd>
        </div>
        {list.length ? (
          <div className="history-list">
            {list.map((c) => (
              <div className="history-item" key={c.id}>
                <button onClick={() => onOpen(c.id)} disabled={busy}>
                  <span>{c.title}</span>
                  <small>{formatDate(c.updatedAt)}</small>
                </button>
                {deleting === c.id ? (
                  <div className="delete-confirm">
                    <button onClick={() => onDelete(c.id)} disabled={busy}>
                      删除
                    </button>
                    <button onClick={() => setDeleting('')}>取消</button>
                  </div>
                ) : (
                  <IconButton
                    label={`删除对话：${c.title}`}
                    onClick={() => setDeleting(c.id)}
                    disabled={busy}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="panel-empty">
            <History size={29} />
            <h3>{query ? '没有找到这段对话。' : '故事，从第一次对话开始。'}</h3>
            <p>{query ? '换一个标题关键词试试。' : '聊过的事会留在本机，需要时再回来。'}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
