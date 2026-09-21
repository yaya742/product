export type MobileMessageRole = 'user' | 'assistant';
export type MobileLanguage = 'zh-CN' | 'zh-TW' | 'en';
export type MobileTheme = 'light' | 'dark';
export type MobileMemoryMode = 'relevant' | 'current_sources_only' | 'none';
export type MobileRetention = 'purpose_scoped' | 'history_no_inference' | 'session_only';
export type MobileAudience = 'self' | 'group' | 'public';

export interface MobileTurnControls {
  memoryMode: MobileMemoryMode;
  retention: MobileRetention;
  audience: MobileAudience;
}

export type MobileAttachment =
  | {
      kind: 'image';
      name: string;
      mimeType: 'image/jpeg';
      dataUrl: string;
      width: number;
      height: number;
    }
  | {
      kind: 'text';
      name: string;
      text: string;
    };

export interface MobileReminder {
  id: string;
  title: string;
  notes: string;
  dueAt: string;
  createdAt: string;
  completed: boolean;
  notificationId: number;
}

export type MobileAgendaStatus = 'saved' | 'done' | 'cancelled';

export interface MobileAgendaItem {
  id: string;
  title: string;
  detail: string;
  startsAt?: string;
  durationMinutes?: number;
  createdAt: string;
  status: MobileAgendaStatus;
  source: 'assistant' | 'user';
}

export interface CampusCourse {
  id: string;
  name: string;
  teacher: string;
  location: string;
  time: string;
  weeks: string;
}

export interface CampusExam {
  id: string;
  name: string;
  time: string;
  location: string;
  seat: string;
  type: string;
  status: 'upcoming' | 'finished' | 'unknown';
}

export interface CampusGrade {
  id: string;
  name: string;
  score: string;
  credit: string;
  point: string;
}

export interface CampusTodo {
  id: string;
  name: string;
  course: string;
  deadline: string;
  status: string;
}

export interface CampusPracticeSummary {
  secondClassPoints: number | null;
  thirdClassPoints: number | null;
  fourthClassPoints: number | null;
  aestheticEducationPassed: boolean | null;
  laborEducationPassed: boolean | null;
  source: string;
}

export interface CampusPracticeProject {
  id: string;
  name: string;
  category: string;
  projectType: string;
  qualityType: string;
  score: number | null;
  status: string;
  approved: boolean;
  role: string;
  remark: string;
  activityTime: string;
}

export interface CampusNotice {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  summary: string;
  url: string;
  pinned: boolean;
}

export interface MobileCampusData {
  fetchedAt: string;
  academicYear: string;
  term: string;
  courses: CampusCourse[];
  exams: CampusExam[];
  grades: CampusGrade[];
  todos: CampusTodo[];
  practiceSummary: CampusPracticeSummary | null;
  practiceProjects: CampusPracticeProject[];
  gpa: number | null;
  totalCredit: number;
  warnings: string[];
}

export interface MobileMessage {
  id: string;
  role: MobileMessageRole;
  content: string;
  attachment?: MobileAttachment;
  translations?: Partial<Record<MobileLanguage, string>>;
  ephemeral?: boolean;
  createdAt: string;
  status: 'running' | 'done' | 'error';
}

export interface MobileConversation {
  id: string;
  title: string;
  messages: MobileMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface MobileProfile {
  avatar: string;
  language: MobileLanguage;
  theme: MobileTheme;
  studentId: string;
  studentPassword: string;
}

export interface MobileState {
  apiKey: string;
  conversations: MobileConversation[];
  activeConversationId: string;
  memories: string[];
  agenda: MobileAgendaItem[];
  reminders: MobileReminder[];
  campus: MobileCampusData | null;
  profile: MobileProfile;
}

export const DEFAULT_PROFILE: MobileProfile = {
  avatar: '在',
  language: 'zh-CN',
  theme: 'light',
  studentId: '',
  studentPassword: '',
};

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createConversation(title = '新对话'): MobileConversation {
  const now = new Date().toISOString();
  return { id: newId('conversation'), title, messages: [], createdAt: now, updatedAt: now };
}

export function createInitialState(): MobileState {
  const conversation = createConversation();
  return {
    apiKey: '',
    conversations: [conversation],
    activeConversationId: conversation.id,
    memories: [],
    agenda: [],
    reminders: [],
    campus: null,
    profile: { ...DEFAULT_PROFILE },
  };
}

export const EMPTY_MOBILE_STATE: MobileState = createInitialState();
