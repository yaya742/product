import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value?: string }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  clear(): Promise<void>;
}

const SecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage');

export async function secureGet(key: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const result = await SecureStorage.get({ key });
  return typeof result.value === 'string' ? result.value : null;
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!value) {
    await SecureStorage.remove({ key });
    return;
  }
  await SecureStorage.set({ key, value });
}

export async function secureRemove(key: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await SecureStorage.remove({ key });
}

export async function secureClear(): Promise<void> {
  if (Capacitor.isNativePlatform()) await SecureStorage.clear();
}
