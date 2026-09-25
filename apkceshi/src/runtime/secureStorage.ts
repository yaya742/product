import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value?: string }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  clear(): Promise<void>;
}

const SecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage');

/** Return only allowlisted operation/type codes; never surface native messages or stored values. */
export function secureStorageDiagnostic(error: unknown): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const candidates = [record?.message, error instanceof Error ? error.message : undefined, record?.code];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = candidate.match(/(?:^|\s)(secure_storage_(get|set|remove)_failed)(?::([A-Za-z][A-Za-z0-9]*))?(?:$|\s)/);
    if (match) return match[3] ? `${match[1]}:${match[3]}` : match[1];
    if (candidate === 'secure_storage_migration_verification_failed') return candidate;
  }
  return 'secure_storage_migration_failed';
}

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
