export type MobileMessageRole = 'user' | 'assistant';
export type MobileLanguage = 'zh-CN' | 'zh-TW' | 'en';
export type MobileTheme = 'light' | 'dark';

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

export interface MobileCampusData {
  fetchedAt: string;
  academicYear: string;
  term: string;
  courses: CampusCourse[];
  exams: CampusExam[];
  grades: CampusGrade[];
  todos: CampusTodo[];
}

export interface MobileMessage {
  id: string;
  role: MobileMessageRole;
  content: string;
  attachment?: MobileAttachment;
  translations?: Partial<Record<MobileLanguage, string>>;
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
    reminders: [],
    campus: null,
    profile: { ...DEFAULT_PROFILE },
  };
}

export const EMPTY_MOBILE_STATE: MobileState = createInitialState();
