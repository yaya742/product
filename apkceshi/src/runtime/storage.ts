import {
  createConversation,
  createInitialState,
  DEFAULT_PROFILE,
  type MobileConversation,
  type MobileLanguage,
  type MobileMessage,
  type MobileProfile,
  type MobileState,
  type MobileTheme,
} from './types';

const STORAGE_KEY = 'zaichang.mobile.local.v2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseTranslations(value: unknown): MobileMessage['translations'] | undefined {
  if (!isRecord(value)) return undefined;
  const translations: MobileMessage['translations'] = {};
  for (const language of ['zh-CN', 'zh-TW', 'en'] as MobileLanguage[]) {
    if (typeof value[language] === 'string') translations[language] = value[language];
  }
  return Object.keys(translations).length ? translations : undefined;
}

function parseMessages(value: unknown): MobileMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MobileMessage => {
    if (!isRecord(item)) return false;
    return (
      typeof item.id === 'string' &&
      (item.role === 'user' || item.role === 'assistant') &&
      typeof item.content === 'string' &&
      typeof item.createdAt === 'string' &&
      (item.status === 'running' || item.status === 'done' || item.status === 'error')
    );
  }).map((item) => ({ ...item, translations: parseTranslations((item as unknown as Record<string, unknown>).translations) }));
}

function parseConversations(value: unknown): MobileConversation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string') return [];
    const messages = parseMessages(item.messages);
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
    return [{
      id: item.id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 60) : '新对话',
      messages,
      createdAt,
      updatedAt,
    }];
  });
}

function parseProfile(value: unknown): MobileProfile {
  if (!isRecord(value)) return { ...DEFAULT_PROFILE };
  const language: MobileLanguage = value.language === 'zh-TW' || value.language === 'en' ? value.language : 'zh-CN';
  const theme: MobileTheme = value.theme === 'dark' ? 'dark' : 'light';
  const rawAvatar = typeof value.avatar === 'string' ? value.avatar.trim() : '';
  const avatar = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(rawAvatar) && rawAvatar.length <= 2_000_000
    ? rawAvatar
    : rawAvatar.slice(0, 4);
  return {
    avatar: avatar || DEFAULT_PROFILE.avatar,
    language,
    theme,
    studentId: typeof value.studentId === 'string' ? value.studentId : '',
    studentPassword: typeof value.studentPassword === 'string' ? value.studentPassword : '',
  };
}

export function loadMobileState(): MobileState {
  const fallback = createInitialState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('zaichang.mobile.local.v1');
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return fallback;

    let conversations = parseConversations(value.conversations);
    if (!conversations.length) {
      const legacyMessages = parseMessages(value.messages);
      const legacy = createConversation(legacyMessages.find((message) => message.role === 'user')?.content.slice(0, 28) || '新对话');
      legacy.messages = legacyMessages;
      legacy.updatedAt = legacyMessages.at(-1)?.createdAt || legacy.createdAt;
      conversations = [legacy];
    }
    const activeId = typeof value.activeConversationId === 'string' && conversations.some((item) => item.id === value.activeConversationId)
      ? value.activeConversationId
      : conversations[0].id;
    const memories = Array.isArray(value.memories)
      ? value.memories.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 16)
      : [];
    return {
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      conversations,
      activeConversationId: activeId,
      memories,
      profile: parseProfile(value.profile),
    };
  } catch {
    return fallback;
  }
}

export function saveMobileState(state: MobileState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage is best effort. The app remains usable for the current session.
  }
}

export function clearMobileState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('zaichang.mobile.local.v1');
  } catch {
    // Best effort only.
  }
}
