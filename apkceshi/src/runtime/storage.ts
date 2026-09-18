import { EMPTY_MOBILE_STATE, type MobileState } from './types';

const STORAGE_KEY = 'zaichang.mobile.local.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function loadMobileState(): MobileState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_MOBILE_STATE };
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return { ...EMPTY_MOBILE_STATE };
    const messages = Array.isArray(value.messages)
      ? value.messages.filter((item): item is MobileState['messages'][number] => {
          if (!isRecord(item)) return false;
          return (
            typeof item.id === 'string' &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string' &&
            typeof item.createdAt === 'string' &&
            (item.status === 'running' || item.status === 'done' || item.status === 'error')
          );
        })
      : [];
    const memories = Array.isArray(value.memories)
      ? value.memories.filter((item): item is string => typeof item === 'string').slice(0, 16)
      : [];
    return {
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      messages,
      memories,
    };
  } catch {
    return { ...EMPTY_MOBILE_STATE };
  }
}

export function saveMobileState(state: MobileState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in a private browser context. The app remains usable for this session.
  }
}

export function clearMobileState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort only; native secure storage will replace this adapter in the Capacitor build.
  }
}
