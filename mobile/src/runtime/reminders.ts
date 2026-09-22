import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { MobileReminder } from './types';

const CHANNEL_ID = 'zaichang-reminders';

function notificationId(reminderId: string): number {
  const hash = [...reminderId].reduce((value, character) => ((value * 31 + character.charCodeAt(0)) | 0), 17);
  return Math.max(1, Math.abs(hash));
}

export function withNotificationId(reminder: Omit<MobileReminder, 'notificationId'>): MobileReminder {
  return { ...reminder, notificationId: notificationId(reminder.id) };
}

export async function scheduleLocalReminder(reminder: MobileReminder): Promise<'scheduled' | 'permission-denied' | 'web'> {
  if (!Capacitor.isNativePlatform()) return 'web';
  const permission = await LocalNotifications.checkPermissions();
  const current = permission.display === 'granted'
    ? permission
    : await LocalNotifications.requestPermissions();
  if (current.display !== 'granted') return 'permission-denied';
  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: '在场提醒',
    description: '在场的本地日程提醒',
    importance: 4,
    visibility: 1,
  });
  await LocalNotifications.schedule({
    notifications: [{
      id: reminder.notificationId,
      title: reminder.title,
      body: reminder.notes || '到时间了。',
      channelId: CHANNEL_ID,
      schedule: { at: new Date(reminder.dueAt), allowWhileIdle: true },
      extra: { reminderId: reminder.id },
    }],
  });
  return 'scheduled';
}

export async function cancelLocalReminder(reminder: MobileReminder): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.cancel({ notifications: [{ id: reminder.notificationId }] });
}
