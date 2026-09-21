import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Check, Download, LoaderCircle, Pencil, Trash2, X } from 'lucide-react';
import { IconButton, Modal, Switch } from './ui';
import { MemoryPanelSimple } from './HarnessViews';
import type { Settings, State } from '../shared/types';
import type { InstalledPlugin } from '../shared/plugins';

const api = window.zaichang;
export interface SettingsDraft {
  apiKey?: string;
  guidance?: string;
}
interface Props {
  state: State;
  busy: boolean;
  onState: (s: State) => void;
  onClose: () => void;
  notify: (s: string) => void;
  onClear: () => void;
  draft: MutableRefObject<SettingsDraft>;
}
type Feedback = { action: string; text: string; error?: boolean } | null;
const tabs = ['连接', '接口', '记忆', '偏好'];
const errorText = (e: unknown) =>
  String(e instanceof Error ? e.message : e)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^Error: /, '');

export function SettingsPanel({ state, busy, onState, onClose, notify, onClear, draft }: Props) {
  const [tab, setTab] = useState('连接');
  const [key, setKey] = useState(draft.current.apiKey || '');
  const [guidance, setGuidance] = useState(draft.current.guidance ?? state.settings.guidance);
  const [pending, setPending] = useState('');
  const [interfacePending, setInterfacePending] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [memoryText, setMemoryText] = useState(''),
    [editId, setEditId] = useState<string>();
  const [sourceId, setSourceId] = useState(''),
    [clearConfirm, setClearConfirm] = useState(false),
    [pluginConfirm, setPluginConfirm] = useState<InstalledPlugin | null>(null);
  const testCancelled = useRef(false),
    pendingRef = useRef('');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const disabled = busy || !!pending;
  useEffect(
    () => () => {
      if (pendingRef.current === 'test') void api.cancelConnection();
    },
    [],
  );
  function changeTab(value: string) {
    if (pendingRef.current === 'test') {
      testCancelled.current = true;
      void api.cancelConnection();
    }
    setTab(value);
    setFeedback(null);
    bodyRef.current?.scrollTo({ top: 0 });
  }
  async function perform(action: string, fn: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = action;
    setPending(action);
    setFeedback(null);
    try {
      await fn();
    } catch (e) {
      setFeedback({
        action,
        text:
          action === 'test' && testCancelled.current ? '已取消测试' : errorText(e).replace(/[。.!！]+$/, ''),
        error: !(action === 'test' && testCancelled.current),
      });
    } finally {
      pendingRef.current = '';
      setPending('');
    }
  }
  function result(actions: string[]) {
    return feedback && actions.includes(feedback.action) ? (
      <div
        className={`inline-status ${feedback.error ? 'error' : ''}`}
        role={feedback.error ? 'alert' : 'status'}
      >
        {feedback.text}
      </div>
    ) : null;
  }
  async function update(action: string, settings: Partial<Settings>) {
    await perform(action, async () => {
      onState(await api.saveSettings(settings));
    });
  }
  async function toggleInterface(id: string, enabled: boolean) {
    if (interfacePending) return;
    setInterfacePending(id);
    setFeedback(null);
    try {
      onState(await api.setInterfaceEnabled({ id, enabled }));
      setFeedback({ action: 'interface', text: enabled ? '接口已启用' : '接口已停用' });
    } catch (e) {
      setFeedback({ action: 'interface', text: errorText(e).replace(/[。.!！]+$/, ''), error: true });
    } finally {
      setInterfacePending('');
    }
  }
  const pluginLifecycle = (plugin: InstalledPlugin) => {
    if (plugin.lifecycle === 'pending_install') return '安装待生效';
    if (plugin.lifecycle === 'pending_upgrade') return `升级待生效${plugin.pendingVersion ? ` · v${plugin.pendingVersion}` : ''}`;
    if (plugin.lifecycle === 'pending_uninstall') return '卸载待生效';
    if (plugin.lifecycle === 'invalid') return '加载失败';
    return plugin.enabled ? '已启用' : '已停用';
  };
  return (
    <Modal title={tab === '接口' ? '接口管理' : '连接与偏好'} onClose={onClose} className="settings-panel">
      <div className="panel-tabs" role="tablist" aria-label="在场设置">
          {tabs.map((t, i) => (
            <button
              key={t}
              id={`settings-tab-${i}`}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`settings-panel-${i}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => changeTab(t)}
              onKeyDown={(e) => {
                let next: number | undefined;
                if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
                if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
                if (e.key === 'Home') next = 0;
                if (e.key === 'End') next = tabs.length - 1;
                if (next !== undefined) {
                  e.preventDefault();
                  changeTab(tabs[next]);
                  tabRefs.current[next]?.focus();
                }
              }}
            >
              {t}
            </button>
          ))}
        </div>
      <div
        className="panel-body"
        ref={bodyRef}
        role="tabpanel"
        id={`settings-panel-${tabs.indexOf(tab)}`}
        aria-labelledby={`settings-tab-${tabs.indexOf(tab)}`}
      >
        {busy && <p className="busy-note">连接设置需等本轮结束；停用记忆权限会立即生效。</p>}
        {tab === '连接' && (
          <>
            <div className="section-heading">
              <div>
                <h3>DeepSeek</h3>
                <p>
                  {state.settings.keyStatus === 'invalid'
                    ? '已保存密钥无法读取，请重新输入'
                    : state.settings.mode === 'deepseek' && state.settings.hasKey
                      ? '已连接'
                      : '连接后即可开始对话'}
                </p>
              </div>
            </div>
            <label className="field-label">
              DeepSeek 密钥
              <input
                type="password"
                value={key}
                autoComplete="off"
                placeholder={state.settings.keyStatus === 'invalid' ? '重新输入密钥' : state.settings.hasKey ? '已保存' : '输入密钥'}
                onChange={(e) => {
                  setKey(e.target.value);
                  draft.current.apiKey = e.target.value;
                }}
                disabled={disabled}
              />
            </label>
            <div className="field-buttons">
              <button
                className="primary-button"
                disabled={disabled || !(key || state.settings.hasKey)}
                onClick={() =>
                  void perform('save', async () => {
                    onState(
                      await api.saveSettings({ mode: 'deepseek', ...(key ? { apiKey: key } : {}) }),
                    );
                    setKey('');
                    draft.current.apiKey = '';
                    setFeedback({ action: 'save', text: '已连接' });
                  })
                }
              >
                {pending === 'save' && <LoaderCircle size={14} className="spin" />}连接 DeepSeek
              </button>
            </div>
            {result(['save', 'demo', 'remove'])}
            <details className="advanced connection-advanced">
              <summary>更多连接设置</summary>
              <div className="advanced-body">
                <div className="field-buttons">
                  <button
                    className="subtle-button"
                    disabled={disabled || !(key || state.settings.hasKey)}
                    onClick={() => {
                      testCancelled.current = false;
                      void perform('test', async () => {
                        const text = await api.testConnection({ ...(key ? { apiKey: key } : {}) });
                        setFeedback({
                          action: 'test',
                          text:
                            key || state.settings.mode !== 'deepseek'
                              ? '连接可用'
                              : `${text.replace(/[。.!！]+$/, '')}，连接可用`,
                        });
                      });
                    }}
                  >
                    {pending === 'test' && <LoaderCircle size={14} className="spin" />}
                    {pending === 'test' ? '正在测试…' : '测试连接'}
                  </button>
                  {pending === 'test' && (
                    <button
                      className="text-button"
                      onClick={() => {
                        testCancelled.current = true;
                        void api.cancelConnection();
                      }}
                    >
                      取消测试
                    </button>
                  )}
                  {state.settings.hasKey && (
                    <button
                      className="text-button"
                      disabled={disabled}
                      onClick={() =>
                        void perform('remove', async () => {
                          onState(await api.deleteKey());
                          setKey('');
                          draft.current.apiKey = '';
                          setFeedback({ action: 'remove', text: '连接密钥已移除' });
                        })
                      }
                    >
                      {pending === 'remove' && <LoaderCircle size={13} className="spin" />}移除密钥
                    </button>
                  )}
                </div>
                {result(['test'])}
              </div>
            </details>
            {state.settings.mode === 'deepseek' && (
              <button
                className="text-button use-demo"
                disabled={disabled}
                onClick={() =>
                  void perform('demo', async () => {
                    onState(await api.saveSettings({ mode: 'demo' }));
                    setFeedback({ action: 'demo', text: '已切换到本地示例' });
                  })
                }
              >
                使用本地示例
              </button>
            )}
          </>
        )}
        {tab === '接口' && (
          <>
            <p className="panel-intro">
              统一查看在场当前接入的能力。停用后，Agent 不会再调用该接口；权限、来源和网络范围仍由宿主控制。
            </p>
            <section className="interface-manager" aria-label="接口管理列表">
              {state.interfaces.map((item) => {
                const scopes = [...new Set(item.capabilities.flatMap((capability) => capability.requiredScopes))];
                return (
                  <details key={item.id} className="interface-item" open>
                    <summary className="interface-summary">
                      <span>
                        <strong>{item.displayName}</strong>
                        <small>
                          v{item.version} · {item.connection.connected ? '连接可用' : '连接未就绪'}
                        </small>
                      </span>
                      <span className={`interface-state ${item.enabled ? 'enabled' : ''}`}>
                        {item.enabled ? '已启用' : '已停用'}
                      </span>
                    </summary>
                    <div className="interface-detail">
                      <p>{item.description}</p>
                      <small>能力：{item.capabilities.map((capability) => capability.displayName).join('、') || '未声明'}</small>
                      <small>权限：{scopes.join('、') || '无需额外权限'}</small>
                      <small>网络：{item.egressHosts.join('、') || '仅本地'}</small>
                      {item.connection.reason && <small>状态：{item.connection.reason}</small>}
                      <Switch
                        checked={item.enabled}
                        onChange={(enabled) => void toggleInterface(item.id, enabled)}
                        label={`${item.displayName}接口`}
                        detail={item.enabled ? 'Agent 可以在获得本轮范围许可后调用' : 'Agent 不会调用此接口'}
                        disabled={busy || !!interfacePending}
                      />
                    </div>
                  </details>
                );
              })}
            </section>
            {result(['interface'])}
            <section className="plugin-manager" aria-label="第三方插件管理">
              <div className="plugin-manager-heading">
                <div>
                  <strong>第三方插件</strong>
                  <small>只接受在场插件 ZIP 包 · 变更在重启在场后生效</small>
                </div>
                <button
                  className="subtle-button"
                  disabled={busy || !!pending || !!interfacePending}
                  onClick={() =>
                    void perform('plugin-install', async () => {
                      const next = await api.installPlugin();
                      onState(next);
                      const pendingPlugin = next.plugins.find((plugin) => plugin.lifecycle === 'pending_install');
                      setFeedback({
                        action: 'plugin-install',
                        text: pendingPlugin
                          ? `已识别并导入“${pendingPlugin.displayName}” v${pendingPlugin.version}，重启在场后可在接口中启用`
                          : '未导入插件包，当前没有改变',
                      });
                    })
                  }
                >
                  {pending === 'plugin-install' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}
                  导入插件包
                </button>
              </div>
              <p className="plugin-manager-note">
                选择后会先识别插件名称、版本、能力、权限和网络范围，再由你确认；普通 ZIP、文档压缩包或安装程序会被拒绝。插件默认停用。
              </p>
              {state.plugins?.length ? (
                <div className="plugin-list">
                  {state.plugins.map((plugin) => (
                    <div key={plugin.id} className="plugin-item">
                      <div className="plugin-item-main">
                        <strong>{plugin.displayName}</strong>
                        <small>
                          v{plugin.version} · {pluginLifecycle(plugin)}
                          {plugin.activeVersion && plugin.pendingVersion ? ` · 当前 v${plugin.activeVersion}` : ''}
                        </small>
                        {plugin.error && <small className="plugin-error">{plugin.error}</small>}
                      </div>
                      <div className="plugin-actions">
                        {plugin.lifecycle === 'active' && (
                          <button
                            className="text-button"
                            disabled={busy || !!pending || !!interfacePending}
                            onClick={() =>
                              void perform('plugin-upgrade', async () => {
                                const next = await api.upgradePlugin(plugin.id);
                                onState(next);
                                const pendingPlugin = next.plugins.find(
                                  (item) => item.id === plugin.id && item.lifecycle === 'pending_upgrade',
                                );
                                setFeedback({
                                  action: 'plugin-upgrade',
                                  text: pendingPlugin
                                    ? `“${pendingPlugin.displayName}”升级包已识别，重启在场后切换到 v${pendingPlugin.pendingVersion ?? pendingPlugin.version}`
                                    : '未升级插件包，当前没有改变',
                                });
                              })
                            }
                          >
                            <Pencil size={13} />升级
                          </button>
                        )}
                        {plugin.lifecycle !== 'pending_uninstall' && (
                          <button
                            className="text-button danger-text"
                            disabled={busy || !!pending || !!interfacePending}
                            onClick={() => setPluginConfirm(plugin)}
                          >
                            <Trash2 size={13} />卸载
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <small className="plugin-empty">还没有安装第三方插件。</small>
              )}
              {pluginConfirm && (
                <div className="plugin-confirm">
                  <p>确定卸载“{pluginConfirm.displayName}”？当前版本会继续运行到关闭在场，重启后完成卸载。</p>
                  <button
                    className="danger-button"
                    disabled={busy || !!pending || !!interfacePending}
                    onClick={() =>
                      void perform('plugin-uninstall', async () => {
                        onState(await api.uninstallPlugin(pluginConfirm.id));
                        setPluginConfirm(null);
                        setFeedback({ action: 'plugin-uninstall', text: '卸载已安排，重启在场后生效' });
                      })
                    }
                  >
                    确认卸载
                  </button>
                  <button className="text-button" onClick={() => setPluginConfirm(null)}>取消</button>
                </div>
              )}
            </section>
            {result(['plugin-install', 'plugin-upgrade', 'plugin-uninstall'])}
          </>
        )}
        {tab === '记忆' && <MemoryPanelSimple state={state} onState={onState} busy={busy} />}
        {tab === '偏好' && (
          <>
            <p className="panel-intro">决定在场何时提醒你，以及怎样回应你的请求。</p>
            <section className="preference-section">
              <h3 className="section-title">提醒</h3>
              <Switch
                checked={state.settings.remindersEnabled}
                onChange={(v) => void update('reminders', { remindersEnabled: v })}
                label="提醒安排"
                detail="仅在应用运行时提醒已设定时间的安排"
                disabled={!!pending || (busy && !state.settings.remindersEnabled)}
              />
              {result(['reminders'])}
            </section>
            <section className="preference-section">
              <h3 className="section-title">回复方式</h3>
              <label className="field-label behavior-label">
                回复偏好
                <textarea
                  value={guidance}
                  onChange={(e) => {
                    setGuidance(e.target.value);
                    draft.current.guidance = e.target.value;
                  }}
                  rows={3}
                  maxLength={4000}
                  placeholder="例如：说话简短一些，保留晚上的休息时间"
                />
              </label>
              <div className="field-buttons">
                <button
                  className="primary-button"
                  disabled={disabled || guidance === state.settings.guidance}
                  onClick={() =>
                    void perform('guidance', async () => {
                      onState(await api.saveSettings({ guidance }));
                      setFeedback({ action: 'guidance', text: '回复偏好已保存' });
                    })
                  }
                >
                  {pending === 'guidance' && <LoaderCircle size={14} className="spin" />}保存偏好
                </button>
                {guidance !== state.settings.guidance && <small className="setting-hint">未保存的修改</small>}
              </div>
              {result(['guidance'])}
            </section>
            <details className="data-controls">
              <summary className="section-title">本地资料与导出</summary>
              <div className="data-controls-body">
                <p>对话保存在本机；连接模型时，会发送本轮允许使用的资料。数据库暂未整体加密。</p>
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() =>
                    void perform('export', async () => {
                      if (await api.exportData()) setFeedback({ action: 'export', text: '资料已导出' });
                    })
                  }
                >
                  {pending === 'export' ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Download size={15} />
                  )}
                  导出我的资料
                </button>
                {result(['export'])}
                {clearConfirm ? (
                  <div className="clear-confirm">
                    <p>确定清空本机资料？这会删除对话、记忆、安排和连接密钥，且无法撤销</p>
                    <button
                      className="danger-button"
                      disabled={disabled}
                      onClick={() =>
                        void perform('clear', async () => {
                          onState(await api.clearData());
                          draft.current = {};
                          onClear();
                          notify('本地资料已清空');
                        })
                      }
                    >
                      确认清空
                    </button>
                    <button className="text-button" onClick={() => setClearConfirm(false)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    className="text-button danger-text"
                    disabled={disabled}
                    onClick={() => setClearConfirm(true)}
                  >
                    <Trash2 size={14} />
                    清空本地资料
                  </button>
                )}
                {result(['clear'])}
              </div>
            </details>
          </>
        )}
      </div>
    </Modal>
  );
}
