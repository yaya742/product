import { useEffect, useMemo, useRef, useState } from 'react';
import { runMobileAgent, type AgentStatus } from './runtime/agent';
import { DeepSeekError, testDeepSeekConnection } from './runtime/deepseek';
import { loadMobileState, saveMobileState } from './runtime/storage';
import { newId, type MobileMessage, type MobileState } from './runtime/types';

function friendlyError(error: unknown): string {
  if (error instanceof DeepSeekError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '本轮已停止。';
  if (error instanceof Error) return error.message;
  return '这次处理中断了，请稍后重试。';
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
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
  const [settingsOpen, setSettingsOpen] = useState(!initial.apiKey);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus | '空闲'>('空闲');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;

  useEffect(() => {
    saveMobileState(state);
  }, [state]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [state.messages, busy]);

  function updateState(partial: Partial<MobileState>) {
    setState((current) => ({ ...current, ...partial }));
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    if (!state.apiKey.trim()) {
      setSettingsOpen(true);
      setConnectionMessage('先填写 DeepSeek API Key，再开始对话。');
      return;
    }
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
    const history = state.messages;
    setDraft('');
    setBusy(true);
    setStatus('联系 DeepSeek');
    setState((current) => ({ messages: [...current.messages, userMessage, assistantMessage], apiKey: current.apiKey, memories: current.memories }));
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
          setState((current) => ({
            ...current,
            messages: current.messages.map((message) =>
              message.id === assistantId ? { ...message, content: message.content + delta } : message,
            ),
          }));
        },
        setStatus,
      );
      setState((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === assistantId ? { ...message, status: 'done' } : message,
        ),
      }));
    } catch (error) {
      const message = friendlyError(error);
      setState((current) => ({
        ...current,
        messages: current.messages.map((item) =>
          item.id === assistantId ? { ...item, content: item.content || message, status: 'error' } : item,
        ),
      }));
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
    setConnectionMessage('正在测试 DeepSeek 连接…');
    try {
      await testDeepSeekConnection(state.apiKey, AbortSignal.timeout(20_000));
      setConnectionMessage('连接成功。Key 只保存在这台设备上。');
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

  function clearConversation() {
    if (busy) return;
    updateState({ messages: [] });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">在</div>
        <div className="brand-copy">
          <strong>在场</strong>
          <span className="connection-state">
            <i className={`connection-dot ${online && state.apiKey ? 'active' : ''}`} />
            {online ? (state.apiKey ? '已连接' : '等待连接') : '无网络'}
          </span>
        </div>
        <button className="icon-button" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon />
        </button>
      </header>

      <section className="conversation" ref={scrollRef} aria-live="polite">
        {!state.messages.length && (
          <div className="welcome-card">
            <div className="welcome-kicker"><span />在场 · 随时在线</div>
            <div className="welcome-orb">在</div>
            <h1>把此刻，放在这里。</h1>
            <p>说说你正在经历的事。我会先听懂，再陪你找到下一步。</p>
            <div className="suggestion-list">
              {['帮我理一下今天要做的事', '我现在在哪里？', '给我一个简单的学习安排'].map((suggestion) => (
                <button key={suggestion} onClick={() => setDraft(suggestion)}>
                  <span>{suggestion}</span>
                  <ArrowIcon />
                </button>
              ))}
            </div>
          </div>
        )}
        {state.messages.map((message) => (
          <article className={`message ${message.role} ${message.status}`} key={message.id}>
            <div className="message-author">
              {message.role === 'assistant' && <span className="message-avatar">在</span>}
              <span>{message.role === 'user' ? '你' : '在场'}</span>
              <time>{formatTime(message.createdAt)}</time>
            </div>
            <div className="message-bubble">
              {message.content || (message.status === 'running' ? <span className="typing">正在整理…</span> : '')}
            </div>
          </article>
        ))}
      </section>

      <footer className="composer-area">
        <div className="status-line">
          <span className={`status-dot ${busy ? 'busy' : ''}`} />
          <span>{busy ? status : state.apiKey ? '本机已准备好' : '先在设置里连接 DeepSeek'}</span>
          {!!state.messages.length && <button className="clear-button" disabled={busy} onClick={clearConversation}>新对话</button>}
        </div>
        <div className="composer">
          <textarea
            value={draft}
            disabled={busy}
            placeholder="说说眼前的事…"
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
            <button className="stop-button" onClick={stop}>停止</button>
          ) : (
            <button className="send-button" disabled={!draft.trim()} onClick={() => void send()} aria-label="发送">
              <ArrowIcon />
            </button>
          )}
        </div>
        <p className="privacy-note">直连 DeepSeek · 对话、记忆和 Key 保存在本机</p>
      </footer>

      {settingsOpen && (
        <>
          <button className="drawer-backdrop" aria-label="关闭设置" onClick={() => setSettingsOpen(false)} />
          <section className="settings-drawer" aria-label="连接设置" role="dialog" aria-modal="true">
            <div className="drawer-handle" />
            <div className="drawer-heading">
              <div>
                <p className="eyebrow">设置</p>
                <h2>让在场更懂你</h2>
              </div>
              <button className="icon-button small" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>
                <CloseIcon />
              </button>
            </div>

            <div className="secure-note">
              <ShieldIcon />
              <span>你的 Key 只保存在这台设备，消息直接发送到 DeepSeek。</span>
            </div>
            <label className="field-label" htmlFor="api-key">DeepSeek API Key</label>
            <div className="key-row">
              <input
                id="api-key"
                type="password"
                value={state.apiKey}
                placeholder="sk-…"
                autoComplete="off"
                onChange={(event) => updateState({ apiKey: event.target.value })}
              />
              <button className="primary-button" disabled={testing} onClick={() => void testConnection()}>
                {testing ? '测试中' : '测试连接'}
              </button>
            </div>
            {connectionMessage && <p className="connection-message">{connectionMessage}</p>}

            <div className="drawer-section">
              <div className="section-title-row">
                <div>
                  <p className="eyebrow">长期记忆</p>
                  <h3>告诉我一些关于你的事</h3>
                </div>
                <span className="memory-count">{state.memories.length}/16</span>
              </div>
              <div className="memory-row">
                <input
                  id="memory"
                  value={memoryDraft}
                  placeholder="例如：我喜欢简洁的安排"
                  onChange={(event) => setMemoryDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addMemory();
                    }
                  }}
                />
                <button className="secondary-button" onClick={addMemory}>保存</button>
              </div>
              {!!state.memories.length && (
                <div className="memory-list">
                  {state.memories.map((memory, index) => (
                    <button
                      className="memory-chip"
                      key={`${memory}-${index}`}
                      title="删除这条记忆"
                      onClick={() => updateState({ memories: state.memories.filter((_, itemIndex) => itemIndex !== index) })}
                    >
                      {memory} <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
