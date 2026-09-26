import { Capacitor, registerPlugin } from '@capacitor/core';

interface CampusOfficialPagePlugin {
  open(options: { url: string }): Promise<void>;
  setCookies(options: { url: string; cookies: string[] }): Promise<void>;
}

const CampusOfficialPage = registerPlugin<CampusOfficialPagePlugin>('CampusOfficialPage');

export function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function openCampusOfficialPage(url: string): Promise<void> {
  await CampusOfficialPage.open({ url });
}

export async function mirrorCampusCookies(url: string, cookies: string[]): Promise<void> {
  if (!cookies.length) return;
  await CampusOfficialPage.setCookies({ url, cookies });
}
