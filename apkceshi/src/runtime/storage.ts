import {
  createConversation,
  createInitialState,
  DEFAULT_PROFILE,
  type MobileConversation,
  type MobileAttachment,
  type MobileAgendaItem,
  type MobileCampusData,
  type CampusCourse,
  type CampusExam,
  type CampusGrade,
  type CampusPracticeProject,
  type CampusPracticeSummary,
  type CampusTodo,
  type MobileLanguage,
  type MobileMessage,
  type MobileProfile,
  type MobileReminder,
  type MobileState,
  type MobileTheme,
} from './types';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const STORAGE_KEY = 'zaichang.mobile.local.v2';
const SECURE_API_KEY = 'zaichang.mobile.deepseek.api-key';
const SECURE_STUDENT_PASSWORD = 'zaichang.mobile.campus.password';
const LEGACY_DUPLICATE_HISTORY_TITLES = new Set(['查看课表请求', '查询课表', '查看课表', '数学学院转专业名额咨询']);

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
      ...(raw.ephemeral === true ? { ephemeral: true } : {}),
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

function parseAgenda(value: unknown): MobileAgendaItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string') return [];
    const startsAt = typeof item.startsAt === 'string' && !Number.isNaN(Date.parse(item.startsAt))
      ? item.startsAt
      : undefined;
    const durationMinutes = typeof item.durationMinutes === 'number' && Number.isFinite(item.durationMinutes)
      ? Math.max(1, Math.min(24 * 60, Math.round(item.durationMinutes)))
      : undefined;
    return [{
      id: item.id.slice(0, 160),
      title: item.title.trim().slice(0, 160) || '本地安排',
      detail: typeof item.detail === 'string' ? item.detail.trim().slice(0, 500) : '',
      ...(startsAt ? { startsAt } : {}),
      ...(durationMinutes ? { durationMinutes } : {}),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      status: item.status === 'done' || item.status === 'cancelled' ? item.status : 'saved',
      source: item.source === 'user' ? 'user' : 'assistant',
    } satisfies MobileAgendaItem];
  }).slice(-100);
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
  const rawPracticeSummary = isRecord(value.practiceSummary) ? value.practiceSummary : null;
  const practiceNumber = (item: unknown): number | null => typeof item === 'number' && Number.isFinite(item) ? item : null;
  const practiceSummary: CampusPracticeSummary | null = rawPracticeSummary
    ? {
        secondClassPoints: practiceNumber(rawPracticeSummary.secondClassPoints),
        thirdClassPoints: practiceNumber(rawPracticeSummary.thirdClassPoints),
        fourthClassPoints: practiceNumber(rawPracticeSummary.fourthClassPoints),
        aestheticEducationPassed: typeof rawPracticeSummary.aestheticEducationPassed === 'boolean' ? rawPracticeSummary.aestheticEducationPassed : null,
        laborEducationPassed: typeof rawPracticeSummary.laborEducationPassed === 'boolean' ? rawPracticeSummary.laborEducationPassed : null,
        source: typeof rawPracticeSummary.source === 'string' ? rawPracticeSummary.source.slice(0, 120) : '素质拓展平台',
      }
    : null;
  const practiceProjects: CampusPracticeProject[] = Array.isArray(value.practiceProjects)
    ? value.practiceProjects.flatMap((item) => {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return [];
        return [{
          id: item.id.slice(0, 120),
          name: item.name.slice(0, 240),
          category: typeof item.category === 'string' ? item.category.slice(0, 80) : '未分类课堂',
          projectType: typeof item.projectType === 'string' ? item.projectType.slice(0, 120) : '',
          qualityType: typeof item.qualityType === 'string' ? item.qualityType.slice(0, 120) : '',
          score: practiceNumber(item.score),
          status: typeof item.status === 'string' ? item.status.slice(0, 80) : '状态未知',
          approved: item.approved === true,
          role: typeof item.role === 'string' ? item.role.slice(0, 160) : '',
          remark: typeof item.remark === 'string' ? item.remark.slice(0, 240) : '',
          activityTime: typeof item.activityTime === 'string' ? item.activityTime.slice(0, 100) : '',
        } satisfies CampusPracticeProject];
      }).slice(0, 200)
    : [];
  return {
    fetchedAt: value.fetchedAt,
    academicYear: typeof value.academicYear === 'string' ? value.academicYear : '',
    term: typeof value.term === 'string' ? value.term : '',
    courses,
    exams,
    grades,
    todos: parseList<CampusTodo>(value.todos, ['id', 'name', 'course', 'deadline', 'status']),
    practiceSummary,
    practiceProjects,
    gpa,
    totalCredit,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 12)
      : [],
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
  }).filter((conversation) => !LEGACY_DUPLICATE_HISTORY_TITLES.has(conversation.title.trim()));
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
      agenda: parseAgenda(value.agenda),
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
    const persisted: MobileState = {
      ...state,
      apiKey: Capacitor.isNativePlatform() ? '' : state.apiKey,
      profile: Capacitor.isNativePlatform() ? { ...state.profile, studentPassword: '' } : state.profile,
      conversations: state.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.filter((message) => !message.ephemeral),
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    if (Capacitor.isNativePlatform()) {
      void Preferences.set({ key: SECURE_API_KEY, value: state.apiKey }).catch(() => {});
      void Preferences.set({ key: SECURE_STUDENT_PASSWORD, value: state.profile.studentPassword }).catch(() => {});
    }
  } catch {
    // Storage is best effort. The app remains usable for the current session.
  }
}

export async function hydrateMobileSecrets(state: MobileState): Promise<MobileState> {
  if (!Capacitor.isNativePlatform()) return state;
  try {
    const [apiKey, password] = await Promise.all([
      Preferences.get({ key: SECURE_API_KEY }),
      Preferences.get({ key: SECURE_STUDENT_PASSWORD }),
    ]);
    const nextApiKey = apiKey.value || state.apiKey;
    const nextPassword = password.value || state.profile.studentPassword;
    if (!apiKey.value && state.apiKey) await Preferences.set({ key: SECURE_API_KEY, value: state.apiKey });
    if (!password.value && state.profile.studentPassword) await Preferences.set({ key: SECURE_STUDENT_PASSWORD, value: state.profile.studentPassword });
    return {
      ...state,
      apiKey: nextApiKey,
      profile: { ...state.profile, studentPassword: nextPassword },
    };
  } catch {
    return state;
  }
}

export function clearMobileState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('zaichang.mobile.local.v1');
    if (Capacitor.isNativePlatform()) {
      void Preferences.remove({ key: SECURE_API_KEY }).catch(() => {});
      void Preferences.remove({ key: SECURE_STUDENT_PASSWORD }).catch(() => {});
    }
  } catch {
    // Best effort only.
  }
}
