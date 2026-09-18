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
          <span>{online ? (state.apiKey ? '本机直连 DeepSeek' : '等待连接') : '当前没有网络'}</span>
        </div>
        <button className="icon-button" aria-label="打开设置" onClick={() => setSettingsOpen((open) => !open)}>
          {settingsOpen ? '×' : '⚙'}
        </button>
      </header>

      {settingsOpen && (
        <section className="settings-card" aria-label="连接设置">
          <div className="section-heading">
            <div>
              <p className="eyebrow">本机连接</p>
              <h1>把 Key 留在你的手机里</h1>
            </div>
            <button className="quiet-button" onClick={() => setSettingsOpen(false)}>收起</button>
          </div>
          <p className="settings-copy">
            这个移动端不经过在场服务器，消息直接发送到 DeepSeek。API Key 会保存在本机浏览器存储中；正式 APK 会替换为系统安全存储。
          </p>
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
          <div className="settings-divider" />
          <label className="field-label" htmlFor="memory">想让我长期记住什么？</label>
          <div className="memory-row">
            <input
              id="memory"
              value={memoryDraft}
              placeholder="例如：我更喜欢安静的学习环境"
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
        </section>
      )}

      <section className="conversation" ref={scrollRef} aria-live="polite">
        {!state.messages.length && (
          <div className="welcome-card">
            <div className="welcome-orb">在</div>
            <h2>照顾好眼前的生活</h2>
            <p>你可以直接说一件正在处理的事。我会先理解，再告诉你下一步。</p>
            <div className="suggestion-row">
              {['帮我理一下今天要做的事', '我现在在哪里？', '给我一个简单的学习安排'].map((suggestion) => (
                <button key={suggestion} onClick={() => setDraft(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </div>
        )}
        {state.messages.map((message) => (
          <article className={`message ${message.role} ${message.status}`} key={message.id}>
            <div className="message-label">{message.role === 'user' ? '你' : '在场'} · {formatTime(message.createdAt)}</div>
            <div className="message-bubble">
              {message.content || (message.status === 'running' ? <span className="typing">正在整理…</span> : '')}
            </div>
          </article>
        ))}
      </section>

      <footer className="composer-area">
        <div className="status-line">
          <span className={`status-dot ${busy ? 'busy' : ''}`} />
          <span>{busy ? status : state.apiKey ? '本机已准备好' : '填写 Key 后开始'}</span>
          {!!state.messages.length && <button className="clear-button" disabled={busy} onClick={clearConversation}>清空对话</button>}
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
            <button className="send-button" disabled={!draft.trim()} onClick={() => void send()} aria-label="发送">↑</button>
          )}
        </div>
        <p className="privacy-note">直连 DeepSeek · 对话、记忆和 Key 保存在本机</p>
      </footer>
    </main>
  );
}
