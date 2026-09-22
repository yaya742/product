export type MobileVmOrientation = 'portrait' | 'landscape';
export type MobileVmNetwork = 'online' | 'offline';
export type MobileVmLocation = 'available' | 'unavailable';

export interface MobileVmConfig {
  deviceId: string;
  orientation: MobileVmOrientation;
  network: MobileVmNetwork;
  location: MobileVmLocation;
  keyboard: boolean;
}

const STORAGE_KEY = 'zaichang.mobile.vm.v1';
const CHANGE_EVENT = 'zaichang-mobile-vm-change';

export const DEFAULT_MOBILE_VM_CONFIG: MobileVmConfig = {
  deviceId: 'android-standard',
  orientation: 'portrait',
  network: 'online',
  location: 'available',
  keyboard: false,
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

export function isMobileVmSession(): boolean {
  return import.meta.env.DEV && isBrowser() && new URLSearchParams(window.location.search).get('mobileVm') === '1';
}

export function loadMobileVmConfig(): MobileVmConfig {
  if (!isBrowser()) return { ...DEFAULT_MOBILE_VM_CONFIG };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MOBILE_VM_CONFIG };
    const value = JSON.parse(raw) as Partial<MobileVmConfig>;
    return {
      deviceId: typeof value.deviceId === 'string' ? value.deviceId : DEFAULT_MOBILE_VM_CONFIG.deviceId,
      orientation: value.orientation === 'landscape' ? 'landscape' : 'portrait',
      network: value.network === 'offline' ? 'offline' : 'online',
      location: value.location === 'unavailable' ? 'unavailable' : 'available',
      keyboard: value.keyboard === true,
    };
  } catch {
    return { ...DEFAULT_MOBILE_VM_CONFIG };
  }
}

export function saveMobileVmConfig(config: MobileVmConfig): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent<MobileVmConfig>(CHANGE_EVENT, { detail: config }));
  } catch {
    // The simulator remains usable when browser storage is unavailable.
  }
}

export function subscribeToMobileVm(listener: (config: MobileVmConfig) => void): () => void {
  if (!isBrowser()) return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<MobileVmConfig>).detail);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function isMobileVmOffline(): boolean {
  return isMobileVmSession() && loadMobileVmConfig().network === 'offline';
}

export function isMobileVmLocationAvailable(): boolean {
  return !isMobileVmSession() || loadMobileVmConfig().location === 'available';
}

export function mobileVmLocation(): { latitude: number; longitude: number; accuracy: number; timestamp: number } {
  return { latitude: 30.30513, longitude: 120.07665, accuracy: 18, timestamp: Date.now() };
}

export function launchMobileVm(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('mobileVm', '1');
  window.location.assign(url.toString());
}
