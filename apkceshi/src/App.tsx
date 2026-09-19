import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MapPanel } from './MapPanel';
import { WeatherPanel } from './WeatherPanel';
import { runMobileAgent, type AgentStatus } from './runtime/agent';
import { completeDeepSeek, DeepSeekError, testDeepSeekConnection, translateText } from './runtime/deepseek';
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

function Avatar({ value, className }: { value: string; className: string }) {
  const image = /^data:image\//i.test(value);
  return <span className={className}>{image ? <img className="avatar-image" src={value} alt="" /> : (value || '在')}</span>;
}

function inlineMarkdown(value: string): ReactNode {
  const safe = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((piece, index) => {
    if (piece.startsWith('**') && piece.endsWith('**')) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith('`') && piece.endsWith('`')) return <code key={index}>{piece.slice(1, -1)}</code>;
    return <span key={index}>{piece}</span>;
  });
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function MessageContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim().startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = tableCells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="message-table-wrap" key={`table-${index}`}>
          <table className="message-table">
            <thead><tr>{headers.map((header, cellIndex) => <th key={cellIndex}>{inlineMarkdown(header)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineMarkdown(row[cellIndex] || '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const line = lines[index];
    if (!line.trim()) {
      blocks.push(<div className="message-line-break" key={`blank-${index}`} />);
    } else if (/^#{1,3}\s/.test(line)) {
      blocks.push(<h4 key={index}>{inlineMarkdown(line.replace(/^#{1,3}\s/, ''))}</h4>);
    } else if (/^[-*]\s+/.test(line)) {
      blocks.push(<div className="message-list-item" key={index}>• {inlineMarkdown(line.replace(/^[-*]\s+/, ''))}</div>);
    } else {
      blocks.push(<p key={index}>{inlineMarkdown(line)}</p>);
    }
    index += 1;
  }
  return <div className="message-content">{blocks}</div>;
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

function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3.5 6.2 5.7-2.4 5.6 2.4 5.7-2.4v14.2L14.8 20l-5.6-2.2-5.7 2.2V6.2Z" />
      <path d="M9.2 3.8v14M14.8 6.2v13.8" />
    </svg>
  );
}

function WeatherIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 18.2h10.2a3.3 3.3 0 0 0 .2-6.6 5.7 5.7 0 0 0-10.8-1.1A3.9 3.9 0 0 0 7 18.2Z" />
      <path d="M8 21v-1.4M12 21v-1.4M16 21v-1.4" />
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

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 14 6-6 6 6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 10 6 6 6-6" />
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
  const [, setStatus] = useState<AgentStatus | '空闲'>('空闲');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [translationMessage, setTranslationMessage] = useState('');
  const [translating, setTranslating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyMenuId, setHistoryMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [campusOpen, setCampusOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState('');
  const [campusSaved, setCampusSaved] = useState(false);
  const [scrollState, setScrollState] = useState({ canUp: false, canDown: false });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const translationAbortRef = useRef<AbortController | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const copy = getUiCopy(state.profile.language);
  const activeConversation = state.conversations.find((item) => item.id === state.activeConversationId) || state.conversations[0];
  const messages = activeConversation?.messages || [];
  // Empty drafts are not history items, so repeated new-chat taps stay out of history.
  const sortedConversations = state.conversations
    .filter((conversation) => conversation.messages.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  useEffect(() => {
    saveMobileState(state);
  }, [state]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const updateScrollState = () => {
      setScrollState({
        canUp: node.scrollTop > 16,
        canDown: node.scrollTop + node.clientHeight < node.scrollHeight - 16,
      });
    };
    updateScrollState();
    node.addEventListener('scroll', updateScrollState, { passive: true });
    return () => node.removeEventListener('scroll', updateScrollState);
  }, [messages]);

  function updateState(partial: Partial<MobileState>) {
    setState((current) => ({ ...current, ...partial }));
  }

  function updateProfile(partial: Partial<MobileProfile>) {
    setState((current) => ({ ...current, profile: { ...current.profile, ...partial } }));
  }

  async function handleAvatarFile(file: File) {
    const failedMessage = state.profile.language === 'en' ? 'Please choose a valid image.' : state.profile.language === 'zh-TW' ? '請選擇有效的圖片。' : '请选择有效的图片。';
    if (!file.type.startsWith('image/')) {
      setAvatarMessage(failedMessage);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(failedMessage));
        element.src = objectUrl;
      });
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      if (!size) throw new Error(failedMessage);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(failedMessage);
      context.fillStyle = '#eef4ed';
      context.fillRect(0, 0, 256, 256);
      context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 256, 256);
      updateProfile({ avatar: canvas.toDataURL('image/jpeg', 0.86) });
      setAvatarMessage('');
    } catch (error) {
      setAvatarMessage(error instanceof Error ? error.message : failedMessage);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function changeLanguage(language: MobileLanguage) {
    const previousLanguage = state.profile.language;
    if (language === previousLanguage || translating || busy) return;
    const targetCopy = getUiCopy(language);
    const conversationId = activeConversation?.id;
    const currentMessages = messages;
    updateProfile({ language });
    setTranslationMessage('');
    if (!conversationId || !currentMessages.length) return;
    if (!state.apiKey.trim()) {
      setTranslationMessage(targetCopy.translationNeedKey);
      return;
    }

    translationAbortRef.current?.abort();
    const controller = new AbortController();
    translationAbortRef.current = controller;
    setTranslating(true);
    setTranslationMessage(targetCopy.translatingConversation);
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => conversation.id !== conversationId ? conversation : {
        ...conversation,
        messages: conversation.messages.map((message) => ({
          ...message,
          translations: { ...message.translations, [previousLanguage]: message.translations?.[previousLanguage] ?? message.content },
        })),
      }),
    }));

    let failed = false;
    try {
      for (const message of currentMessages) {
        controller.signal.throwIfAborted();
        const cached = message.translations?.[language];
        const translated = cached || await translateText(state.apiKey, message.content, language, controller.signal);
        setState((current) => ({
          ...current,
          conversations: current.conversations.map((conversation) => conversation.id !== conversationId ? conversation : {
            ...conversation,
            messages: conversation.messages.map((item) => item.id !== message.id ? item : {
              ...item,
              content: translated,
              translations: {
                ...item.translations,
                [previousLanguage]: item.translations?.[previousLanguage] ?? item.content,
                [language]: translated,
              },
            }),
          }),
        }));
      }
    } catch (error) {
      if (!controller.signal.aborted) failed = true;
    } finally {
      if (!controller.signal.aborted) setTranslationMessage(failed ? targetCopy.translationFailed : targetCopy.translatedConversation);
      if (translationAbortRef.current === controller) translationAbortRef.current = undefined;
      setTranslating(false);
    }
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
    const conversationLanguage = state.profile.language;
    const shouldGenerateTitle = history.length === 0;
    const userMessage: MobileMessage = {
      id: newId('user'),
      role: 'user',
      content: text,
      translations: { [conversationLanguage]: text },
      createdAt: new Date().toISOString(),
      status: 'done',
    };
    const assistantId = newId('assistant');
    const assistantMessage: MobileMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      translations: {},
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
        conversationLanguage,
        controller.signal,
        (delta) => {
          updateActiveMessages((current) => current.map((message) =>
            message.id === assistantId ? { ...message, content: message.content + delta } : message,
          ));
        },
        setStatus,
      );
      updateActiveMessages((current) => current.map((message) =>
        message.id === assistantId ? {
          ...message,
          status: 'done',
          translations: { ...message.translations, [conversationLanguage]: message.content },
        } : message,
      ));
      if (shouldGenerateTitle) void generateConversationTitle(conversationId, state.apiKey, text);
    } catch (error) {
      const message = friendlyError(error);
      updateActiveMessages((current) => current.map((item) =>
        item.id === assistantId ? {
          ...item,
          content: item.content || message,
          status: 'error',
          translations: { ...item.translations, [conversationLanguage]: item.content || message },
        } : item,
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

  function jumpConversation(edge: 'top' | 'bottom') {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: edge === 'top' ? 0 : node.scrollHeight, behavior: 'smooth' });
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

  function openMap() {
    closeOverlays();
    setMapOpen(true);
    setWeatherOpen(false);
  }

  function openWeather() {
    closeOverlays();
    setWeatherOpen(true);
    setMapOpen(false);
  }

  const themeClass = state.profile.theme === 'dark' ? 'theme-dark' : 'theme-light';

  return (
    <main className={`app-shell ${themeClass}`}>
      <header className="topbar">
        <button className="header-icon-button" aria-label={copy.history} onClick={openHistory}>
          <HistoryIcon />
        </button>
        <div className="topbar-title">{copy.appName}</div>
        <div className="topbar-actions">
          <button className="header-icon-button" aria-label={state.profile.language === 'en' ? 'Map' : '地图'} onClick={openMap}><MapIcon /></button>
          <button className="header-icon-button" aria-label={state.profile.language === 'en' ? 'Weather' : '天气'} onClick={openWeather}><WeatherIcon /></button>
          <button className="header-icon-button" aria-label={copy.newConversation} onClick={createNewConversation}><PlusIcon /></button>
        </div>
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
              {message.content ? <MessageContent content={message.content} /> : (message.status === 'running' ? <span className="typing">{copy.typing}</span> : '')}
            </div>
          </article>
        ))}
      </section>

      {messages.length > 0 && (scrollState.canUp || scrollState.canDown) && (
        <div className="scroll-jump" aria-label="对话位置">
          <button disabled={!scrollState.canUp} aria-label="回到顶部" onClick={() => jumpConversation('top')}><ChevronUpIcon /></button>
          <button disabled={!scrollState.canDown} aria-label="回到底部" onClick={() => jumpConversation('bottom')}><ChevronDownIcon /></button>
        </div>
      )}

      <footer className="composer-area">
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
              <Avatar className="profile-avatar" value={state.profile.avatar} />
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
              <Avatar className="profile-avatar profile-avatar-large" value={state.profile.avatar} />
              <div><p className="eyebrow">{copy.profileEyebrow}</p><h1>{copy.profileTitle}</h1></div>
            </section>
            <section className="profile-section">
              <div className="setting-label"><strong>{copy.avatar}</strong><span>{copy.avatarHint}</span></div>
              <label className="avatar-upload-button" htmlFor="avatar-file">
                <span>{copy.avatarHint}</span><ArrowIcon />
              </label>
              <input id="avatar-file" className="avatar-file-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleAvatarFile(file); event.currentTarget.value = ''; }} />
              {avatarMessage && <p className="connection-message">{avatarMessage}</p>}
            </section>
            <section className="profile-section setting-row">
              <div className="setting-label"><strong>{copy.language}</strong><span>中文、繁體中文、English</span></div>
              <select
                value={state.profile.language}
                disabled={busy || translating}
                onChange={(event) => void changeLanguage(event.target.value as MobileLanguage)}
              >
                <option value="zh-CN">中文（简体）</option>
                <option value="zh-TW">中文（繁體）</option>
                <option value="en">English</option>
              </select>
              {translationMessage && <p className="connection-message">{translationMessage}</p>}
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

      {mapOpen && <MapPanel language={state.profile.language} onClose={() => setMapOpen(false)} />}
      {weatherOpen && <WeatherPanel language={state.profile.language} onClose={() => setWeatherOpen(false)} />}
    </main>
  );
}
