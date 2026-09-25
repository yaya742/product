import { Capacitor, registerPlugin } from '@capacitor/core';

interface CampusBackgroundSyncPlugin {
  enable(options: { academicYear: string; term: string }): Promise<void>;
  disable(): Promise<void>;
  getSnapshot(): Promise<{ snapshot?: string | null; lastAttemptAt?: string; lastStatus?: string }>;
}

const CampusBackgroundSync = registerPlugin<CampusBackgroundSyncPlugin>('CampusBackgroundSync');

export async function enableCampusBackgroundSync(academicYear: string, term: string): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') return false;
  await CampusBackgroundSync.enable({ academicYear, term });
  return true;
}

export async function disableCampusBackgroundSync(): Promise<void> {
  if (Capacitor.getPlatform() === 'android') await CampusBackgroundSync.disable();
}

export async function getCampusBackgroundSnapshot(): Promise<string | null> {
  if (Capacitor.getPlatform() !== 'android') return null;
  const result = await CampusBackgroundSync.getSnapshot();
  return typeof result.snapshot === 'string' && result.snapshot ? result.snapshot : null;
}
