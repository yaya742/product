import {
  createConversation,
  createInitialState,
  DEFAULT_PROFILE,
  type MobileConversation,
  type MobileAttachment,
  type MobileAgendaItem,
  type MobileCampusData,
  type CampusCourse,
  type CampusCourseOffering,
  type CampusActivity,
  type CampusExam,
  type CampusGrade,
  type CampusGradeAlert,
  type CampusGpaSummary,
  type CampusHoliday,
  type CampusLearningCourse,
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
import { secureGet, secureRemove, secureSet } from './secureStorage';
import { disableCampusBackgroundSync } from './campusBackgroundSync';
import { enrichCoursesWithAcademicData } from './campus';

const STORAGE_KEY = 'zaichang.mobile.local.v2';
const SECURE_API_KEY = 'zaichang.mobile.deepseek.api-key';
const SECURE_STUDENT_ID = 'zaichang.mobile.campus.student-id';
const SECURE_STUDENT_PASSWORD = 'zaichang.mobile.campus.password';
let nativeSecureStorageReady = !Capacitor.isNativePlatform();
// Remove the duplicate seeded history item shown at the top of the mobile history panel.

function normalizeYearLevel(value: string): string {
  const normalized = value.trim().slice(0, 16);
  const numericLevel = normalized.match(/^大([1-8])$/)?.[1];
  if (!numericLevel) return normalized;
  const labels = ['', '一', '二', '三', '四', '五', '六', '七', '八'];
  return `大${labels[Number(numericLevel)] || numericLevel}`;
}
const LEGACY_DUPLICATE_HISTORY_TITLES = new Set(['简短问候', '查看课表请求', '查询课表', '查看课表', '数学学院转专业名额咨询']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasCourseCredit(value: string): boolean {
  const numeric = Number(value.replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0] || '');
  return Number.isFinite(numeric) && numeric > 0;
}

function parseOfficialCalendarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'ugrs.zju.edu.cn' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
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
  const parsedCourses = parseList<Record<string, unknown>>(value.courses, ['id', 'name', 'teacher', 'location', 'time', 'weeks']).map((course) => ({
    id: String(course.id),
    ...(typeof course.courseKey === 'string' && course.courseKey.trim() ? { courseKey: course.courseKey.trim() } : {}),
    name: String(course.name),
    teacher: String(course.teacher),
    location: String(course.location),
    time: String(course.time),
    ...(typeof course.weekday === 'number' && Number.isInteger(course.weekday) ? { weekday: course.weekday } : {}),
    ...(typeof course.startPeriod === 'number' && Number.isInteger(course.startPeriod) ? { startPeriod: course.startPeriod } : {}),
    ...(typeof course.endPeriod === 'number' && Number.isInteger(course.endPeriod) ? { endPeriod: course.endPeriod } : {}),
    weeks: String(course.weeks),
    credit: typeof course.credit === 'string' ? course.credit : '—',
    score: typeof course.score === 'string' ? course.score : '—',
    completed: course.completed === true,
  } satisfies CampusCourse));
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
  const parsedCourseOfferings = parseList<Record<string, unknown>>(value.courseOfferings, ['id', 'name', 'semesterId', 'credit', 'teachers']).map((item) => ({
    id: String(item.id), name: String(item.name), semesterId: String(item.semesterId), credit: String(item.credit), teachers: String(item.teachers),
    confirmed: typeof item.confirmed === 'boolean' ? item.confirmed : null,
    online: typeof item.online === 'boolean' ? item.online : null,
  } satisfies CampusCourseOffering));
  const learningCourses = parseList<CampusLearningCourse>(value.learningCourses, ['id', 'name', 'code', 'teachers', 'term', 'credit', 'status']);
  // Migrate cached campus data created before timetable credits were joined
  // with grades. This repairs the existing local snapshot without requiring
  // a new login or a manual campus refresh after an app update.
  const courses = enrichCoursesWithAcademicData(parsedCourses, grades, learningCourses);
  const courseOfferings = parsedCourseOfferings.map((offering) => {
    if (hasCourseCredit(offering.credit)) return offering;
    const course = courses.find((item) => item.id === offering.id || (item.courseKey && item.courseKey === offering.id));
    return course && hasCourseCredit(course.credit) ? { ...offering, credit: course.credit } : offering;
  });
  const activities = parseList<CampusActivity>(value.activities, ['id', 'courseId', 'title', 'type', 'startTime', 'endTime', 'deadline', 'status', 'url']);
  const gradeAlerts = parseList<Record<string, unknown>>(value.gradeAlerts, ['id', 'courseKey', 'name', 'credit', 'score', 'point', 'level', 'note']).map((item) => ({
    id: String(item.id), courseKey: String(item.courseKey), name: String(item.name), credit: String(item.credit), score: String(item.score), point: String(item.point),
    level: item.level === 'failed' ? 'failed' : 'attention', note: String(item.note),
  } satisfies CampusGradeAlert));
  const parseGpa = (item: unknown): CampusGpaSummary | null => {
    if (!isRecord(item) || typeof item.throughSemester !== 'string') return null;
    return {
      ...(typeof item.academicYear === 'string' ? { academicYear: item.academicYear } : {}),
      ...(typeof item.term === 'string' ? { term: item.term } : {}),
      ...(typeof item.semesterId === 'string' ? { semesterId: item.semesterId } : {}),
      throughSemester: item.throughSemester,
      gpa: typeof item.gpa === 'number' && Number.isFinite(item.gpa) ? item.gpa : null,
      creditDenominator: typeof item.creditDenominator === 'number' && Number.isFinite(item.creditDenominator) ? item.creditDenominator : 0,
      eligibleAttempts: typeof item.eligibleAttempts === 'number' ? item.eligibleAttempts : 0,
      countedAttempts: typeof item.countedAttempts === 'number' ? item.countedAttempts : 0,
      excludedAttempts: typeof item.excludedAttempts === 'number' ? item.excludedAttempts : 0,
      complete: item.complete === true,
      note: typeof item.note === 'string' ? item.note : '',
    };
  };
  const gpaSemesters = Array.isArray(value.gpaSemesters) ? value.gpaSemesters.flatMap((item) => { const parsed = parseGpa(item); return parsed ? [parsed] : []; }).slice(0, 100) : [];
  const gpaCumulative = parseGpa(value.gpaCumulative);
  const holidays = parseList<CampusHoliday>(value.holidays, ['id', 'title', 'startDate', 'endDate', 'kind', 'note', 'source']);
  const rawSourceStatus = isRecord(value.sourceStatus) ? value.sourceStatus : {};
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
    courseOfferings,
    learningCourses,
    activities,
    exams,
    grades,
    gradeAlerts,
    gpaSemesters,
    gpaCumulative,
    todos: parseList<CampusTodo>(value.todos, ['id', 'name', 'course', 'deadline', 'status']),
    practiceSummary,
    practiceProjects,
    gpa,
    totalCredit,
    completedCredit: typeof value.completedCredit === 'number' && Number.isFinite(value.completedCredit) ? value.completedCredit : totalCredit,
    earnedCredit: typeof value.earnedCredit === 'number' && Number.isFinite(value.earnedCredit) ? value.earnedCredit : totalCredit,
    yearLevel: typeof value.yearLevel === 'string' ? normalizeYearLevel(value.yearLevel) : '',
    holidays,
    calendarUrl: parseOfficialCalendarUrl(value.calendarUrl),
    sourceStatus: {
      available: rawSourceStatus.available === true,
      credentialsConfigured: rawSourceStatus.credentialsConfigured === true,
      authStatus: typeof rawSourceStatus.authStatus === 'string' ? rawSourceStatus.authStatus : 'unknown',
      supportedDomains: Array.isArray(rawSourceStatus.supportedDomains) ? rawSourceStatus.supportedDomains.filter((item): item is string => typeof item === 'string').slice(0, 40) : [],
      note: typeof rawSourceStatus.note === 'string' ? rawSourceStatus.note.slice(0, 300) : '',
    },
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 12)
      : [],
    ...(Array.isArray(value.refreshedDomains)
      ? { refreshedDomains: value.refreshedDomains.filter((item): item is NonNullable<MobileCampusData['refreshedDomains']>[number] =>
          item === 'schedule' || item === 'exams' || item === 'grades' || item === 'learningCourses' || item === 'todos' || item === 'practice' || item === 'calendar') }
      : {}),
  };
}

export function mergeBackgroundCampusData(existing: MobileCampusData | null, value: unknown): MobileCampusData | null {
  const incoming = parseCampusData(value);
  const domains = new Set(incoming?.refreshedDomains || []);
  if (!incoming || !domains.size) return existing;
  const incomingAt = Date.parse(incoming.fetchedAt);
  const existingAt = existing ? Date.parse(existing.fetchedAt) : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(existingAt) && Number.isFinite(incomingAt) && incomingAt <= existingAt) return existing;

  const base = existing || incoming;
  const gradesRefreshed = domains.has('grades');
  const merged: MobileCampusData = {
    ...base,
    fetchedAt: incoming.fetchedAt,
    academicYear: incoming.academicYear || base.academicYear,
    term: incoming.term || base.term,
    ...(domains.has('schedule') ? { courses: incoming.courses, courseOfferings: incoming.courseOfferings } : {}),
    ...(domains.has('exams') ? { exams: incoming.exams } : {}),
    ...(gradesRefreshed ? {
      grades: incoming.grades,
      gradeAlerts: incoming.gradeAlerts,
      gpaSemesters: incoming.gpaSemesters,
      gpaCumulative: incoming.gpaCumulative,
      gpa: incoming.gpa,
      totalCredit: incoming.totalCredit,
      completedCredit: incoming.completedCredit,
      earnedCredit: incoming.earnedCredit,
      yearLevel: incoming.yearLevel,
    } : {}),
    ...(domains.has('learningCourses') ? { learningCourses: incoming.learningCourses, activities: incoming.activities } : {}),
    ...(domains.has('todos') ? { todos: incoming.todos } : {}),
    sourceStatus: incoming.sourceStatus,
    warnings: incoming.warnings,
    refreshedDomains: incoming.refreshedDomains,
  };
  return parseCampusData(merged);
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
    const campus = parseCampusData(value.campus);
    return {
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      conversations,
      activeConversationId: activeId,
      memories,
      agenda: parseAgenda(value.agenda),
      reminders: parseReminders(value.reminders),
      campus,
      // Existing installs with campus data have already completed a manual
      // read, so preserve auto-refresh when they upgrade to this version.
      campusAutoReadEnabled: typeof value.campusAutoReadEnabled === 'boolean' ? value.campusAutoReadEnabled : campus !== null,
      profile: parseProfile(value.profile),
    };
  } catch {
    return fallback;
  }
}

export function saveMobileState(state: MobileState): void {
  try {
    persistMobileState(state);
    if (Capacitor.isNativePlatform() && nativeSecureStorageReady) {
      void persistMobileSecrets(state).catch(() => { nativeSecureStorageReady = false; });
    }
  } catch {
    // Storage is best effort. The app remains usable for the current session.
  }
}

export async function persistMobileSecrets(state: MobileState): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Promise.all([
    secureSet(SECURE_API_KEY, state.apiKey),
    secureSet(SECURE_STUDENT_ID, state.profile.studentId),
    secureSet(SECURE_STUDENT_PASSWORD, state.profile.studentPassword),
  ]);
  nativeSecureStorageReady = true;
}

export async function persistCampusCredentials(state: MobileState): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Promise.all([
    secureSet(SECURE_STUDENT_ID, state.profile.studentId),
    secureSet(SECURE_STUDENT_PASSWORD, state.profile.studentPassword),
  ]);
}

export async function persistApiKey(apiKey: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await secureSet(SECURE_API_KEY, apiKey);
}

function persistMobileState(state: MobileState): void {
  const native = Capacitor.isNativePlatform();
  const persisted: MobileState = {
    ...state,
    apiKey: native ? '' : state.apiKey,
    profile: native ? { ...state.profile, studentId: '', studentPassword: '' } : state.profile,
    conversations: state.conversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.filter((message) => !message.ephemeral),
    })),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

export interface MobileSecretsHydrationResult {
  state: MobileState;
  status: 'available' | 'unavailable';
}

export async function hydrateMobileSecrets(state: MobileState): Promise<MobileSecretsHydrationResult> {
  if (!Capacitor.isNativePlatform()) return { state, status: 'available' };
  try {
    const [secureApiKey, secureStudentId, securePassword, legacyApiKey, legacyPassword] = await Promise.all([
      secureGet(SECURE_API_KEY),
      secureGet(SECURE_STUDENT_ID),
      secureGet(SECURE_STUDENT_PASSWORD),
      Preferences.get({ key: SECURE_API_KEY }),
      Preferences.get({ key: SECURE_STUDENT_PASSWORD }),
    ]);
    const nextApiKey = secureApiKey || legacyApiKey.value || state.apiKey;
    const nextStudentId = secureStudentId || state.profile.studentId;
    const nextPassword = securePassword || legacyPassword.value || state.profile.studentPassword;
    await Promise.all([
      secureSet(SECURE_API_KEY, nextApiKey),
      secureSet(SECURE_STUDENT_ID, nextStudentId),
      secureSet(SECURE_STUDENT_PASSWORD, nextPassword),
    ]);
    const [verifiedApiKey, verifiedStudentId, verifiedPassword] = await Promise.all([
      secureGet(SECURE_API_KEY),
      secureGet(SECURE_STUDENT_ID),
      secureGet(SECURE_STUDENT_PASSWORD),
    ]);
    if (verifiedApiKey !== (nextApiKey || null) || verifiedStudentId !== (nextStudentId || null) || verifiedPassword !== (nextPassword || null)) {
      throw new Error('secure_storage_migration_verification_failed');
    }
    const nextState = {
      ...state,
      apiKey: nextApiKey,
      profile: { ...state.profile, studentId: nextStudentId, studentPassword: nextPassword },
    };
    persistMobileState(nextState);
    nativeSecureStorageReady = true;
    await Promise.allSettled([
      Preferences.remove({ key: SECURE_API_KEY }),
      Preferences.remove({ key: SECURE_STUDENT_PASSWORD }),
    ]);
    try {
      localStorage.removeItem('zaichang.mobile.local.v1');
    } catch {
      // The verified Keystore copy is already available if legacy cleanup fails.
    }
    return { state: nextState, status: 'available' };
  } catch {
    // Do not fall back to plaintext if Android Keystore cannot be used.
    nativeSecureStorageReady = false;
    const sanitized = { ...state, apiKey: '', profile: { ...state.profile, studentId: '', studentPassword: '' } };
    // Keep legacy copies intact until a verified Keystore migration succeeds.
    // The app still receives a sanitized state and never reads those copies as a
    // plaintext fallback during this session.
    return { state: sanitized, status: 'unavailable' };
  }
}

export function clearMobileState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('zaichang.mobile.local.v1');
    if (Capacitor.isNativePlatform()) {
      nativeSecureStorageReady = true;
      void disableCampusBackgroundSync().catch(() => {});
      void Promise.all([
        Preferences.remove({ key: SECURE_API_KEY }),
        Preferences.remove({ key: SECURE_STUDENT_PASSWORD }),
        secureRemove(SECURE_API_KEY),
        secureRemove(SECURE_STUDENT_ID),
        secureRemove(SECURE_STUDENT_PASSWORD),
      ]).catch(() => {});
    }
  } catch {
    // Best effort only.
  }
}
