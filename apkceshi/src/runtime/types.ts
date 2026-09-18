export type MobileMessageRole = 'user' | 'assistant';
export type MobileLanguage = 'zh-CN' | 'zh-TW' | 'en';
export type MobileTheme = 'light' | 'dark';

export interface MobileMessage {
  id: string;
  role: MobileMessageRole;
  content: string;
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
    profile: { ...DEFAULT_PROFILE },
  };
}

export const EMPTY_MOBILE_STATE: MobileState = createInitialState();
