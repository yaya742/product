import {
  createConversation,
  createInitialState,
  DEFAULT_PROFILE,
  type MobileConversation,
  type MobileAttachment,
  type MobileCampusData,
  type CampusCourse,
  type CampusExam,
  type CampusGrade,
  type CampusTodo,
  type MobileLanguage,
  type MobileMessage,
  type MobileProfile,
  type MobileReminder,
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
  }).map((item) => {
    const raw = item as unknown as Record<string, unknown>;
    const attachment = parseAttachment(raw.attachment);
    return {
      ...item,
      ...(attachment ? { attachment } : {}),
      translations: parseTranslations(raw.translations),
    };
  });
}

function parseAttachment(value: unknown): MobileAttachment | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.name !== 'string') return undefined;
  if (value.kind === 'text' && typeof value.text === 'string' && value.text.length <= 20_000)
    return { kind: 'text', name: value.name.slice(0, 160), text: value.text };
  if (
    value.kind === 'image' &&
    value.mimeType === 'image/jpeg' &&
    typeof value.dataUrl === 'string' &&
    value.dataUrl.startsWith('data:image/jpeg;base64,') &&
    value.dataUrl.length <= 2_000_000 &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  ) {
    return {
      kind: 'image',
      name: value.name.slice(0, 160),
      mimeType: 'image/jpeg',
      dataUrl: value.dataUrl,
      width: Math.max(1, Math.round(value.width)),
      height: Math.max(1, Math.round(value.height)),
    };
  }
  return undefined;
}

function parseReminders(value: unknown): MobileReminder[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.dueAt !== 'string' ||
      Number.isNaN(Date.parse(item.dueAt))
    ) return [];
    const notificationId = typeof item.notificationId === 'number' && Number.isFinite(item.notificationId)
      ? Math.trunc(item.notificationId)
      : Math.abs([...item.id].reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) | 0), 0));
    return [{
      id: item.id,
      title: item.title.trim().slice(0, 120) || '提醒',
      notes: typeof item.notes === 'string' ? item.notes.trim().slice(0, 500) : '',
      dueAt: item.dueAt,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      completed: item.completed === true,
      notificationId: Math.max(1, notificationId),
    }];
  }).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 100);
}

function parseCampusData(value: unknown): MobileCampusData | null {
  if (!isRecord(value) || typeof value.fetchedAt !== 'string') return null;
  const parseList = <T>(item: unknown, fields: string[]): T[] => {
    if (!Array.isArray(item)) return [];
    return item.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const valid = fields.every((field) => typeof entry[field] === 'string');
      return valid ? [entry as T] : [];
    }).slice(0, 200);
  };
  const courses = parseList<CampusCourse>(value.courses, ['id', 'name', 'teacher', 'location', 'time', 'weeks']);
  const exams = parseList<Record<string, unknown>>(value.exams, ['id', 'name', 'time', 'location', 'seat']).map((exam, index) => ({
    id: String(exam.id || `exam-${index}`),
    name: String(exam.name || '未命名考试'),
    time: String(exam.time || '时间未提供'),
    location: String(exam.location || ''),
    seat: String(exam.seat || ''),
    type: typeof exam.type === 'string' ? exam.type : 'final',
    status: exam.status === 'finished' || exam.status === 'upcoming' ? exam.status : 'unknown',
  } satisfies CampusExam));
  const grades = parseList<CampusGrade>(value.grades, ['id', 'name', 'score', 'credit', 'point']);
  const totalCredit = typeof value.totalCredit === 'number' && Number.isFinite(value.totalCredit)
    ? value.totalCredit
    : grades.reduce((sum, grade) => sum + (Number.isFinite(Number(grade.credit)) ? Number(grade.credit) : 0), 0);
  const counted = grades.flatMap((grade) => {
    const credit = Number(grade.credit);
    const point = Number(grade.point);
    return credit > 0 && Number.isFinite(credit) && Number.isFinite(point) ? [{ credit, point }] : [];
  });
  const gpa = typeof value.gpa === 'number' && Number.isFinite(value.gpa)
    ? value.gpa
    : counted.length ? counted.reduce((sum, item) => sum + item.credit * item.point, 0) / counted.reduce((sum, item) => sum + item.credit, 0) : null;
  return {
    fetchedAt: value.fetchedAt,
    academicYear: typeof value.academicYear === 'string' ? value.academicYear : '',
    term: typeof value.term === 'string' ? value.term : '',
    courses,
    exams,
    grades,
    todos: parseList<CampusTodo>(value.todos, ['id', 'name', 'course', 'deadline', 'status']),
    gpa,
    totalCredit,
  };
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
      reminders: parseReminders(value.reminders),
      campus: parseCampusData(value.campus),
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
