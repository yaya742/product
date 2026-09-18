export type MobileMessageRole = 'user' | 'assistant';

export interface MobileMessage {
  id: string;
  role: MobileMessageRole;
  content: string;
  createdAt: string;
  status: 'running' | 'done' | 'error';
}

export interface MobileState {
  apiKey: string;
  messages: MobileMessage[];
  memories: string[];
}

export const EMPTY_MOBILE_STATE: MobileState = {
  apiKey: '',
  messages: [],
  memories: [],
};

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
