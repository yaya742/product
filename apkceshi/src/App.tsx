import { useEffect, useMemo, useRef, useState } from 'react';
import { runMobileAgent, type AgentStatus } from './runtime/agent';
import { completeDeepSeek, DeepSeekError, testDeepSeekConnection } from './runtime/deepseek';
import { getUiCopy } from './runtime/i18n';
import { loadMobileState, saveMobileState } from './runtime/storage';
import {
  createConversation,
  newId,
  type MobileConversation,
  type MobileLanguage,
  type MobileMessage,
  type MobileProfile,
  type MobileState,
  type MobileTheme,
} from './runtime/types';

function friendlyError(error: unknown): string {
  if (error instanceof DeepSeekError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '本轮已停止。';
  if (error instanceof Error) return error.message;
  return '这次处理中断了，请稍后重试。';
}

function formatTime(value: string, language: MobileLanguage): string {
  const locale = language === 'en' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatHistoryDate(value: string, language: MobileLanguage): string {
  const locale = language === 'en' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function compactTitle(value: string, fallback: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').replace(/^\s*["“”'‘’]+|["“”'‘’]+\s*$/g, '').trim();
  return (clean || fallback).slice(0, 28);
}

function statusLabel(status: AgentStatus | '空闲', copy: ReturnType<typeof getUiCopy>): string {
  if (status === '联系 DeepSeek') return copy.contacting;
  if (status === '读取手机时间') return copy.readingTime;
  if (status === '请求手机定位') return copy.locating;
  if (status === '整理回复') return copy.composing;
  return copy.ready;
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.5h14M5 12h14M5 17.5h9" />
      <path d="M3.5 6.5h.01M3.5 12h.01M3.5 17.5h.01" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="m19.4 13.5 1.1.9-1.7 2.9-1.4-.5a7.7 7.7 0 0 1-1.4.8l-.3 1.5h-3.4l-.3-1.5a7.7 7.7 0 0 1-1.4-.8l-1.4.5-1.7-2.9 1.1-.9a7.1 7.1 0 0 1 0-1.6l-1.1-.9 1.7-2.9 1.4.5a7.7 7.7 0 0 1 1.4-.8l.3-1.5h3.4l.3 1.5a7.7 7.7 0 0 1 1.4.8l1.4-.5 1.7 2.9-1.1.9a7.1 7.1 0 0 1 0 1.6Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 5-7 7 7 7M8 12h11" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 19 6v5.1c0 4.2-2.6 7.8-7 9.4-4.4-1.6-7-5.2-7-9.4V6l7-2.5Z" />
      <path d="m8.8 12 2.1 2.1 4.4-4.4" />
    </svg>
  );
}

export function App() {
  const initial = useMemo(() => loadMobileState(), []);
  const [state, setState] = useState<MobileState>(initial);
  const [draft, setDraft] = useState('');
  const [memoryDraft, setMemoryDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus | '空闲'>('空闲');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyMenuId, setHistoryMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [campusOpen, setCampusOpen] = useState(false);
  const [campusSaved, setCampusSaved] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const copy = getUiCopy(state.profile.language);
  const activeConversation = state.conversations.find((item) => item.id === state.activeConversationId) || state.conversations[0];
  const messages = activeConversation?.messages || [];
  const sortedConversations = [...state.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  useEffect(() => {
    saveMobileState(state);
  }, [state]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  function updateState(partial: Partial<MobileState>) {
    setState((current) => ({ ...current, ...partial }));
  }

  function updateProfile(partial: Partial<MobileProfile>) {
    setState((current) => ({ ...current, profile: { ...current.profile, ...partial } }));
  }

  function updateActiveConversation(change: (conversation: MobileConversation) => MobileConversation) {
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((item) => item.id === current.activeConversationId ? change(item) : item),
    }));
  }

  function updateActiveMessages(change: (messages: MobileMessage[]) => MobileMessage[]) {
    updateActiveConversation((conversation) => ({
      ...conversation,
      messages: change(conversation.messages),
      updatedAt: new Date().toISOString(),
    }));
  }

  async function generateConversationTitle(conversationId: string, apiKey: string, userText: string) {
    const fallback = compactTitle(userText, copy.titleFallback);
    let title = fallback;
    try {
      const completion = await completeDeepSeek(
        apiKey,
        [
          { role: 'system', content: '请把用户的话总结成一个简短的中文对话标题。只返回标题，不要引号，不超过 16 个字。' },
          { role: 'user', content: userText },
        ],
        AbortSignal.timeout(15_000),
        [],
      );
      title = compactTitle(completion.message.content || '', fallback);
    } catch {
      title = fallback;
    }
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, title } : item),
    }));
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    if (!state.apiKey.trim()) {
      setHistoryOpen(false);
      setProfileOpen(false);
      setConnectionMessage(copy.needKey);
      setProfileOpen(true);
      return;
    }
    const conversationId = activeConversation.id;
    const history = messages;
    const shouldGenerateTitle = history.length === 0;
    const userMessage: MobileMessage = {
      id: newId('user'),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      status: 'done',
    };
    const assistantId = newId('assistant');
    const assistantMessage: MobileMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      status: 'running',
    };
    setDraft('');
    setBusy(true);
    setStatus('联系 DeepSeek');
    updateActiveMessages((current) => [...current, userMessage, assistantMessage]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runMobileAgent(
        state.apiKey,
        history,
        text,
        state.memories,
        controller.signal,
        (delta) => {
          updateActiveMessages((current) => current.map((message) =>
            message.id === assistantId ? { ...message, content: message.content + delta } : message,
          ));
        },
        setStatus,
      );
      updateActiveMessages((current) => current.map((message) =>
        message.id === assistantId ? { ...message, status: 'done' } : message,
      ));
      if (shouldGenerateTitle) void generateConversationTitle(conversationId, state.apiKey, text);
    } catch (error) {
      const message = friendlyError(error);
      updateActiveMessages((current) => current.map((item) =>
        item.id === assistantId ? { ...item, content: item.content || message, status: 'error' } : item,
      ));
      if (shouldGenerateTitle) {
        const fallbackTitle = compactTitle(text, copy.titleFallback);
        setState((current) => ({
          ...current,
          conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, title: fallbackTitle } : item),
        }));
      }
    } finally {
      abortRef.current = undefined;
      setBusy(false);
      setStatus('空闲');
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function testConnection() {
    if (!state.apiKey.trim()) {
      setConnectionMessage('请先填写 API Key。');
      return;
    }
    setTesting(true);
    setConnectionMessage(`${copy.testing} DeepSeek…`);
    try {
      await testDeepSeekConnection(state.apiKey, AbortSignal.timeout(20_000));
      setConnectionMessage(copy.connectionSuccess);
    } catch (error) {
      setConnectionMessage(friendlyError(error));
    } finally {
      setTesting(false);
    }
  }

  function addMemory() {
    const text = memoryDraft.trim();
    if (!text) return;
    updateState({ memories: [...state.memories, text].slice(-16) });
    setMemoryDraft('');
  }

  function openHistory() {
    setHistoryOpen(true);
    setProfileOpen(false);
    setCampusOpen(false);
  }

  function closeOverlays() {
    setHistoryOpen(false);
    setProfileOpen(false);
    setCampusOpen(false);
    setHistoryMenuId(null);
    setRenamingId(null);
  }

  function createNewConversation() {
    if (busy) return;
    if (!messages.length && activeConversation?.title === copy.newConversation) {
      closeOverlays();
      return;
    }
    const conversation = createConversation(copy.newConversation);
    setState((current) => ({
      ...current,
      conversations: [conversation, ...current.conversations],
      activeConversationId: conversation.id,
    }));
    closeOverlays();
  }

  function selectConversation(id: string) {
    if (busy) return;
    updateState({ activeConversationId: id });
    closeOverlays();
  }

  function startRename(conversation: MobileConversation) {
    setHistoryMenuId(null);
    setRenamingId(conversation.id);
    setRenameDraft(conversation.title);
  }

  function saveRename(id: string) {
    const title = compactTitle(renameDraft, copy.titleFallback);
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((item) => item.id === id ? { ...item, title } : item),
    }));
    setRenamingId(null);
    setRenameDraft('');
  }

  function deleteConversation(id: string) {
    if (busy) return;
    setState((current) => {
      const remaining = current.conversations.filter((item) => item.id !== id);
      if (remaining.length) {
        return {
          ...current,
          conversations: remaining,
          activeConversationId: current.activeConversationId === id ? remaining[0].id : current.activeConversationId,
        };
      }
      const fresh = createConversation(copy.newConversation);
      return { ...current, conversations: [fresh], activeConversationId: fresh.id };
    });
    setHistoryMenuId(null);
  }

  function openProfile() {
    setHistoryOpen(false);
    setProfileOpen(true);
    setCampusOpen(false);
  }

  const themeClass = state.profile.theme === 'dark' ? 'theme-dark' : 'theme-light';

  return (
    <main className={`app-shell ${themeClass}`}>
      <header className="topbar">
        <button className="header-icon-button" aria-label={copy.history} onClick={openHistory}>
          <HistoryIcon />
        </button>
        <div className="topbar-title">{copy.appName}</div>
        <button className="header-icon-button" aria-label={copy.newConversation} onClick={createNewConversation}>
          <PlusIcon />
        </button>
      </header>

      <section className="conversation" ref={scrollRef} aria-live="polite">
        {!messages.length && (
          <div className="welcome-card">
            <div className="welcome-kicker"><span />{copy.onlineKicker}</div>
            <div className="welcome-orb">在</div>
            <h1>{copy.welcomeTitle}</h1>
            <p>{copy.welcomeBody}</p>
            <div className="suggestion-list">
              {copy.suggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => setDraft(suggestion)}>
                  <span>{suggestion}</span>
                  <ArrowIcon />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <article className={`message ${message.role} ${message.status}`} key={message.id}>
            <div className="message-author">
              {message.role === 'assistant' && <span className="message-avatar">在</span>}
              <span>{message.role === 'user' ? copy.user : copy.assistant}</span>
              <time>{formatTime(message.createdAt, state.profile.language)}</time>
            </div>
            <div className="message-bubble">
              {message.content || (message.status === 'running' ? <span className="typing">{copy.typing}</span> : '')}
            </div>
          </article>
        ))}
      </section>

      <footer className="composer-area">
        <div className="status-line">
          <span className={`status-dot ${busy ? 'busy' : ''}`} />
          <span>{busy ? statusLabel(status, copy) : state.apiKey ? copy.ready : copy.needKey}</span>
          {!!messages.length && <button className="clear-button" disabled={busy} onClick={createNewConversation}>{copy.newConversation}</button>}
        </div>
        <div className="composer">
          <textarea
            value={draft}
            disabled={busy}
            placeholder={copy.draftPlaceholder}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button className="stop-button" onClick={stop}>{copy.stop}</button>
          ) : (
            <button className="send-button" disabled={!draft.trim()} onClick={() => void send()} aria-label="发送">
              <ArrowIcon />
            </button>
          )}
        </div>
        <p className="privacy-note">{copy.privacy}</p>
      </footer>

      {historyOpen && (
        <>
          <button className="drawer-backdrop" aria-label={copy.close} onClick={closeOverlays} />
          <aside className="history-drawer" aria-label={copy.historyTitle}>
            <div className="drawer-topbar">
              <div>
                <p className="eyebrow">{copy.history}</p>
                <h2>{copy.historyTitle}</h2>
              </div>
              <button className="icon-button" aria-label={copy.close} onClick={closeOverlays}><CloseIcon /></button>
            </div>
            <div className="history-list">
              {sortedConversations.length ? sortedConversations.map((conversation) => (
                <div className={`history-item ${conversation.id === activeConversation?.id ? 'active' : ''}`} key={conversation.id}>
                  {renamingId === conversation.id ? (
                    <div className="rename-row">
                      <input value={renameDraft} autoFocus placeholder={copy.renamePlaceholder} onChange={(event) => setRenameDraft(event.target.value)} />
                      <button onClick={() => saveRename(conversation.id)}>{copy.done}</button>
                      <button onClick={() => setRenamingId(null)}>{copy.cancel}</button>
                    </div>
                  ) : (
                    <button className="history-item-main" onClick={() => selectConversation(conversation.id)}>
                      <span className="history-item-title">{conversation.title}</span>
                      <span className="history-item-meta">{conversation.messages.length ? `${conversation.messages.length} · ` : ''}{formatHistoryDate(conversation.updatedAt, state.profile.language)}</span>
                    </button>
                  )}
                  {renamingId !== conversation.id && (
                    <button className="more-button" aria-label="更多操作" onClick={(event) => { event.stopPropagation(); setHistoryMenuId(historyMenuId === conversation.id ? null : conversation.id); }}>
                      <MoreIcon />
                    </button>
                  )}
                  {historyMenuId === conversation.id && (
                    <div className="history-menu">
                      <button onClick={() => startRename(conversation)}>{copy.rename}</button>
                      <button className="danger-button" onClick={() => deleteConversation(conversation.id)}>{copy.delete}</button>
                    </div>
                  )}
                </div>
              )) : <p className="empty-history">{copy.historyEmpty}</p>}
            </div>
            <button className="profile-entry" onClick={openProfile}>
              <span className="profile-avatar">{state.profile.avatar || '在'}</span>
              <span className="profile-entry-copy"><strong>{copy.profileEyebrow}</strong><small>{copy.profileTitle}</small></span>
              <SettingsIcon />
            </button>
          </aside>
        </>
      )}

      {profileOpen && !campusOpen && (
        <section className="full-screen-panel" aria-label={copy.profileTitle}>
          <header className="secondary-topbar">
            <button className="back-button" onClick={() => { setProfileOpen(false); setHistoryOpen(true); }}><BackIcon /><span>{copy.back}</span></button>
            <h2>{copy.profileTitle}</h2>
            <span className="topbar-spacer" />
          </header>
          <div className="settings-scroll">
            <section className="profile-hero">
              <span className="profile-avatar profile-avatar-large">{state.profile.avatar || '在'}</span>
              <div><p className="eyebrow">{copy.profileEyebrow}</p><h1>{copy.profileTitle}</h1><p>{copy.avatarHint}</p></div>
            </section>
            <section className="profile-section">
              <div className="setting-label"><strong>{copy.avatar}</strong><span>{copy.avatarHint}</span></div>
              <div className="avatar-options">
                {['在', '🌿', '☀️', '🌙', '🪴', '✨'].map((avatar) => (
                  <button className={state.profile.avatar === avatar ? 'selected' : ''} key={avatar} onClick={() => updateProfile({ avatar })}>{avatar}</button>
                ))}
              </div>
              <input className="avatar-input" value={state.profile.avatar} maxLength={4} placeholder="在" onChange={(event) => updateProfile({ avatar: event.target.value })} />
            </section>
            <section className="profile-section setting-row">
              <div className="setting-label"><strong>{copy.language}</strong><span>中文、繁體中文、English</span></div>
              <select value={state.profile.language} onChange={(event) => updateProfile({ language: event.target.value as MobileLanguage })}>
                <option value="zh-CN">中文（简体）</option>
                <option value="zh-TW">中文（繁體）</option>
                <option value="en">English</option>
              </select>
            </section>
            <section className="profile-section setting-row">
              <div className="setting-label"><strong>{copy.appearance}</strong><span>{state.profile.theme === 'light' ? copy.light : copy.dark}</span></div>
              <div className="segmented-control">
                <button className={state.profile.theme === 'light' ? 'selected' : ''} onClick={() => updateProfile({ theme: 'light' as MobileTheme })}>{copy.light}</button>
                <button className={state.profile.theme === 'dark' ? 'selected' : ''} onClick={() => updateProfile({ theme: 'dark' as MobileTheme })}>{copy.dark}</button>
              </div>
            </section>
            <button className="profile-link" onClick={() => { setCampusOpen(true); setCampusSaved(false); }}>
              <span><strong>{copy.campus}</strong><small>{copy.campusHint}</small></span><ArrowIcon />
            </button>
            <section className="profile-section api-key-section">
              <div className="setting-label"><strong>{copy.apiKey}</strong><span>{copy.secureNote}</span></div>
              <div className="key-row">
                <input
                  id="profile-api-key"
                  type="password"
                  value={state.apiKey}
                  placeholder="sk-…"
                  autoComplete="off"
                  onChange={(event) => updateState({ apiKey: event.target.value })}
                />
                <button className="primary-button" disabled={testing} onClick={() => void testConnection()}>
                  {testing ? copy.testing : copy.testConnection}
                </button>
              </div>
              {connectionMessage && <p className="connection-message">{connectionMessage}</p>}
            </section>
          </div>
        </section>
      )}

      {profileOpen && campusOpen && (
        <section className="full-screen-panel" aria-label={copy.campusTitle}>
          <header className="secondary-topbar">
            <button className="back-button" onClick={() => setCampusOpen(false)}><BackIcon /><span>{copy.back}</span></button>
            <h2>{copy.campusTitle}</h2>
            <span className="topbar-spacer" />
          </header>
          <div className="settings-scroll campus-screen">
            <div className="campus-intro"><p className="eyebrow">{copy.campus}</p><h1>{copy.campusTitle}</h1><p>{copy.campusHint}</p></div>
            <label className="field-label" htmlFor="student-id">{copy.studentId}</label>
            <input id="student-id" value={state.profile.studentId} placeholder={copy.studentId} onChange={(event) => updateProfile({ studentId: event.target.value })} />
            <label className="field-label" htmlFor="student-password">{copy.studentPassword}</label>
            <input id="student-password" type="password" value={state.profile.studentPassword} placeholder={copy.passwordPlaceholder} onChange={(event) => updateProfile({ studentPassword: event.target.value })} />
            <button className="save-wide-button" onClick={() => setCampusSaved(true)}>{campusSaved ? copy.saved : copy.save}</button>
          </div>
        </section>
      )}
    </main>
  );
}
