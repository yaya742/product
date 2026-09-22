import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  DEFAULT_MOBILE_VM_CONFIG,
  isMobileVmSession,
  loadMobileVmConfig,
  saveMobileVmConfig,
  type MobileVmConfig,
  type MobileVmOrientation,
} from './runtime/mobileVm';

interface VmDevice {
  id: string;
  name: string;
  platform: string;
  width: number;
  height: number;
  frame: 'android' | 'ios';
}

const DEVICES: VmDevice[] = [
  { id: 'android-compact', name: 'Android 小屏', platform: 'Android 13 · 360 × 800', width: 360, height: 800, frame: 'android' },
  { id: 'android-standard', name: 'Android 标准', platform: 'Android 14 · 412 × 915', width: 412, height: 915, frame: 'android' },
  { id: 'iphone-15', name: 'iPhone 15', platform: 'iOS 17 · 393 × 852', width: 393, height: 852, frame: 'ios' },
];

function deviceSize(device: VmDevice, orientation: MobileVmOrientation): { width: number; height: number } {
  return orientation === 'portrait'
    ? { width: device.width, height: device.height }
    : { width: device.height, height: device.width };
}

function clampDeviceId(value: string): string {
  return DEVICES.some((device) => device.id === value) ? value : DEFAULT_MOBILE_VM_CONFIG.deviceId;
}

export function MobileVmFrame({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<MobileVmConfig>(() => loadMobileVmConfig());
  const [scale, setScale] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const device = useMemo(() => DEVICES.find((item) => item.id === config.deviceId) || DEVICES[1], [config.deviceId]);
  const size = deviceSize(device, config.orientation);

  useEffect(() => {
    document.body.classList.add('mobile-vm-body');
    return () => document.body.classList.remove('mobile-vm-body');
  }, []);

  useEffect(() => {
    if (isMobileVmSession()) saveMobileVmConfig(config);
  }, [config]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateScale = () => {
      const availableWidth = Math.max(240, stage.clientWidth - 28);
      const availableHeight = Math.max(240, stage.clientHeight - 28);
      setScale(Math.min(1, availableWidth / size.width, availableHeight / size.height));
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [size.height, size.width]);

  if (!isMobileVmSession()) return <>{children}</>;

  const holderStyle = { width: size.width * scale, height: size.height * scale };
  const deviceStyle = {
    width: `${size.width}px`,
    height: `${size.height}px`,
    transform: `scale(${scale})`,
  };
  const screenStyle = {
    '--vm-screen-width': `${size.width}px`,
    '--vm-screen-height': `${size.height}px`,
  } as CSSProperties;

  function updateConfig(partial: Partial<MobileVmConfig>) {
    setConfig((current) => ({ ...current, ...partial }));
  }

  function toggleOrientation() {
    updateConfig({ orientation: config.orientation === 'portrait' ? 'landscape' : 'portrait' });
  }

  function exitVm() {
    const url = new URL(window.location.href);
    url.searchParams.delete('mobileVm');
    window.location.assign(url.toString());
  }

  return (
    <main className="mobile-vm-workbench">
      <header className="mobile-vm-toolbar">
        <div>
          <strong>移动端虚拟机</strong>
          <span>同一份移动端代码 · 浏览器内测试壳</span>
        </div>
        <div className="mobile-vm-toolbar-actions">
          <label>
            <span>设备</span>
            <select value={config.deviceId} onChange={(event) => updateConfig({ deviceId: clampDeviceId(event.target.value) })}>
              {DEVICES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={toggleOrientation}>{config.orientation === 'portrait' ? '横屏' : '竖屏'}</button>
          <button type="button" onClick={exitVm}>退出虚拟机</button>
        </div>
      </header>

      <div className="mobile-vm-layout">
        <section className="mobile-vm-stage" ref={stageRef} aria-label="手机虚拟机预览">
          <div className="mobile-vm-device-holder" style={holderStyle}>
            <div className={`mobile-vm-device mobile-vm-device-${device.frame}`} style={deviceStyle}>
              <div className="mobile-vm-statusbar">
                <span>9:41</span>
                <span className="mobile-vm-status-icons">▴ ᯤ ▰</span>
              </div>
              <div className={`mobile-vm-screen ${config.keyboard ? 'mobile-vm-keyboard-open' : ''}`} style={screenStyle}>
                {children}
              </div>
              <div className="mobile-vm-homebar" />
            </div>
          </div>
        </section>

        <aside className="mobile-vm-controls" aria-label="虚拟机测试开关">
          <div className="mobile-vm-card">
            <p className="mobile-vm-eyebrow">测试环境</p>
            <h1>{device.name}</h1>
            <p className="mobile-vm-muted">{device.platform} · {config.orientation === 'portrait' ? '竖屏' : '横屏'}</p>
            <div className="mobile-vm-field">
              <span>网络</span>
              <div className="mobile-vm-segmented">
                <button type="button" className={config.network === 'online' ? 'selected' : ''} onClick={() => updateConfig({ network: 'online' })}>在线</button>
                <button type="button" className={config.network === 'offline' ? 'selected' : ''} onClick={() => updateConfig({ network: 'offline' })}>断网</button>
              </div>
            </div>
            <div className="mobile-vm-field">
              <span>定位</span>
              <div className="mobile-vm-segmented">
                <button type="button" className={config.location === 'available' ? 'selected' : ''} onClick={() => updateConfig({ location: 'available' })}>紫金港</button>
                <button type="button" className={config.location === 'unavailable' ? 'selected' : ''} onClick={() => updateConfig({ location: 'unavailable' })}>不可用</button>
              </div>
            </div>
            <label className="mobile-vm-switch-row">
              <span>展开虚拟键盘</span>
              <input type="checkbox" checked={config.keyboard} onChange={(event) => updateConfig({ keyboard: event.target.checked })} />
            </label>
          </div>
          <div className="mobile-vm-card mobile-vm-note">
            <strong>这是什么</strong>
            <p>它模拟屏幕、安全区、旋转和部分设备能力，不包含完整 Android 系统。DeepSeek、校园登录和天气请求仍会按这里的网络开关返回真实结果。</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
